import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseCode } from "../chat/config.js";
import { ChatCloseError } from "../chat/errors.js";
import { createInstanceVerifier } from "../chat/instances.js";
import {
  APP_ID,
  BOT_TOKEN,
  captureLogger,
  createFakeFetch,
  defaultDiscord,
  hangingFetch,
  INSTANCE_1,
  INSTANCE_2,
  json,
  USER_A,
  USER_B,
} from "./helpers/fake-discord.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function verifier(fetchImpl, options = {}) {
  return createInstanceVerifier({ applicationId: APP_ID, botToken: BOT_TOKEN, fetchImpl, logger: captureLogger().logger, ...options });
}

async function rejectsWith(promise, closeCode, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ChatCloseError, `esperado ChatCloseError, recebido ${error}`);
    assert.deepEqual([error.closeCode, error.reason], [closeCode, reason]);
    return true;
  });
}

test("exige applicationId e botToken", () => {
  assert.throws(() => createInstanceVerifier({ applicationId: APP_ID, botToken: null }));
  assert.throws(() => createInstanceVerifier({ applicationId: null, botToken: BOT_TOKEN }));
});

test("membro da instância é aceito; chamada usa o endpoint oficial com token de bot", async () => {
  const { fetchImpl, calls } = defaultDiscord();
  await verifier(fetchImpl).assertMember(INSTANCE_1, USER_A.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://discord.com/api/v10/applications/${APP_ID}/activity-instances/${INSTANCE_1}`);
  assert.equal(calls[0].authorization, `Bot ${BOT_TOKEN}`);
});

test("usuário que não pertence à instância → 4003 not_in_instance", async () => {
  const { fetchImpl } = defaultDiscord();
  await rejectsWith(verifier(fetchImpl).assertMember(INSTANCE_2, USER_A.id), CloseCode.FORBIDDEN, "not_in_instance");
});

test("instância inexistente (404) → 4003 instance_not_found", async () => {
  const { fetchImpl } = defaultDiscord();
  await rejectsWith(verifier(fetchImpl).assertMember("i-999-gc-1-2", USER_A.id), CloseCode.FORBIDDEN, "instance_not_found");
});

test("id que o Discord não reconhece (400) → 4003 instance_not_found, sem log", async () => {
  const { fetchImpl } = createFakeFetch(() => json(400, { message: "Invalid Form Body", code: 50035 }));
  const { lines, logger } = captureLogger();
  await rejectsWith(verifier(fetchImpl, { logger }).assertMember("i-1", USER_A.id), CloseCode.FORBIDDEN, "instance_not_found");
  assert.equal(lines.length, 0);
});

test("isolamento: cada instância tem seus próprios membros", async () => {
  const { fetchImpl } = defaultDiscord();
  const v = verifier(fetchImpl);
  await v.assertMember(INSTANCE_1, USER_B.id);
  await v.assertMember(INSTANCE_2, USER_B.id);
  await rejectsWith(v.assertMember(INSTANCE_2, USER_A.id), CloseCode.FORBIDDEN, "not_in_instance");
});

for (const bad of ["../users/@me", "i-1/../../x", "i 1", "i-1?x=1", "i-1#x", "", "%2e%2e", "i-1\n"]) {
  test(`instanceId com caracteres inválidos (${JSON.stringify(bad)}) → 4000 invalid_instance sem chamar o Discord`, async () => {
    const { fetchImpl, calls } = defaultDiscord();
    await rejectsWith(verifier(fetchImpl).getSnapshot(bad), CloseCode.BAD_REQUEST, "invalid_instance");
    assert.equal(calls.length, 0);
  });
}

test("resposta com instance_id diferente do solicitado é rejeitada", async () => {
  const { fetchImpl } = createFakeFetch(() => json(200, { instance_id: INSTANCE_2, users: [USER_A.id] }));
  await rejectsWith(verifier(fetchImpl).assertMember(INSTANCE_1, USER_A.id), CloseCode.TRY_AGAIN_LATER, "discord_unavailable");
});

test("token de bot recusado (401/403) → 1011 server_misconfigured, log sem o token", async () => {
  for (const status of [401, 403]) {
    const { fetchImpl } = createFakeFetch(() => json(status, { message: "Unauthorized" }));
    const { lines, logger } = captureLogger();
    await rejectsWith(verifier(fetchImpl, { logger }).assertMember(INSTANCE_1, USER_A.id), CloseCode.INTERNAL_ERROR, "server_misconfigured");
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(BOT_TOKEN), "o token de bot não pode aparecer no log");
    assert.match(lines[0], new RegExp(`HTTP ${status}`));
  }
});

for (const [name, handler] of [
  ["429", () => json(429, { retry_after: 1 })],
  ["502", () => json(502, {})],
  ["corpo inválido", () => new Response("x", { status: 200 })],
  ["users não é lista", () => json(200, { instance_id: INSTANCE_1, users: "x" })],
  ["falha de rede", () => Promise.reject(new TypeError("fetch failed"))],
]) {
  test(`Discord indisponível (${name}) → 1013 discord_unavailable`, async () => {
    const { fetchImpl } = createFakeFetch(handler);
    await rejectsWith(verifier(fetchImpl).assertMember(INSTANCE_1, USER_A.id), CloseCode.TRY_AGAIN_LATER, "discord_unavailable");
  });
}

test("tempo limite → 1013 discord_unavailable", async () => {
  const { fetchImpl } = hangingFetch();
  await rejectsWith(verifier(fetchImpl, { timeoutMs: 30 }).assertMember(INSTANCE_1, USER_A.id), CloseCode.TRY_AGAIN_LATER, "discord_unavailable");
});

test("cache: membros reutilizados dentro do TTL e reconsultados depois", async () => {
  const { fetchImpl, calls } = defaultDiscord();
  const time = clock();
  const v = verifier(fetchImpl, { now: time.now, ttlMs: 1_000 });
  await v.assertMember(INSTANCE_1, USER_A.id);
  await v.assertMember(INSTANCE_1, USER_B.id);
  assert.equal(calls.length, 1, "dentro do TTL");
  time.advance(1_001);
  await v.assertMember(INSTANCE_1, USER_A.id);
  assert.equal(calls.length, 2, "após o TTL");
});

test("usuário que acabou de entrar: cache sem ele força uma consulta nova antes de recusar", async () => {
  const instanceUsers = { [INSTANCE_1]: [USER_A.id] };
  const { fetchImpl, calls } = defaultDiscord({ instanceUsers });
  const v = verifier(fetchImpl);
  await v.assertMember(INSTANCE_1, USER_A.id);
  instanceUsers[INSTANCE_1] = [USER_A.id, USER_B.id]; // B entra na Activity
  await v.assertMember(INSTANCE_1, USER_B.id);
  assert.equal(calls.length, 2);
});

test("usuário que saiu: a consulta nova confirma a ausência e recusa", async () => {
  const instanceUsers = { [INSTANCE_1]: [USER_A.id, USER_B.id] };
  const { fetchImpl, calls } = defaultDiscord({ instanceUsers });
  const time = clock();
  const v = verifier(fetchImpl, { now: time.now, ttlMs: 1_000 });
  await v.assertMember(INSTANCE_1, USER_B.id);
  instanceUsers[INSTANCE_1] = [USER_A.id]; // B sai
  time.advance(1_001);
  await rejectsWith(v.assertMember(INSTANCE_1, USER_B.id), CloseCode.FORBIDDEN, "not_in_instance");
  assert.equal(calls.length, 2, "uma consulta após o TTL, sem repetir");
});

test("consultas simultâneas da mesma instância compartilham uma chamada", async () => {
  const { fetchImpl, calls } = defaultDiscord();
  const v = verifier(fetchImpl);
  await Promise.all([v.assertMember(INSTANCE_1, USER_A.id), v.assertMember(INSTANCE_1, USER_B.id), v.getSnapshot(INSTANCE_1)]);
  assert.equal(calls.length, 1);
});

test("cache respeita o limite de instâncias", async () => {
  const { fetchImpl } = createFakeFetch(({ path }) => json(200, { instance_id: decodeURIComponent(path.split("/").pop()), users: [] }));
  const v = verifier(fetchImpl, { maxEntries: 2 });
  for (const id of ["i-1", "i-2", "i-3"]) await v.getSnapshot(id);
  assert.equal(v.size(), 2);
});

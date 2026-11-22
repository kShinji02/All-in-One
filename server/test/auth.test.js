import { test } from "node:test";
import assert from "node:assert/strict";
import { createTokenValidator, tokenCacheKey } from "../chat/auth.js";
import { CloseCode } from "../chat/config.js";
import { ChatCloseError } from "../chat/errors.js";
import { captureLogger, createFakeFetch, defaultDiscord, hangingFetch, json, TOKEN_A, TOKEN_B, USER_A } from "./helpers/fake-discord.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

async function rejectsWith(promise, closeCode, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ChatCloseError, `esperado ChatCloseError, recebido ${error}`);
    assert.equal(error.closeCode, closeCode);
    assert.equal(error.reason, reason);
    return true;
  });
}

test("token válido: identidade vem do Discord, com Bearer no cabeçalho", async () => {
  const { fetchImpl, calls } = defaultDiscord();
  const tokens = createTokenValidator({ fetchImpl });
  const user = await tokens.validate(TOKEN_A);
  assert.deepEqual(user, {
    id: USER_A.id,
    username: "ana",
    displayName: "Ana",
    avatarUrl: `https://cdn.discordapp.com/avatars/${USER_A.id}/a1b2c3.png?size=128`,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.com/api/v10/users/@me");
  assert.equal(calls[0].authorization, `Bearer ${TOKEN_A}`);
});

test("sem global_name e sem avatar: usa username e avatar padrão do CDN", async () => {
  const { fetchImpl } = defaultDiscord();
  const user = await createTokenValidator({ fetchImpl }).validate(TOKEN_B);
  assert.equal(user.displayName, "bruno");
  // (175928847299117063 >> 22) % 6
  const index = Number((BigInt("175928847299117063") >> 22n) % 6n);
  assert.equal(user.avatarUrl, `https://cdn.discordapp.com/embed/avatars/${index}.png`);
});

test("cache: reutiliza dentro do TTL e consulta de novo depois", async () => {
  const { fetchImpl, calls } = defaultDiscord();
  const time = clock();
  const tokens = createTokenValidator({ fetchImpl, now: time.now, ttlMs: 1_000 });
  await tokens.validate(TOKEN_A);
  time.advance(999);
  await tokens.validate(TOKEN_A);
  assert.equal(calls.length, 1, "dentro do TTL");
  time.advance(2);
  await tokens.validate(TOKEN_A);
  assert.equal(calls.length, 2, "após o TTL");
});

test("cache guarda só o SHA-256 do token, nunca o token", async () => {
  const { fetchImpl } = defaultDiscord();
  const tokens = createTokenValidator({ fetchImpl });
  await tokens.validate(TOKEN_A);
  assert.deepEqual(tokens.keys(), [tokenCacheKey(TOKEN_A)]);
  assert.match(tokens.keys()[0], /^[0-9a-f]{64}$/);
  assert.ok(!tokens.keys()[0].includes(TOKEN_A));
});

test("cache respeita o limite de entradas (remove a mais antiga)", async () => {
  const { fetchImpl } = createFakeFetch(({ authorization }) =>
    json(200, { id: String(authorization.length + 1000), username: "u", discriminator: "0" }),
  );
  const tokens = createTokenValidator({ fetchImpl, maxEntries: 2 });
  await tokens.validate("t1");
  await tokens.validate("t22");
  await tokens.validate("t333");
  assert.equal(tokens.size(), 2);
  assert.ok(!tokens.keys().includes(tokenCacheKey("t1")));
});

test("validações simultâneas do mesmo token fazem uma única chamada", async () => {
  const { fetchImpl, calls } = defaultDiscord();
  const tokens = createTokenValidator({ fetchImpl });
  const results = await Promise.all([tokens.validate(TOKEN_A), tokens.validate(TOKEN_A), tokens.validate(TOKEN_A)]);
  assert.equal(calls.length, 1);
  assert.ok(results.every((u) => u.id === USER_A.id));
});

// Fase 5.1: o 401 passa a entrar num cache negativo curto (antes: sem cache negativo).
test("token inválido ou expirado (401) → 4001 invalid_token; repetir o mesmo token não chama o Discord de novo", async () => {
  const { fetchImpl, calls } = defaultDiscord();
  const tokens = createTokenValidator({ fetchImpl });
  await rejectsWith(tokens.validate("expirado"), CloseCode.UNAUTHORIZED, "invalid_token");
  await rejectsWith(tokens.validate("expirado"), CloseCode.UNAUTHORIZED, "invalid_token");
  assert.equal(calls.length, 1);
  assert.equal(tokens.size(), 0, "nada entra no cache positivo");
  assert.deepEqual(tokens.invalidKeys(), [tokenCacheKey("expirado")], "o cache negativo guarda só o hash");
});

test("403 também é tratado como token inválido", async () => {
  const { fetchImpl } = createFakeFetch(() => json(403, { message: "Missing Access" }));
  await rejectsWith(createTokenValidator({ fetchImpl }).validate(TOKEN_A), CloseCode.UNAUTHORIZED, "invalid_token");
});

for (const [name, handler] of [
  ["429 (rate limit)", () => json(429, { retry_after: 1 })],
  ["500", () => json(500, {})],
  ["503", () => new Response("indisponível", { status: 503 })],
  ["200 com corpo inválido", () => new Response("<html>", { status: 200 })],
  ["200 sem id", () => json(200, { username: "x" })],
  ["200 com id não numérico", () => json(200, { id: "abc", username: "x" })],
  ["falha de rede", () => Promise.reject(new TypeError("fetch failed"))],
]) {
  test(`Discord indisponível (${name}) → 1013 discord_unavailable, sem vazar o token no log`, async () => {
    const { fetchImpl } = createFakeFetch(handler);
    const { lines, logger } = captureLogger();
    await rejectsWith(createTokenValidator({ fetchImpl, logger }).validate(TOKEN_A), CloseCode.TRY_AGAIN_LATER, "discord_unavailable");
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(TOKEN_A));
  });
}

test("tempo limite da chamada → 1013 discord_unavailable", async () => {
  const { fetchImpl } = hangingFetch();
  const { lines, logger } = captureLogger();
  await rejectsWith(createTokenValidator({ fetchImpl, timeoutMs: 30, logger }).validate(TOKEN_A), CloseCode.TRY_AGAIN_LATER, "discord_unavailable");
  assert.match(lines[0], /timeout/);
});

test("após falha transitória, nova tentativa volta a consultar o Discord", async () => {
  let fail = true;
  const { fetchImpl, calls } = createFakeFetch(() => (fail ? json(500, {}) : json(200, USER_A)));
  const tokens = createTokenValidator({ fetchImpl, logger: captureLogger().logger });
  await assert.rejects(tokens.validate(TOKEN_A));
  fail = false;
  assert.equal((await tokens.validate(TOKEN_A)).id, USER_A.id);
  assert.equal(calls.length, 2);
});

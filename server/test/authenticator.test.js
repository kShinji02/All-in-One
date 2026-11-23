import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { attachChat } from "../chat/index.js";
import { createDiscordAuthenticator } from "../chat/authenticator.js";
import { CloseCode } from "../chat/config.js";
import { APP_ID, authorizationInfo, BOT_TOKEN, captureLogger, createFakeFetch, defaultDiscord, INSTANCE_1, INSTANCE_2, json, OAUTH_ME_PATH, TOKEN_A, TOKEN_B, USER_A, USER_B } from "./helpers/fake-discord.js";

const servers = [];

async function startServer(fetchImpl, logger = captureLogger().logger) {
  const authenticate = createDiscordAuthenticator({ applicationId: APP_ID, botToken: BOT_TOKEN, fetchImpl, logger });
  const server = http.createServer();
  const chat = attachChat(server, { authenticate, authTimeoutMs: 2_000, logger });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push({ server, chat });
  return { url: `ws://127.0.0.1:${server.address().port}/api/chat`, authenticate };
}

afterEach(async () => {
  for (const { server, chat } of servers.splice(0)) {
    chat.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Conecta, envia o auth e resolve com a primeira mensagem ou o fechamento. */
function authenticateOver(url, auth) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin: "http://localhost:5173" });
    ws.once("open", () => ws.send(JSON.stringify({ type: "auth", ...auth })));
    ws.once("message", (data) => {
      resolve({ message: JSON.parse(data.toString()) });
      ws.close();
    });
    ws.once("close", (code, reason) => resolve({ close: { code, reason: reason.toString() } }));
  });
}

test("usuário válido na instância recebe ready com a identidade do Discord", async () => {
  const { fetchImpl } = defaultDiscord();
  const { url } = await startServer(fetchImpl);
  const result = await authenticateOver(url, { accessToken: TOKEN_A, instanceId: INSTANCE_1 });
  assert.deepEqual(result.message, {
    type: "ready",
    self: { id: USER_A.id, username: "ana", displayName: "Ana", avatarUrl: `https://cdn.discordapp.com/avatars/${USER_A.id}/a1b2c3.png?size=128` },
  });
});

test("identidade enviada pelo cliente é ignorada", async () => {
  const { fetchImpl } = defaultDiscord();
  const { url } = await startServer(fetchImpl);
  const result = await authenticateOver(url, {
    accessToken: TOKEN_B,
    instanceId: INSTANCE_1,
    id: USER_A.id,
    username: "admin",
    displayName: "Administrador",
    avatarUrl: "https://evil.com/a.png",
  });
  assert.equal(result.message.self.id, USER_B.id);
  assert.equal(result.message.self.displayName, "bruno");
  assert.match(result.message.self.avatarUrl, /^https:\/\/cdn\.discordapp\.com\//);
});

test("token inválido → 4001 invalid_token", async () => {
  const { fetchImpl } = defaultDiscord();
  const { url } = await startServer(fetchImpl);
  assert.deepEqual((await authenticateOver(url, { accessToken: "token-expirado", instanceId: INSTANCE_1 })).close, {
    code: CloseCode.UNAUTHORIZED,
    reason: "invalid_token",
  });
});

test("usuário de outra instância → 4003 not_in_instance", async () => {
  const { fetchImpl } = defaultDiscord();
  const { url } = await startServer(fetchImpl);
  assert.deepEqual((await authenticateOver(url, { accessToken: TOKEN_A, instanceId: INSTANCE_2 })).close, {
    code: CloseCode.FORBIDDEN,
    reason: "not_in_instance",
  });
});

test("instância inexistente → 4003 instance_not_found", async () => {
  const { fetchImpl } = defaultDiscord();
  const { url } = await startServer(fetchImpl);
  assert.deepEqual((await authenticateOver(url, { accessToken: TOKEN_A, instanceId: "i-1-gc-2-3" })).close, {
    code: CloseCode.FORBIDDEN,
    reason: "instance_not_found",
  });
});

test("instanceId malformado → 4000 invalid_instance sem nenhuma chamada ao Discord", async () => {
  const { fetchImpl, calls } = defaultDiscord();
  const { url } = await startServer(fetchImpl);
  assert.deepEqual((await authenticateOver(url, { accessToken: TOKEN_A, instanceId: "../../users/@me" })).close, {
    code: CloseCode.BAD_REQUEST,
    reason: "invalid_instance",
  });
  assert.equal(calls.length, 0);
});

test("token inválido tem prioridade: não revela se a instância existe, mesmo que ela responda antes", async () => {
  // A consulta da instância (404) termina antes do /oauth2/@me (401).
  const { fetchImpl } = createFakeFetch(async ({ path }) => {
    if (path === OAUTH_ME_PATH) {
      await delay(80);
      return json(401, { message: "401: Unauthorized" });
    }
    return json(404, { message: "Unknown Activity Instance" });
  });
  const { url } = await startServer(fetchImpl);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual((await authenticateOver(url, { accessToken: "token-invalido", instanceId: "i-1-gc-2-3" })).close, {
      code: CloseCode.UNAUTHORIZED,
      reason: "invalid_token",
    });
  }
});

test("token válido com instância inexistente → 4003 instance_not_found", async () => {
  const { fetchImpl } = createFakeFetch(async ({ path }) =>
    path === OAUTH_ME_PATH ? json(200, authorizationInfo(USER_A)) : json(404, { message: "Unknown Activity Instance" }),
  );
  const { url } = await startServer(fetchImpl);
  assert.deepEqual((await authenticateOver(url, { accessToken: TOKEN_A, instanceId: "i-1-gc-2-3" })).close, {
    code: CloseCode.FORBIDDEN,
    reason: "instance_not_found",
  });
});

test("as duas validações rodam em paralelo (uma chamada de cada)", async () => {
  const { fetchImpl, calls } = defaultDiscord();
  const { url } = await startServer(fetchImpl);
  await authenticateOver(url, { accessToken: TOKEN_A, instanceId: INSTANCE_1 });
  assert.deepEqual(calls.map((c) => c.authorization.split(" ")[0]).sort(), ["Bearer", "Bot"]);
});

test("reconexão do mesmo usuário usa os caches (sem novas chamadas)", async () => {
  const { fetchImpl, calls } = defaultDiscord();
  const { url } = await startServer(fetchImpl);
  await authenticateOver(url, { accessToken: TOKEN_A, instanceId: INSTANCE_1 });
  await authenticateOver(url, { accessToken: TOKEN_A, instanceId: INSTANCE_1 });
  assert.equal(calls.length, 2);
});

test("nenhum token aparece nos logs em nenhum dos cenários de falha", async () => {
  const { fetchImpl } = defaultDiscord();
  const { lines, logger } = captureLogger();
  const { url } = await startServer(fetchImpl, logger);
  await authenticateOver(url, { accessToken: "token-expirado", instanceId: INSTANCE_1 });
  await authenticateOver(url, { accessToken: TOKEN_A, instanceId: INSTANCE_2 });
  await authenticateOver(url, { accessToken: TOKEN_A, instanceId: "i-1-gc-2-3" });
  const all = lines.join("\n");
  for (const secret of [BOT_TOKEN, TOKEN_A, "token-expirado"]) assert.ok(!all.includes(secret), secret);
});

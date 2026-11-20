import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { attachChat } from "../chat/index.js";
import { CloseCode } from "../chat/config.js";
import { ChatCloseError } from "../chat/errors.js";

const ORIGIN = "http://localhost:5173";
const FAKE_TOKEN = "fake-access-token-not-real";
const servers = [];

/** Sobe um servidor HTTP efêmero com o chat acoplado e tempos curtos para os testes. */
async function startServer(options = {}) {
  const server = http.createServer((req, res) => res.end("ok"));
  const chat = attachChat(server, { authTimeoutMs: 150, heartbeatIntervalMs: 60_000, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push({ server, chat });
  const { port } = server.address();
  return { url: `ws://127.0.0.1:${port}`, server, chat };
}

afterEach(async () => {
  for (const { server, chat } of servers.splice(0)) {
    chat.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Abre uma conexão e resolve com o resultado do handshake. */
function connect(url, { origin = ORIGIN, ...options } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin, ...options });
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    ws.once("open", () => resolve({ ws, messages, status: 101 }));
    ws.once("unexpected-response", (_req, res) => resolve({ ws: null, messages, status: res.statusCode }));
    ws.once("error", () => undefined);
  });
}

function waitClose(ws) {
  return new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

const validAuth = { type: "auth", accessToken: FAKE_TOKEN, instanceId: "i-123-gc-456-789" };
const fakeUser = { id: "1", username: "ana", displayName: "Ana", avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png" };

// --- Upgrade -----------------------------------------------------------------

test("recusa upgrade fora de /api/chat (404)", async () => {
  const { url } = await startServer();
  const result = await connect(`${url}/api/outra`);
  assert.equal(result.status, 404);
});

test("recusa upgrade de origem não permitida (403)", async () => {
  const { url } = await startServer();
  assert.equal((await connect(`${url}/api/chat`, { origin: "https://evil.com" })).status, 403);
});

test("aceita upgrade em /api/chat de origem permitida, inclusive com query string", async () => {
  const { url } = await startServer();
  const { ws, status } = await connect(`${url}/api/chat?x=1`);
  assert.equal(status, 101);
  ws.close();
});

test("rotas HTTP comuns continuam funcionando no mesmo servidor", async () => {
  const { url } = await startServer();
  const response = await fetch(url.replace("ws://", "http://") + "/qualquer");
  assert.equal(await response.text(), "ok");
});

// --- Autenticação: ciclo de vida -------------------------------------------

test("encerra com 4008 quando não há autenticação dentro do prazo", async () => {
  const { url } = await startServer();
  const { ws } = await connect(`${url}/api/chat`);
  assert.deepEqual(await waitClose(ws), { code: CloseCode.AUTH_TIMEOUT, reason: "auth_timeout" });
});

test("autenticador padrão da Etapa 1 recusa com 4001 auth_unavailable", async () => {
  const { url } = await startServer();
  const { ws } = await connect(`${url}/api/chat`);
  ws.send(JSON.stringify(validAuth));
  assert.deepEqual(await waitClose(ws), { code: CloseCode.UNAUTHORIZED, reason: "auth_unavailable" });
});

test("autenticação bem-sucedida envia ready só com campos públicos e cancela o prazo", async () => {
  let received;
  const { url } = await startServer({
    authenticate: async (input) => {
      received = input;
      return { user: { ...fakeUser, accessToken: FAKE_TOKEN, email: "x@y" }, instanceId: input.instanceId };
    },
  });
  const { ws, messages } = await connect(`${url}/api/chat`);
  ws.send(JSON.stringify(validAuth));
  await delay(300); // além do prazo de autenticação (150 ms)
  assert.equal(ws.readyState, WebSocket.OPEN, "conexão autenticada não deve expirar");
  assert.deepEqual(received, { accessToken: FAKE_TOKEN, instanceId: validAuth.instanceId });
  // Etapa 3: o histórico da sala chega logo após o ready.
  assert.deepEqual(messages, [{ type: "ready", self: fakeUser }, { type: "history", messages: [] }]);
  assert.ok(!JSON.stringify(messages).includes(FAKE_TOKEN), "o token não volta ao cliente");
  ws.close();
});

test("ChatCloseError do autenticador define o código de fechamento", async () => {
  const { url } = await startServer({
    authenticate: async () => {
      throw new ChatCloseError(CloseCode.FORBIDDEN, "not_in_instance");
    },
  });
  const { ws } = await connect(`${url}/api/chat`);
  ws.send(JSON.stringify(validAuth));
  assert.deepEqual(await waitClose(ws), { code: CloseCode.FORBIDDEN, reason: "not_in_instance" });
});

test("erro inesperado vira 4001 auth_failed e o log não contém o token", async () => {
  const logs = [];
  const { url } = await startServer({
    authenticate: async () => {
      throw new Error("falha de rede");
    },
    logger: { error: (...args) => logs.push(args.join(" ")) },
  });
  const { ws } = await connect(`${url}/api/chat`);
  ws.send(JSON.stringify(validAuth));
  assert.deepEqual(await waitClose(ws), { code: CloseCode.UNAUTHORIZED, reason: "auth_failed" });
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes(FAKE_TOKEN));
});

test("autenticação lenta além do prazo encerra com 4008 e não envia ready", async () => {
  const { url } = await startServer({
    authenticate: async (input) => {
      await delay(400);
      return { user: fakeUser, instanceId: input.instanceId };
    },
  });
  const { ws, messages } = await connect(`${url}/api/chat`);
  ws.send(JSON.stringify(validAuth));
  assert.equal((await waitClose(ws)).code, CloseCode.AUTH_TIMEOUT);
  await delay(450);
  assert.deepEqual(messages, []);
});

test("segundo auth durante a autenticação encerra com 4000 auth_in_progress", async () => {
  const { url } = await startServer({
    authenticate: async (input) => {
      await delay(100);
      return { user: fakeUser, instanceId: input.instanceId };
    },
    authTimeoutMs: 1_000,
  });
  const { ws } = await connect(`${url}/api/chat`);
  ws.send(JSON.stringify(validAuth));
  ws.send(JSON.stringify(validAuth));
  assert.deepEqual(await waitClose(ws), { code: CloseCode.BAD_REQUEST, reason: "auth_in_progress" });
});

// --- Validação de frames ----------------------------------------------------

for (const [name, frame, expected] of [
  ["JSON inválido", "{nao-json", { code: CloseCode.BAD_REQUEST, reason: "invalid_json" }],
  ["sem type", JSON.stringify({ foo: 1 }), { code: CloseCode.BAD_REQUEST, reason: "invalid_message" }],
  ["JSON nulo", "null", { code: CloseCode.BAD_REQUEST, reason: "invalid_message" }],
  ["mensagem antes do auth", JSON.stringify({ type: "send", text: "oi" }), { code: CloseCode.UNAUTHORIZED, reason: "auth_required" }],
  ["auth sem instanceId", JSON.stringify({ type: "auth", accessToken: FAKE_TOKEN }), { code: CloseCode.BAD_REQUEST, reason: "invalid_auth" }],
  ["auth com token vazio", JSON.stringify({ type: "auth", accessToken: "", instanceId: "i-1" }), { code: CloseCode.BAD_REQUEST, reason: "invalid_auth" }],
  ["auth com token não textual", JSON.stringify({ type: "auth", accessToken: 123, instanceId: "i-1" }), { code: CloseCode.BAD_REQUEST, reason: "invalid_auth" }],
  ["auth com token longo demais", JSON.stringify({ type: "auth", accessToken: "a".repeat(513), instanceId: "i-1" }), { code: CloseCode.BAD_REQUEST, reason: "invalid_auth" }],
  ["auth com instanceId longo demais", JSON.stringify({ type: "auth", accessToken: FAKE_TOKEN, instanceId: "i".repeat(201) }), { code: CloseCode.BAD_REQUEST, reason: "invalid_auth" }],
]) {
  test(`recusa frame: ${name}`, async () => {
    const { url } = await startServer();
    const { ws } = await connect(`${url}/api/chat`);
    ws.send(frame);
    assert.deepEqual(await waitClose(ws), expected);
  });
}

test("recusa frame binário com 4000", async () => {
  const { url } = await startServer();
  const { ws } = await connect(`${url}/api/chat`);
  ws.send(Buffer.from([1, 2, 3]));
  assert.deepEqual(await waitClose(ws), { code: CloseCode.BAD_REQUEST, reason: "binary_not_supported" });
});

test("frame acima de 4 KB encerra com 1009", async () => {
  const { url } = await startServer();
  const { ws } = await connect(`${url}/api/chat`);
  ws.send("x".repeat(4 * 1024 + 1));
  assert.equal((await waitClose(ws)).code, 1009);
});

test("após autenticar, tipos de mensagem desconhecidos recebem erro sem derrubar a conexão", async () => {
  const { url } = await startServer({ authenticate: async (input) => ({ user: fakeUser, instanceId: input.instanceId }) });
  const { ws, messages } = await connect(`${url}/api/chat`);
  ws.send(JSON.stringify(validAuth));
  await delay(50);
  ws.send(JSON.stringify({ type: "desconhecido", text: "oi" }));
  await delay(50);
  assert.deepEqual(messages.at(-1), { type: "error", code: "unsupported_message" });
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
});

// --- Heartbeat e encerramento ----------------------------------------------

test("heartbeat encerra conexão que não responde ao ping", async () => {
  const { url } = await startServer({ heartbeatIntervalMs: 40, authTimeoutMs: 5_000 });
  const { ws } = await connect(`${url}/api/chat`, { autoPong: false });
  assert.equal((await waitClose(ws)).code, 1006, "terminate() fecha sem handshake");
});

test("heartbeat mantém conexão que responde ao ping", async () => {
  const { url } = await startServer({ heartbeatIntervalMs: 40, authTimeoutMs: 5_000 });
  const { ws } = await connect(`${url}/api/chat`);
  await delay(250);
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
});

test("close() encerra as conexões abertas e para de aceitar upgrades", async () => {
  const { url, chat } = await startServer({ authTimeoutMs: 5_000 });
  const { ws } = await connect(`${url}/api/chat`);
  const closed = waitClose(ws);
  chat.close();
  assert.equal((await closed).code, 1006);

  // Sem o listener de upgrade, o Node descarta a tentativa: nenhuma conexão é aberta.
  const opened = await new Promise((resolve) => {
    const retry = new WebSocket(`${url}/api/chat`, { origin: ORIGIN });
    retry.once("open", () => resolve(true));
    retry.once("error", () => resolve(false));
    retry.once("unexpected-response", () => resolve(false));
  });
  assert.equal(opened, false);
});

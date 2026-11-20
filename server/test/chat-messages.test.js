import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { attachChat } from "../chat/index.js";
import { CloseCode } from "../chat/config.js";
import { ChatCloseError } from "../chat/errors.js";
import { createRoomRegistry } from "../chat/rooms.js";

/*
 * Testes de ponta a ponta da Etapa 3 com várias conexões reais.
 * O autenticador é simulado (a Etapa 2 tem seus próprios testes): cada token
 * corresponde a um usuário e o instanceId é tratado como já validado.
 */

const USERS = {
  "tok-ana": { id: "1", username: "ana", displayName: "Ana", avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png" },
  "tok-bruno": { id: "2", username: "bruno", displayName: "Bruno", avatarUrl: "https://cdn.discordapp.com/embed/avatars/1.png" },
  "tok-carla": { id: "3", username: "carla", displayName: "Carla", avatarUrl: "https://cdn.discordapp.com/embed/avatars/2.png" },
};
const I1 = "i-111-gc-1-1";
const I2 = "i-222-gc-2-2";

const fakeAuthenticate = async ({ accessToken, instanceId }) => {
  const user = USERS[accessToken];
  if (!user) throw new ChatCloseError(CloseCode.UNAUTHORIZED, "invalid_token");
  return { user, instanceId };
};

const servers = [];

async function startServer(options = {}) {
  const server = http.createServer();
  const chat = attachChat(server, { authenticate: fakeAuthenticate, authTimeoutMs: 2_000, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push({ server, chat });
  return { url: `ws://127.0.0.1:${server.address().port}/api/chat`, chat };
}

afterEach(async () => {
  for (const { server, chat } of servers.splice(0)) {
    chat.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Cliente de teste: conecta, autentica e acumula as mensagens recebidas. */
async function join(url, token, instanceId) {
  const ws = new WebSocket(url, { origin: "http://localhost:5173" });
  const inbox = [];
  const closed = new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on("message", (data) => inbox.push(JSON.parse(data.toString())));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth", accessToken: token, instanceId }));
  const deadline = Date.now() + 1_000;
  while (!inbox.some((m) => m.type === "history") && Date.now() < deadline) {
    if (ws.readyState !== WebSocket.OPEN) break;
    await delay(5);
  }
  return {
    ws,
    inbox,
    closed,
    send: (frame) => ws.send(JSON.stringify(frame)),
    messages: () => inbox.filter((m) => m.type === "message"),
    last: () => inbox.at(-1),
  };
}

const settle = () => delay(60);

// --- Entrega e isolamento ---------------------------------------------------

test("mensagem chega a todos da mesma sala com autor do servidor; nonce só para quem enviou", async () => {
  const { url } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  ana.send({ type: "send", text: "Olá, Bruno!", nonce: "n-1" });
  await settle();

  const [toAna] = ana.messages();
  const [toBruno] = bruno.messages();
  assert.equal(toAna.nonce, "n-1");
  assert.equal("nonce" in toBruno, false);
  assert.deepEqual(toAna.message, toBruno.message, "mesma mensagem (mesmo id) para os dois");
  assert.equal(toBruno.message.text, "Olá, Bruno!");
  assert.deepEqual(toBruno.message.author, USERS["tok-ana"]);
  assert.match(toBruno.message.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("ISOLAMENTO: usuários de instâncias diferentes nunca recebem mensagens uns dos outros", async () => {
  const { url } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  const carla = await join(url, "tok-carla", I2);

  ana.send({ type: "send", text: "só para a sala 1" });
  carla.send({ type: "send", text: "só para a sala 2" });
  await settle();

  assert.deepEqual(ana.messages().map((m) => m.message.text), ["só para a sala 1"]);
  assert.deepEqual(bruno.messages().map((m) => m.message.text), ["só para a sala 1"]);
  assert.deepEqual(carla.messages().map((m) => m.message.text), ["só para a sala 2"]);

  // E o histórico de uma sala não aparece na outra.
  const outraCarla = await join(url, "tok-carla", I2);
  assert.deepEqual(outraCarla.inbox.find((m) => m.type === "history").messages.map((m) => m.text), ["só para a sala 2"]);
});

test("identidade enviada junto com a mensagem é ignorada", async () => {
  const { url } = await startServer();
  const bruno = await join(url, "tok-bruno", I1);
  bruno.send({
    type: "send",
    text: "oi",
    author: { id: "1", displayName: "Ana" },
    id: "forjado",
    createdAt: "2000-01-01T00:00:00.000Z",
  });
  await settle();
  const { message } = bruno.messages()[0];
  assert.deepEqual(message.author, USERS["tok-bruno"]);
  assert.notEqual(message.id, "forjado");
  assert.notEqual(message.createdAt, "2000-01-01T00:00:00.000Z");
});

// --- Histórico ---------------------------------------------------------------

test("quem entra depois recebe o histórico da sala, em ordem", async () => {
  const { url } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  for (const text of ["um", "dois", "três"]) ana.send({ type: "send", text });
  await settle();
  const bruno = await join(url, "tok-bruno", I1);
  assert.deepEqual(bruno.inbox.map((m) => m.type), ["ready", "history"]);
  assert.deepEqual(bruno.inbox[1].messages.map((m) => m.text), ["um", "dois", "três"]);
});

test("histórico limitado às 100 mensagens mais recentes", async () => {
  const { url } = await startServer({ messageRateLimit: { limit: 1_000, windowMs: 10_000 }, frameRateLimit: { limit: 1_000, windowMs: 10_000 } });
  const ana = await join(url, "tok-ana", I1);
  for (let i = 1; i <= 105; i++) ana.send({ type: "send", text: `m${i}` });
  await delay(200);
  const bruno = await join(url, "tok-bruno", I1);
  const history = bruno.inbox[1].messages;
  assert.equal(history.length, 100);
  assert.equal(history[0].text, "m6");
  assert.equal(history.at(-1).text, "m105");
});

test("sala vazia é removida após o TTL; antes disso o histórico é mantido", async () => {
  const rooms = createRoomRegistry({ emptyRoomTtlMs: 150 });
  const { url } = await startServer({ rooms });
  const ana = await join(url, "tok-ana", I1);
  ana.send({ type: "send", text: "guardada" });
  await settle();
  ana.ws.close();
  await ana.closed;
  await settle();
  assert.equal(rooms.clientCount(I1), 0);

  const bruno = await join(url, "tok-bruno", I1); // dentro do TTL
  assert.deepEqual(bruno.inbox[1].messages.map((m) => m.text), ["guardada"]);
  bruno.ws.close();
  await bruno.closed;
  await delay(250); // além do TTL
  assert.equal(rooms.has(I1), false);

  const carla = await join(url, "tok-carla", I1);
  assert.deepEqual(carla.inbox[1].messages, [], "sala nova, sem histórico antigo");
});

// --- Validação --------------------------------------------------------------

for (const [name, frame, code] of [
  ["texto acima de 500 caracteres", { type: "send", text: "a".repeat(501), nonce: "n" }, "message_too_long"],
  ["texto vazio", { type: "send", text: "   ", nonce: "n" }, "empty_message"],
  ["texto não textual", { type: "send", text: 42, nonce: "n" }, "invalid_message"],
]) {
  test(`recusa ${name} com erro e mantém a conexão`, async () => {
    const { url } = await startServer();
    const ana = await join(url, "tok-ana", I1);
    const bruno = await join(url, "tok-bruno", I1);
    ana.send(frame);
    await settle();
    assert.deepEqual(ana.last(), { type: "error", code, nonce: "n" });
    assert.equal(ana.ws.readyState, WebSocket.OPEN);
    assert.equal(bruno.messages().length, 0, "nada é distribuído");
  });
}

test("nonce inválido: erro sem ecoar o valor", async () => {
  const { url } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  ana.send({ type: "send", text: "oi", nonce: "<script>" });
  await settle();
  assert.deepEqual(ana.last(), { type: "error", code: "invalid_nonce" });
});

test("mensagem com HTML é distribuída como texto, sem alteração", async () => {
  const { url } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  ana.send({ type: "send", text: "<b>oi</b><script>alert(1)</script>" });
  await settle();
  assert.equal(ana.messages()[0].message.text, "<b>oi</b><script>alert(1)</script>");
});

// --- Limites e abuso ---------------------------------------------------------

test("rate limit: a 6ª mensagem em 10 s recebe rate_limited e não é distribuída", async () => {
  const { url } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  for (let i = 1; i <= 6; i++) ana.send({ type: "send", text: `m${i}`, nonce: `n${i}` });
  await settle();
  const limited = ana.inbox.find((m) => m.type === "rate_limited");
  assert.equal(limited.nonce, "n6");
  assert.ok(limited.retryAfterMs > 0 && limited.retryAfterMs <= 10_000);
  assert.equal(bruno.messages().length, 5);
  assert.equal(ana.ws.readyState, WebSocket.OPEN);
});

test("rate limit é por usuário: somado entre conexões e independente entre usuários", async () => {
  const { url } = await startServer();
  const ana1 = await join(url, "tok-ana", I1);
  const ana2 = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  for (let i = 0; i < 3; i++) ana1.send({ type: "send", text: "a" });
  for (let i = 0; i < 3; i++) ana2.send({ type: "send", text: "b" });
  bruno.send({ type: "send", text: "c" });
  await settle();
  assert.equal([...ana1.inbox, ...ana2.inbox].filter((m) => m.type === "rate_limited").length, 1);
  assert.equal(bruno.inbox.filter((m) => m.type === "rate_limited").length, 0);
  assert.equal(bruno.messages().length, 6, "5 da Ana + 1 do Bruno");
});

test("inundação de frames encerra a conexão com 4029 too_many_frames", async () => {
  const { url } = await startServer();
  const ana = await join(url, "tok-ana", I1); // o auth já contou 1 frame
  for (let i = 0; i < 40; i++) ana.send({ type: "desconhecido" });
  assert.deepEqual(await ana.closed, { code: CloseCode.RATE_LIMITED, reason: "too_many_frames" });
});

test("no máximo 3 conexões por usuário; ao fechar uma, outra pode entrar", async () => {
  const { url } = await startServer();
  const conns = [await join(url, "tok-ana", I1), await join(url, "tok-ana", I1), await join(url, "tok-ana", I2)];
  const quarta = await join(url, "tok-ana", I1);
  assert.deepEqual(await quarta.closed, { code: CloseCode.RATE_LIMITED, reason: "too_many_connections" });
  conns[0].ws.close();
  await conns[0].closed;
  await settle();
  const nova = await join(url, "tok-ana", I1);
  assert.equal(nova.inbox[0].type, "ready");
});

test("sala cheia recusa novas conexões com 4029 room_full", async () => {
  const { url } = await startServer({ maxConnectionsPerRoom: 2 });
  await join(url, "tok-ana", I1);
  await join(url, "tok-bruno", I1);
  const carla = await join(url, "tok-carla", I1);
  assert.deepEqual(await carla.closed, { code: CloseCode.RATE_LIMITED, reason: "room_full" });
  const outraSala = await join(url, "tok-carla", I2);
  assert.equal(outraSala.inbox[0].type, "ready", "o limite é por sala");
});

test("desconexão remove o cliente da sala e libera a contagem do usuário", async () => {
  const { url, chat } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  await join(url, "tok-bruno", I1);
  assert.equal(chat.rooms.clientCount(I1), 2);
  ana.ws.terminate();
  await ana.closed;
  await settle();
  assert.equal(chat.rooms.clientCount(I1), 1);
});

// --- Revalidação periódica --------------------------------------------------

test("revalidação: quem saiu da instância é desconectado; os demais continuam", async () => {
  let members = new Set(["1", "2"]);
  const { url, chat } = await startServer({ getMembers: async () => members });
  const ana = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  members = new Set(["1"]); // Bruno saiu da Activity
  await chat.revalidate();
  assert.deepEqual(await bruno.closed, { code: CloseCode.FORBIDDEN, reason: "not_in_instance" });
  assert.equal(ana.ws.readyState, WebSocket.OPEN);
});

test("revalidação: instância encerrada (404) desconecta todos da sala", async () => {
  const { url, chat } = await startServer({
    getMembers: async () => {
      throw new ChatCloseError(CloseCode.FORBIDDEN, "instance_not_found");
    },
  });
  const ana = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  await chat.revalidate();
  assert.deepEqual(await ana.closed, { code: CloseCode.FORBIDDEN, reason: "instance_not_found" });
  assert.deepEqual(await bruno.closed, { code: CloseCode.FORBIDDEN, reason: "instance_not_found" });
});

test("revalidação: Discord indisponível não derruba ninguém", async () => {
  const { url, chat } = await startServer({
    getMembers: async () => {
      throw new ChatCloseError(CloseCode.TRY_AGAIN_LATER, "discord_unavailable");
    },
  });
  const ana = await join(url, "tok-ana", I1);
  await chat.revalidate();
  await settle();
  assert.equal(ana.ws.readyState, WebSocket.OPEN);
});

test("revalidação consulta cada sala separadamente", async () => {
  const asked = [];
  const { url, chat } = await startServer({
    getMembers: async (instanceId) => {
      asked.push(instanceId);
      return new Set(["1", "2", "3"]);
    },
  });
  await join(url, "tok-ana", I1);
  await join(url, "tok-carla", I2);
  await chat.revalidate();
  assert.deepEqual(asked.sort(), [I1, I2].sort());
});

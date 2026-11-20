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
 * Etapa 4.1 — idempotência pelo nonce, de ponta a ponta com o attachChat real
 * (salas, protocolo, limites). Só o autenticador é simulado: token → usuário.
 */

const USERS = {
  "tok-ana": { id: "1", username: "ana", displayName: "Ana", avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png" },
  "tok-bruno": { id: "2", username: "bruno", displayName: "Bruno", avatarUrl: "https://cdn.discordapp.com/embed/avatars/1.png" },
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

async function join(url, token, instanceId) {
  const ws = new WebSocket(url, { origin: "http://localhost:5173" });
  const inbox = [];
  const closed = new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on("message", (data) => inbox.push(JSON.parse(data.toString())));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth", accessToken: token, instanceId }));
  const deadline = Date.now() + 1_000;
  while (!inbox.some((m) => m.type === "history") && Date.now() < deadline && ws.readyState === WebSocket.OPEN) await delay(5);
  return {
    ws,
    inbox,
    closed,
    send: (frame) => ws.send(JSON.stringify(frame)),
    messages: () => inbox.filter((m) => m.type === "message"),
    history: () => inbox.find((m) => m.type === "history").messages,
  };
}

const settle = () => delay(60);
const send = (client, text, nonce) => client.send({ type: "send", text, ...(nonce !== undefined && { nonce }) });

// --- Cenário normal -----------------------------------------------------------

test("normal: envio com nonce entra uma vez no histórico e chega a todos uma vez", async () => {
  const { url, chat } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  send(ana, "olá", "n-1");
  await settle();
  assert.equal(ana.messages().length, 1);
  assert.equal(bruno.messages().length, 1);
  assert.equal(ana.messages()[0].nonce, "n-1");
  assert.equal("nonce" in bruno.messages()[0], false);
  assert.equal(chat.rooms.history(I1).length, 1);
});

test("normal: envios sem nonce não são deduplicados (cada um é uma mensagem)", async () => {
  const { url, chat } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  send(ana, "igual");
  send(ana, "igual");
  await settle();
  assert.equal(chat.rooms.history(I1).length, 2);
  assert.equal(ana.messages().length, 2);
});

// --- Duplicados ---------------------------------------------------------------

test("duplicado: reenvio devolve a MESMA mensagem só ao autor e não retransmite à sala", async () => {
  const { url, chat } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  send(ana, "uma vez só", "n-dup");
  await settle();
  const original = ana.messages()[0].message;

  send(ana, "uma vez só", "n-dup");
  send(ana, "uma vez só", "n-dup");
  await settle();

  const toAna = ana.messages();
  assert.equal(toAna.length, 3, "a Ana recebe a confirmação de cada reenvio");
  for (const frame of toAna) {
    assert.deepEqual(frame.message, original, "sempre a mensagem original (mesmo id e horário)");
    assert.equal(frame.nonce, "n-dup");
  }
  assert.equal(bruno.messages().length, 1, "o Bruno recebeu apenas a original");
  assert.equal(chat.rooms.history(I1).length, 1);
});

test("duplicado com texto diferente devolve a original (o nonce identifica o envio)", async () => {
  const { url, chat } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  send(ana, "texto original", "n-x");
  await settle();
  send(ana, "texto alterado", "n-x");
  await settle();
  assert.equal(ana.messages()[1].message.text, "texto original");
  assert.deepEqual(chat.rooms.history(I1).map((m) => m.text), ["texto original"]);
});

test("duplicado não consome o limite de envio (5 a cada 10 s)", async () => {
  const { url, chat } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  send(ana, "1", "n-1");
  for (let i = 0; i < 10; i++) send(ana, "1", "n-1"); // 10 repetições idempotentes
  for (let i = 2; i <= 5; i++) send(ana, String(i), `n-${i}`); // mais 4 mensagens novas
  await settle();
  assert.equal(ana.inbox.filter((m) => m.type === "rate_limited").length, 0);
  assert.deepEqual(chat.rooms.history(I1).map((m) => m.text), ["1", "2", "3", "4", "5"]);

  send(ana, "6", "n-6"); // a 6ª mensagem NOVA é limitada normalmente
  await settle();
  assert.equal(ana.inbox.at(-1).type, "rate_limited");
});

test("envio recusado pelo limite não registra o nonce: o reenvio depois cria a mensagem", async () => {
  const { url, chat } = await startServer({ messageRateLimit: { limit: 1, windowMs: 200 } });
  const ana = await join(url, "tok-ana", I1);
  send(ana, "primeira", "n-1");
  send(ana, "segunda", "n-2");
  await settle();
  assert.equal(ana.inbox.at(-1).type, "rate_limited");
  assert.equal(chat.rooms.findByNonce(I1, "1", "n-2"), undefined);

  await delay(250);
  send(ana, "segunda", "n-2");
  await settle();
  assert.deepEqual(chat.rooms.history(I1).map((m) => m.text), ["primeira", "segunda"]);
});

test("envio inválido não registra o nonce: o mesmo nonce depois cria a mensagem", async () => {
  const { url, chat } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  send(ana, "a".repeat(501), "n-1");
  await settle();
  assert.deepEqual(ana.inbox.at(-1), { type: "error", code: "message_too_long", nonce: "n-1" });
  send(ana, "agora válida", "n-1");
  await settle();
  assert.deepEqual(chat.rooms.history(I1).map((m) => m.text), ["agora válida"]);
});

// --- Concorrência -------------------------------------------------------------

test("concorrência: frames repetidos enviados de uma vez geram uma única mensagem", async () => {
  const { url, chat } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  for (let i = 0; i < 5; i++) send(ana, "rajada", "n-burst"); // sem esperar entre os envios
  await settle();
  assert.equal(chat.rooms.history(I1).length, 1);
  assert.equal(bruno.messages().length, 1);
  assert.equal(new Set(ana.messages().map((m) => m.message.id)).size, 1);
});

test("concorrência: duas conexões do mesmo usuário com o mesmo nonce geram uma única mensagem", async () => {
  const { url, chat } = await startServer();
  const aba1 = await join(url, "tok-ana", I1);
  const aba2 = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  send(aba1, "de duas abas", "n-shared");
  send(aba2, "de duas abas", "n-shared");
  await settle();
  assert.equal(chat.rooms.history(I1).length, 1);
  assert.equal(bruno.messages().length, 1);
  const ids = [...aba1.messages(), ...aba2.messages()].map((m) => m.message.id);
  assert.equal(new Set(ids).size, 1, "as duas abas veem o mesmo id");
  // Cada aba recebe o nonce só pela própria confirmação.
  assert.ok(aba2.messages().some((m) => m.nonce === "n-shared"));
});

// --- Isolamento entre usuários e salas --------------------------------------

test("isolamento: usuários diferentes com o mesmo nonce criam mensagens distintas", async () => {
  const { url, chat } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  send(ana, "da Ana", "mesmo-nonce");
  await settle();
  send(bruno, "do Bruno", "mesmo-nonce");
  await settle();
  const history = chat.rooms.history(I1);
  assert.deepEqual(history.map((m) => [m.author.id, m.text]), [["1", "da Ana"], ["2", "do Bruno"]]);
  assert.equal(bruno.messages().at(-1).message.author.id, "2", "o Bruno NÃO recebeu a mensagem da Ana como confirmação");
});

test("isolamento: um usuário nunca recebe o nonce de outro (ao vivo nem no histórico)", async () => {
  const { url } = await startServer();
  const ana = await join(url, "tok-ana", I1);
  const bruno = await join(url, "tok-bruno", I1);
  send(ana, "um", "segredo-ana-1");
  send(ana, "um", "segredo-ana-1"); // reenvio
  send(ana, "dois", "segredo-ana-2");
  await settle();
  const brunoOutraConexao = await join(url, "tok-bruno", I1); // recebe o histórico
  const seenByBruno = JSON.stringify([...bruno.inbox, ...brunoOutraConexao.inbox]);
  assert.ok(!seenByBruno.includes("segredo-ana"), "nenhum nonce da Ana chegou ao Bruno");
});

test("isolamento: o mesmo usuário e nonce em salas diferentes criam uma mensagem em cada", async () => {
  const { url, chat } = await startServer();
  const anaSala1 = await join(url, "tok-ana", I1);
  const anaSala2 = await join(url, "tok-ana", I2);
  send(anaSala1, "sala 1", "n-1");
  await settle();
  send(anaSala2, "sala 2", "n-1");
  await settle();
  assert.deepEqual(chat.rooms.history(I1).map((m) => m.text), ["sala 1"]);
  assert.deepEqual(chat.rooms.history(I2).map((m) => m.text), ["sala 2"]);
});

// --- Reconexão ----------------------------------------------------------------

test("reconexão: o histórico traz o nonce das próprias mensagens e o reenvio não duplica", async () => {
  const { url, chat } = await startServer();
  const bruno = await join(url, "tok-bruno", I1);
  const ana = await join(url, "tok-ana", I1);
  send(ana, "enviada antes da queda", "n-pendente");
  await settle();
  const originalId = ana.messages()[0].message.id;
  ana.ws.terminate(); // queda de conexão
  await ana.closed;

  const anaDeNovo = await join(url, "tok-ana", I1);
  const [entry] = anaDeNovo.history();
  assert.equal(entry.id, originalId);
  assert.equal(entry.nonce, "n-pendente", "a Ana reconhece o próprio envio no histórico");

  send(anaDeNovo, "enviada antes da queda", "n-pendente"); // o cliente reenvia o pendente
  await settle();
  assert.equal(anaDeNovo.messages()[0].message.id, originalId);
  assert.equal(chat.rooms.history(I1).length, 1);
  assert.equal(bruno.messages().length, 1, "o Bruno não recebeu a mensagem de novo");

  const brunoDeNovo = await join(url, "tok-bruno", I1);
  assert.equal("nonce" in brunoDeNovo.history()[0], false, "o histórico do Bruno não traz o nonce da Ana");
});

// --- Retenção -----------------------------------------------------------------

test("retenção: nonce que saiu do histórico (100) é tratado como envio novo", async () => {
  const { url, chat } = await startServer({
    messageRateLimit: { limit: 1_000, windowMs: 10_000 },
    frameRateLimit: { limit: 1_000, windowMs: 10_000 },
  });
  const ana = await join(url, "tok-ana", I1);
  send(ana, "primeira", "n-antiga");
  for (let i = 1; i <= 100; i++) send(ana, `m${i}`, `n-${i}`);
  await delay(200);
  assert.equal(chat.rooms.findByNonce(I1, "1", "n-antiga"), undefined);
  assert.ok(chat.rooms.nonceCount(I1) <= 100, "o índice não passa do tamanho do histórico");

  send(ana, "primeira", "n-antiga");
  await settle();
  assert.equal(chat.rooms.history(I1).at(-1).text, "primeira", "virou uma mensagem nova");
  assert.equal(chat.rooms.history(I1).length, 100);
});

test("retenção: depois que a sala vazia é removida, o nonce deixa de valer", async () => {
  const rooms = createRoomRegistry({ emptyRoomTtlMs: 100 });
  const { url } = await startServer({ rooms });
  const ana = await join(url, "tok-ana", I1);
  send(ana, "antes", "n-1");
  await settle();
  ana.ws.close();
  await ana.closed;
  await delay(200);
  assert.equal(rooms.has(I1), false);

  const anaDeNovo = await join(url, "tok-ana", I1);
  send(anaDeNovo, "depois", "n-1");
  await settle();
  assert.deepEqual(rooms.history(I1).map((m) => m.text), ["depois"]);
});

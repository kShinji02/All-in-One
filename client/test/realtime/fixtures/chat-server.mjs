/**
 * Servidor de chat REAL (server/chat: attachChat, salas, histórico, idempotência)
 * num processo Node separado, para testes que rodam no ambiente jsdom.
 *
 * Só o autenticador do Discord é substituído: CHAT_TEST_USERS = { token: usuário }.
 * Escreve {"port": n} na primeira linha do stdout quando estiver ouvindo.
 *
 * Rotas de controle (somente para os testes):
 *   GET  /__test/history?room=ID           → textos do histórico da sala
 *   GET  /__test/clients?user=ID           → conexões autenticadas do usuário
 *   POST /__test/terminate?user=ID         → derruba as conexões do usuário (1006)
 *   POST /__test/terminate-on?user=ID&text=T → derruba o usuário logo após gravar T
 */
import http from "node:http";
import { attachChat } from "../../../../server/chat/index.js";
import { ChatCloseError } from "../../../../server/chat/errors.js";
import { createRoomRegistry } from "../../../../server/chat/rooms.js";

const USERS = JSON.parse(process.env.CHAT_TEST_USERS ?? "{}");

let terminateOn = null;
const real = createRoomRegistry();
const rooms = {
  ...real,
  append(id, message, nonce) {
    real.append(id, message, nonce);
    if (terminateOn && message.text === terminateOn.text) {
      const { userId } = terminateOn;
      terminateOn = null;
      terminateUser(userId);
    }
  },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const reply = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/__test/history") {
    return reply(rooms.historyFor(url.searchParams.get("room"), "observador").map((m) => m.text));
  }
  if (url.pathname === "/__test/clients") {
    const user = url.searchParams.get("user");
    return reply([...chat.wss.clients].filter((ws) => ws.chatSession?.user?.id === user).length);
  }
  if (url.pathname === "/__test/terminate") {
    terminateUser(url.searchParams.get("user"));
    return reply(true);
  }
  if (url.pathname === "/__test/terminate-on") {
    terminateOn = { userId: url.searchParams.get("user"), text: url.searchParams.get("text") };
    return reply(true);
  }
  res.writeHead(404).end();
});

const chat = attachChat(server, {
  rooms,
  authenticate: async ({ accessToken, instanceId }) => {
    const user = USERS[accessToken];
    if (!user) throw new ChatCloseError(4001, "invalid_token");
    return { user, instanceId };
  },
  logger: { error: () => undefined },
});

function terminateUser(userId) {
  for (const ws of chat.wss.clients) if (ws.chatSession?.user?.id === userId) ws.terminate();
}

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

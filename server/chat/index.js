import { WebSocket, WebSocketServer } from "ws";
import {
  AUTH_TIMEOUT_MS,
  CHAT_PATH,
  CloseCode,
  HEARTBEAT_INTERVAL_MS,
  MAX_ACCESS_TOKEN_LENGTH,
  MAX_INSTANCE_ID_LENGTH,
  MAX_PAYLOAD_BYTES,
} from "./config.js";
import { authenticationUnavailable, ChatCloseError } from "./errors.js";
import { isAllowedOrigin } from "./origin.js";

/**
 * Acopla o servidor de chat (WebSocket) a um servidor HTTP existente.
 *
 * Etapa 1 — ciclo de vida da conexão:
 * - upgrade apenas em CHAT_PATH e de origens permitidas;
 * - frames limitados a MAX_PAYLOAD_BYTES;
 * - o primeiro frame deve ser {type:"auth", accessToken, instanceId} dentro do prazo;
 * - heartbeat (ping/pong) encerra conexões mortas.
 *
 * `authenticate` recebe { accessToken, instanceId } e devolve { user, instanceId }
 * ou lança ChatCloseError. Na Etapa 1 o padrão recusa todas as tentativas.
 */
export function attachChat(server, options = {}) {
  const {
    path = CHAT_PATH,
    discordClientId = null,
    authenticate = authenticationUnavailable,
    authTimeoutMs = AUTH_TIMEOUT_MS,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    maxPayload = MAX_PAYLOAD_BYTES,
    logger = console,
  } = options;

  const wss = new WebSocketServer({ noServer: true, maxPayload, clientTracking: true });

  const onUpgrade = (req, socket, head) => {
    let pathname;
    try {
      ({ pathname } = new URL(req.url ?? "", "http://localhost"));
    } catch {
      return rejectUpgrade(socket, 400, "Bad Request");
    }
    if (pathname !== path) return rejectUpgrade(socket, 404, "Not Found");
    if (!isAllowedOrigin(req.headers.origin, { discordClientId })) {
      return rejectUpgrade(socket, 403, "Forbidden");
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws) => handleConnection(ws, { authenticate, authTimeoutMs, logger }));

  // Heartbeat: quem não respondeu ao ping anterior é encerrado.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    server.off("upgrade", onUpgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
  server.once("close", close);

  return { wss, close };
}

function handleConnection(ws, { authenticate, authTimeoutMs, logger }) {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  // Erros de socket (ex.: frame acima do limite) já encerram a conexão; evita derrubar o processo.
  ws.on("error", () => undefined);

  const session = { user: null, instanceId: null, authenticating: false };
  const authTimer = setTimeout(() => closeWith(ws, CloseCode.AUTH_TIMEOUT, "auth_timeout"), authTimeoutMs);
  ws.on("close", () => clearTimeout(authTimer));

  ws.on("message", async (data, isBinary) => {
    if (isBinary) return closeWith(ws, CloseCode.BAD_REQUEST, "binary_not_supported");

    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      return closeWith(ws, CloseCode.BAD_REQUEST, "invalid_json");
    }
    if (message === null || typeof message !== "object" || typeof message.type !== "string") {
      return closeWith(ws, CloseCode.BAD_REQUEST, "invalid_message");
    }

    if (session.user) {
      // Mensagens de chat serão tratadas na Etapa 3.
      return send(ws, { type: "error", code: "unsupported_message" });
    }

    if (message.type !== "auth") return closeWith(ws, CloseCode.UNAUTHORIZED, "auth_required");
    if (session.authenticating) return closeWith(ws, CloseCode.BAD_REQUEST, "auth_in_progress");

    const { accessToken, instanceId } = message;
    if (
      typeof accessToken !== "string" ||
      accessToken.length === 0 ||
      accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
      typeof instanceId !== "string" ||
      instanceId.length === 0 ||
      instanceId.length > MAX_INSTANCE_ID_LENGTH
    ) {
      return closeWith(ws, CloseCode.BAD_REQUEST, "invalid_auth");
    }

    session.authenticating = true;
    try {
      const result = await authenticate({ accessToken, instanceId });
      if (ws.readyState !== WebSocket.OPEN) return;
      clearTimeout(authTimer);
      session.user = result.user;
      session.instanceId = result.instanceId;
      send(ws, { type: "ready", self: publicUser(result.user) });
    } catch (error) {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (error instanceof ChatCloseError) {
        closeWith(ws, error.closeCode, error.reason);
      } else {
        // Nunca registra o token nem a mensagem recebida.
        logger.error("[chat] Falha inesperada na autenticação:", error?.message ?? error);
        closeWith(ws, CloseCode.UNAUTHORIZED, "auth_failed");
      }
    } finally {
      session.authenticating = false;
    }
  });
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function closeWith(ws, code, reason) {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(code, reason);
  }
}

function rejectUpgrade(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

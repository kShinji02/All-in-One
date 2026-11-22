import { WebSocket, WebSocketServer } from "ws";
import {
  AUTH_FAILURE_LIMIT,
  AUTH_TIMEOUT_MS,
  CHAT_PATH,
  CloseCode,
  FRAME_RATE_LIMIT,
  HEARTBEAT_INTERVAL_MS,
  MAX_ACCESS_TOKEN_LENGTH,
  MAX_CONNECTIONS_PER_ROOM,
  MAX_CONNECTIONS_PER_USER,
  MAX_INSTANCE_ID_LENGTH,
  MAX_PENDING_AUTH_PER_IP,
  MAX_PENDING_AUTH_TOTAL,
  MAX_PAYLOAD_BYTES,
  MEMBERSHIP_REVALIDATE_MS,
  MESSAGE_RATE_LIMIT,
  UPGRADE_RATE_LIMIT,
} from "./config.js";
import { clientIp, TRUST_NONE } from "./client-ip.js";
import { authenticationUnavailable, ChatCloseError } from "./errors.js";
import { isAllowedOrigin } from "./origin.js";
import { createMessage, parseSendFrame } from "./protocol.js";
import { createSlidingWindowLimiter } from "./rate-limit.js";
import { createRoomRegistry } from "./rooms.js";

/**
 * Acopla o servidor de chat (WebSocket) a um servidor HTTP existente.
 *
 * Etapa 1 — ciclo de vida: upgrade só em CHAT_PATH e de origens permitidas,
 *   frames até MAX_PAYLOAD_BYTES, primeiro frame {type:"auth"} dentro do prazo, heartbeat.
 * Etapa 2 — `authenticate({accessToken, instanceId})` valida no Discord e devolve
 *   { user, instanceId }, ou lança ChatCloseError.
 * Etapa 3 — salas por instanceId validado, histórico, envio de mensagens, limites
 *   contra abuso e revalidação periódica dos membros via `getMembers(instanceId)`.
 */
export function attachChat(server, options = {}) {
  const {
    path = CHAT_PATH,
    discordClientId = null,
    // Perfil de origens aceitas (chat/origin.js): "production", "local" ou "tunnel".
    originProfile = "tunnel",
    extraOrigins = [],
    authenticate = authenticationUnavailable,
    getMembers = null,
    authTimeoutMs = AUTH_TIMEOUT_MS,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    revalidateIntervalMs = MEMBERSHIP_REVALIDATE_MS,
    maxPayload = MAX_PAYLOAD_BYTES,
    maxConnectionsPerUser = MAX_CONNECTIONS_PER_USER,
    maxConnectionsPerRoom = MAX_CONNECTIONS_PER_ROOM,
    messageRateLimit = MESSAGE_RATE_LIMIT,
    frameRateLimit = FRAME_RATE_LIMIT,
    rooms = createRoomRegistry(),
    now = Date.now,
    logger = console,
    // Fase 5.1: IP do cliente pela regra do TRUST_PROXY (app.get("trust proxy fn")).
    trustProxyFn = TRUST_NONE,
    authFailureLimit = AUTH_FAILURE_LIMIT,
    upgradeRateLimit = UPGRADE_RATE_LIMIT,
    maxPendingPerIp = MAX_PENDING_AUTH_PER_IP,
    maxPendingTotal = MAX_PENDING_AUTH_TOTAL,
  } = options;

  const wss = new WebSocketServer({ noServer: true, maxPayload, clientTracking: true });

  const context = {
    authenticate,
    authTimeoutMs,
    logger,
    rooms,
    now,
    maxConnectionsPerUser,
    maxConnectionsPerRoom,
    messageLimiter: createSlidingWindowLimiter({ ...messageRateLimit, now }),
    frameLimiter: createSlidingWindowLimiter({ ...frameRateLimit, now }),
    authFailures: createSlidingWindowLimiter({ ...authFailureLimit, now }),
    upgrades: createSlidingWindowLimiter({ ...upgradeRateLimit, now }),
    pending: new Map(), // ip -> sockets ainda não autenticados
    pendingTotal: 0,
    userConnections: new Map(), // userId -> quantidade de conexões autenticadas
  };

  const onUpgrade = (req, socket, head) => {
    let pathname;
    try {
      ({ pathname } = new URL(req.url ?? "", "http://localhost"));
    } catch {
      return rejectUpgrade(socket, 400, "Bad Request");
    }
    if (pathname !== path) return rejectUpgrade(socket, 404, "Not Found");
    if (!isAllowedOrigin(req.headers.origin, { discordClientId, profile: originProfile, extraOrigins })) {
      return rejectUpgrade(socket, 403, "Forbidden");
    }

    // Proteção contra abuso: tudo antes de aceitar o socket, e portanto antes de
    // qualquer chamada ao Discord. Recusas são HTTP (o navegador vê 1006 e o cliente
    // tenta de novo com backoff).
    const ip = clientIp(req, trustProxyFn);
    const blocked = context.authFailures.peek(ip);
    if (!blocked.allowed) return rejectUpgrade(socket, 429, "Too Many Requests", blocked.retryAfterMs);
    const rate = context.upgrades.hit(ip);
    if (!rate.allowed) return rejectUpgrade(socket, 429, "Too Many Requests", rate.retryAfterMs);
    if ((context.pending.get(ip) ?? 0) >= maxPendingPerIp) return rejectUpgrade(socket, 429, "Too Many Requests", authTimeoutMs);
    if (context.pendingTotal >= maxPendingTotal) return rejectUpgrade(socket, 503, "Service Unavailable", authTimeoutMs);

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, ip));
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws, _req, ip = "unknown") => handleConnection(ws, context, ip));

  // Heartbeat: quem não respondeu ao ping anterior é encerrado. Aproveita para limpar os limitadores.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    context.messageLimiter.sweep();
    context.frameLimiter.sweep();
    context.authFailures.sweep();
    context.upgrades.sweep();
    authenticate.tokens?.sweep?.();
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  // Revalidação periódica: quem não está mais na instância perde o acesso à sala.
  let revalidating = false;
  async function revalidate() {
    if (!getMembers || revalidating) return;
    revalidating = true;
    try {
      for (const instanceId of rooms.ids()) {
        const clients = rooms.clients(instanceId);
        if (clients.length === 0) continue;
        let members;
        try {
          members = await getMembers(instanceId);
        } catch (error) {
          if (error instanceof ChatCloseError && error.reason === "instance_not_found") {
            for (const ws of clients) closeWith(ws, CloseCode.FORBIDDEN, "instance_not_found");
          }
          // Discord indisponível: mantém as conexões e tenta no próximo ciclo.
          continue;
        }
        for (const ws of clients) {
          if (!members.has(ws.chatSession?.user?.id)) closeWith(ws, CloseCode.FORBIDDEN, "not_in_instance");
        }
      }
    } finally {
      revalidating = false;
    }
  }
  const revalidation = getMembers ? setInterval(() => void revalidate(), revalidateIntervalMs) : null;
  revalidation?.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    if (revalidation) clearInterval(revalidation);
    server.off("upgrade", onUpgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    rooms.clear();
  };
  server.once("close", close);

  return { wss, close, rooms, revalidate };
}

/**
 * Fechamentos antes da autenticação que indicam erro do CLIENTE (token inválido,
 * instância errada, protocolo). Só eles contam como falha por IP; falhas do servidor ou
 * do Discord (auth_failed, discord_unavailable, server_misconfigured…) não contam.
 */
const AUTH_FAILURE_REASONS = new Set([
  "invalid_token",
  "auth_required",
  "invalid_auth",
  "invalid_json",
  "invalid_message",
  "binary_not_supported",
  "auth_in_progress",
  "invalid_instance",
  "instance_not_found",
  "not_in_instance",
  "too_many_frames",
]);

function handleConnection(ws, context, ip) {
  const { authenticate, authTimeoutMs, logger, rooms, frameLimiter } = context;

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  // Erros de socket (ex.: frame acima do limite) já encerram a conexão; evita derrubar o processo.
  ws.on("error", () => undefined);

  const session = { user: null, instanceId: null, authenticating: false, joined: false };
  ws.chatSession = session;

  // Conta como "pendente" (não autenticado) até autenticar ou fechar.
  context.pending.set(ip, (context.pending.get(ip) ?? 0) + 1);
  context.pendingTotal += 1;
  let pending = true;
  const settlePending = () => {
    if (!pending) return;
    pending = false;
    context.pendingTotal -= 1;
    const left = (context.pending.get(ip) ?? 1) - 1;
    if (left > 0) context.pending.set(ip, left);
    else context.pending.delete(ip);
  };

  const authTimer = setTimeout(() => closeWith(ws, CloseCode.AUTH_TIMEOUT, "auth_timeout"), authTimeoutMs);
  ws.on("close", () => {
    clearTimeout(authTimer);
    settlePending();
    if (!session.user && AUTH_FAILURE_REASONS.has(ws.chatCloseReason)) context.authFailures.hit(ip);
    if (session.joined) leaveRoom(ws, session, context);
  });

  ws.on("message", async (data, isBinary) => {
    // Inundação: qualquer frame conta, autenticado ou não.
    if (!frameLimiter.hit(ws).allowed) return closeWith(ws, CloseCode.RATE_LIMITED, "too_many_frames");

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
      if (message.type === "send") return handleSend(ws, session, message, context);
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

      // Limites de conexão (checados após saber quem é o usuário e qual a sala).
      if ((context.userConnections.get(result.user.id) ?? 0) >= context.maxConnectionsPerUser) {
        return closeWith(ws, CloseCode.RATE_LIMITED, "too_many_connections");
      }
      if (rooms.clientCount(result.instanceId) >= context.maxConnectionsPerRoom) {
        return closeWith(ws, CloseCode.RATE_LIMITED, "room_full");
      }

      // A sala é a do instanceId devolvido pelo autenticador (validado no Discord).
      session.user = result.user;
      session.instanceId = result.instanceId;
      settlePending();
      const history = joinRoom(ws, session, context);

      send(ws, { type: "ready", self: publicUser(result.user) });
      send(ws, { type: "history", messages: history });
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

function joinRoom(ws, session, { rooms, userConnections }) {
  userConnections.set(session.user.id, (userConnections.get(session.user.id) ?? 0) + 1);
  session.joined = true;
  rooms.join(session.instanceId, ws);
  // Histórico com o nonce apenas nas mensagens do próprio usuário.
  return rooms.historyFor(session.instanceId, session.user.id);
}

function leaveRoom(ws, session, { rooms, userConnections }) {
  session.joined = false;
  rooms.leave(session.instanceId, ws);
  const remaining = (userConnections.get(session.user.id) ?? 1) - 1;
  if (remaining > 0) userConnections.set(session.user.id, remaining);
  else userConnections.delete(session.user.id);
}

function handleSend(ws, session, frame, { rooms, messageLimiter, now }) {
  const parsed = parseSendFrame(frame);
  const withNonce = (payload, nonce) => (nonce ? { ...payload, nonce } : payload);

  if (!parsed.ok) return send(ws, withNonce({ type: "error", code: parsed.code }, parsed.nonce));

  // Idempotência: o mesmo autor reenviando o mesmo nonce recebe a mensagem original,
  // só nesta conexão. Nada é retransmitido à sala e o limite de envio não é consumido.
  // A chave inclui o autor, então usuários diferentes nunca compartilham um nonce.
  if (parsed.nonce) {
    const original = rooms.findByNonce(session.instanceId, session.user.id, parsed.nonce);
    if (original) return send(ws, { type: "message", message: original, nonce: parsed.nonce });
  }

  // Limite por usuário (soma todas as conexões dele).
  const limit = messageLimiter.hit(session.user.id);
  if (!limit.allowed) {
    return send(ws, withNonce({ type: "rate_limited", retryAfterMs: limit.retryAfterMs }, parsed.nonce));
  }

  const message = createMessage(session.user, parsed.text, now);
  rooms.append(session.instanceId, message, parsed.nonce);

  // Entrega só aos clientes da MESMA sala. O nonce volta apenas para quem enviou.
  for (const client of rooms.clients(session.instanceId)) {
    send(client, client === ws ? withNonce({ type: "message", message }, parsed.nonce) : { type: "message", message });
  }
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
    ws.chatCloseReason = reason;
    ws.close(code, reason);
  }
}

function rejectUpgrade(socket, status, text, retryAfterMs = null) {
  const retryAfter = retryAfterMs === null ? "" : `Retry-After: ${Math.max(1, Math.ceil(retryAfterMs / 1000))}\r\n`;
  socket.write(`HTTP/1.1 ${status} ${text}\r\n${retryAfter}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

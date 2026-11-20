import {
  CloseCode,
  DISCORD_REQUEST_TIMEOUT_MS,
  INSTANCE_CACHE_MAX_ENTRIES,
  INSTANCE_CACHE_TTL_MS,
  INSTANCE_ID_PATTERN,
} from "./config.js";
import { describeResponse, discordGet } from "./discord-api.js";
import { remember } from "./auth.js";
import { ChatCloseError } from "./errors.js";

/**
 * Consulta GET /applications/{application_id}/activity-instances/{instance_id}
 * com o token de bot da aplicação (endpoint oficial recomendado pela
 * documentação para validar, no servidor, quem está numa instância).
 *
 * - O instanceId é validado antes de entrar na URL.
 * - O resultado fica em cache por INSTANCE_CACHE_TTL_MS.
 * - Consultas simultâneas da mesma instância compartilham uma única chamada.
 */
export function createInstanceVerifier({
  applicationId,
  botToken,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  ttlMs = INSTANCE_CACHE_TTL_MS,
  maxEntries = INSTANCE_CACHE_MAX_ENTRIES,
  timeoutMs = DISCORD_REQUEST_TIMEOUT_MS,
  logger = console,
}) {
  if (!applicationId || !botToken) {
    throw new Error("createInstanceVerifier requer applicationId e botToken");
  }

  const cache = new Map(); // instanceId -> { users: Set<string>, expiresAt }
  const inflight = new Map(); // instanceId -> Promise<snapshot>

  async function fetchInstance(instanceId) {
    const path = `/applications/${encodeURIComponent(applicationId)}/activity-instances/${encodeURIComponent(instanceId)}`;
    const result = await discordGet(path, { authorization: `Bot ${botToken}`, fetchImpl, timeoutMs });

    if (result.ok && isActivityInstance(result.body, instanceId)) {
      return { users: new Set(result.body.users), expiresAt: now() + ttlMs };
    }

    if (result.status === 404) {
      throw new ChatCloseError(CloseCode.FORBIDDEN, "instance_not_found");
    }

    if (result.status === 401 || result.status === 403) {
      // Problema de configuração do servidor, não do usuário. Nunca registra o token.
      logger.error(`[chat] DISCORD_BOT_TOKEN recusado pelo Discord (${describeResponse(result)}).`);
      throw new ChatCloseError(CloseCode.INTERNAL_ERROR, "server_misconfigured");
    }

    logger.warn(`[chat] activity-instances indisponível (${describeResponse(result)})`);
    throw new ChatCloseError(CloseCode.TRY_AGAIN_LATER, "discord_unavailable");
  }

  /** Devolve { users, fromCache }. Com `fresh`, ignora o cache e consulta o Discord. */
  async function getSnapshot(instanceId, { fresh = false } = {}) {
    if (typeof instanceId !== "string" || !INSTANCE_ID_PATTERN.test(instanceId)) {
      throw new ChatCloseError(CloseCode.BAD_REQUEST, "invalid_instance");
    }

    if (!fresh) {
      const cached = cache.get(instanceId);
      if (cached && cached.expiresAt > now()) return { users: cached.users, fromCache: true };
    }

    let pending = inflight.get(instanceId);
    if (!pending) {
      pending = fetchInstance(instanceId)
        .then((snapshot) => {
          remember(cache, instanceId, snapshot, maxEntries);
          return snapshot;
        })
        .finally(() => inflight.delete(instanceId));
      inflight.set(instanceId, pending);
    }
    const snapshot = await pending;
    return { users: snapshot.users, fromCache: false };
  }

  return {
    getSnapshot,
    /**
     * Garante que o usuário está conectado à instância. Se o cache não contém o
     * usuário (ex.: ele acabou de entrar), consulta o Discord uma vez antes de recusar.
     */
    async assertMember(instanceId, userId, snapshot = null) {
      const current = snapshot ?? (await getSnapshot(instanceId));
      if (current.users.has(userId)) return;
      if (current.fromCache) {
        const fresh = await getSnapshot(instanceId, { fresh: true });
        if (fresh.users.has(userId)) return;
      }
      throw new ChatCloseError(CloseCode.FORBIDDEN, "not_in_instance");
    },
    size: () => cache.size,
  };
}

function isActivityInstance(body, instanceId) {
  return (
    body !== null &&
    typeof body === "object" &&
    body.instance_id === instanceId &&
    Array.isArray(body.users) &&
    body.users.every((id) => typeof id === "string")
  );
}

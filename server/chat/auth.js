import { createHash } from "node:crypto";
import {
  CloseCode,
  DISCORD_CDN_BASE,
  DISCORD_REQUEST_TIMEOUT_MS,
  TOKEN_CACHE_MAX_ENTRIES,
  TOKEN_CACHE_TTL_MS,
} from "./config.js";
import { describeResponse, discordGet } from "./discord-api.js";
import { ChatCloseError } from "./errors.js";

/**
 * Valida o access token OAuth2 do usuário em GET /users/@me.
 *
 * - A identidade vem SOMENTE da resposta do Discord; nada enviado pelo cliente é usado.
 * - O cache é indexado pelo SHA-256 do token; o token em si não é guardado.
 * - Requisições simultâneas com o mesmo token compartilham uma única chamada.
 * - Respostas negativas não são guardadas em cache.
 */
export function createTokenValidator({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  ttlMs = TOKEN_CACHE_TTL_MS,
  maxEntries = TOKEN_CACHE_MAX_ENTRIES,
  timeoutMs = DISCORD_REQUEST_TIMEOUT_MS,
  logger = console,
} = {}) {
  const cache = new Map(); // hash -> { user, expiresAt }
  const inflight = new Map(); // hash -> Promise<user>

  async function fetchUser(accessToken) {
    const result = await discordGet("/users/@me", {
      authorization: `Bearer ${accessToken}`,
      fetchImpl,
      timeoutMs,
    });

    if (result.ok && isDiscordUser(result.body)) return toChatUser(result.body);

    if (result.status === 401 || result.status === 403) {
      throw new ChatCloseError(CloseCode.UNAUTHORIZED, "invalid_token");
    }

    logger.warn(`[chat] /users/@me indisponível (${describeResponse(result)})`);
    throw new ChatCloseError(CloseCode.TRY_AGAIN_LATER, "discord_unavailable");
  }

  return {
    async validate(accessToken) {
      const key = tokenCacheKey(accessToken);

      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return cached.user;
      if (cached) cache.delete(key);

      let pending = inflight.get(key);
      if (!pending) {
        pending = fetchUser(accessToken)
          .then((user) => {
            remember(cache, key, { user, expiresAt: now() + ttlMs }, maxEntries);
            return user;
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      return pending;
    },
    /** Quantidade de entradas em cache (para testes e diagnóstico). */
    size: () => cache.size,
    /** Chaves do cache (somente hashes), para testes. */
    keys: () => [...cache.keys()],
  };
}

/** Chave de cache: SHA-256 do token. */
export function tokenCacheKey(accessToken) {
  return createHash("sha256").update(accessToken, "utf8").digest("hex");
}

function isDiscordUser(body) {
  return (
    body !== null &&
    typeof body === "object" &&
    typeof body.id === "string" &&
    /^\d{1,20}$/.test(body.id) &&
    typeof body.username === "string"
  );
}

/** Converte o usuário do Discord no formato usado pelo chat. */
export function toChatUser(body) {
  const globalName = typeof body.global_name === "string" && body.global_name !== "" ? body.global_name : null;
  return {
    id: body.id,
    username: body.username,
    displayName: globalName ?? body.username,
    avatarUrl: avatarUrl(body),
  };
}

/** Mesma regra do cliente (client/src/discord/cdn.ts), conforme "Image Formatting" da documentação. */
function avatarUrl({ id, avatar, discriminator }) {
  if (typeof avatar === "string" && /^[a-zA-Z0-9_]+$/.test(avatar)) {
    return `${DISCORD_CDN_BASE}/avatars/${id}/${avatar}.png?size=128`;
  }
  let index = 0;
  if (discriminator && discriminator !== "0") {
    index = Number(discriminator) % 5 || 0;
  } else {
    try {
      index = Number((BigInt(id) >> 22n) % 6n);
    } catch {
      index = 0;
    }
  }
  return `${DISCORD_CDN_BASE}/embed/avatars/${index}.png`;
}

/** Insere no Map respeitando o limite: remove a entrada mais antiga (ordem de inserção). */
export function remember(map, key, value, maxEntries) {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) map.delete(map.keys().next().value);
}

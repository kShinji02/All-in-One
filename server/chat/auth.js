import { createHash } from "node:crypto";
import {
  CloseCode,
  DISCORD_CDN_BASE,
  DISCORD_REQUEST_TIMEOUT_MS,
  INVALID_TOKEN_CACHE_MAX_ENTRIES,
  INVALID_TOKEN_CACHE_TTL_MS,
  TOKEN_CACHE_MAX_ENTRIES,
  TOKEN_CACHE_TTL_MS,
  TOKEN_VALIDATION_RATE_LIMIT,
} from "./config.js";
import { createRetryGate, describeResponse, discordGet } from "./discord-api.js";
import { createSlidingWindowLimiter } from "./rate-limit.js";
import { ChatCloseError } from "./errors.js";

/** Escopo OAuth2 exigido: sem ele o Discord não devolve o usuário em /oauth2/@me. */
export const REQUIRED_SCOPE = "identify";

/**
 * Valida o access token OAuth2 do usuário em GET /oauth2/@me ("Get Current Authorization
 * Information"), que devolve a aplicação para a qual o token foi emitido, os escopos e o usuário.
 *
 * - O token precisa ter sido emitido para ESTA aplicação (`application.id === applicationId`)
 *   e ter o escopo `identify`. Um token válido de outra aplicação é recusado como inválido:
 *   quem obtivesse o token de alguém por outro app não consegue se passar por essa pessoa
 *   aqui nem registrar um aceite em nome dela.
 * - Sem `applicationId` configurado, toda validação é recusada (1011 server_misconfigured),
 *   sem chamar o Discord.
 * - A identidade vem SOMENTE da resposta do Discord; nada enviado pelo cliente é usado.
 * - O cache nunca passa do vencimento do token (`expires`).
 * - O cache é indexado pelo SHA-256 do token; o token em si não é guardado.
 * - Requisições simultâneas com o mesmo token compartilham uma única chamada.
 * - Token recusado (401/403) entra num cache NEGATIVO curto, também por hash: repetir o
 *   mesmo token inválido não gera nova chamada ao Discord.
 * - Chamadas reais (cache miss) têm teto global: alternar tokens inválidos, de quantos IPs
 *   for, nunca passa de `validationRateLimit` chamadas por janela.
 * - 429 do Discord: respeita o Retry-After (global → todas as validações; senão, só o token).
 */
export function createTokenValidator({
  applicationId = null,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  ttlMs = TOKEN_CACHE_TTL_MS,
  maxEntries = TOKEN_CACHE_MAX_ENTRIES,
  timeoutMs = DISCORD_REQUEST_TIMEOUT_MS,
  logger = console,
  invalidTtlMs = INVALID_TOKEN_CACHE_TTL_MS,
  invalidMaxEntries = INVALID_TOKEN_CACHE_MAX_ENTRIES,
  validationRateLimit = TOKEN_VALIDATION_RATE_LIMIT,
  gate = createRetryGate({ now }),
} = {}) {
  const cache = new Map(); // hash -> { user, expiresAt }
  const invalid = new Map(); // hash -> expiresAt (token recusado pelo Discord)
  const inflight = new Map(); // hash -> Promise<user>
  const outbound = createSlidingWindowLimiter({ ...validationRateLimit, now });
  const unavailable = () => new ChatCloseError(CloseCode.TRY_AGAIN_LATER, "discord_unavailable");

  /** Recusa o token como inválido e guarda o hash no cache negativo (sem nova consulta). */
  function refuse(key) {
    remember(invalid, key, now() + invalidTtlMs, invalidMaxEntries);
    return new ChatCloseError(CloseCode.UNAUTHORIZED, "invalid_token");
  }

  /** Devolve { user, expiresAtMs } da autorização, ou lança ChatCloseError. */
  async function fetchAuthorization(accessToken, key) {
    const result = await discordGet("/oauth2/@me", {
      authorization: `Bearer ${accessToken}`,
      fetchImpl,
      timeoutMs,
    });

    if (result.ok && isAuthorizationInfo(result.body)) {
      const { application, scopes, user, expires } = result.body;
      if (application.id !== applicationId) {
        // Token legítimo, mas de outra aplicação. Só o fato é registrado (sem token nem IDs).
        logger.warn("[auth] token emitido para outra aplicação recusado.");
        throw refuse(key);
      }
      if (!scopes.includes(REQUIRED_SCOPE)) {
        logger.warn(`[auth] token sem o escopo "${REQUIRED_SCOPE}" recusado.`);
        throw refuse(key);
      }
      const expiresAtMs = typeof expires === "string" ? Date.parse(expires) : NaN;
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= now()) throw refuse(key);
      // Com "identify", o Discord sempre devolve o usuário; sem ele, a resposta é inesperada.
      if (isDiscordUser(user)) {
        return { user: toChatUser(user), expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Infinity };
      }
    }

    if (result.status === 401 || result.status === 403) throw refuse(key);

    if (result.rateLimit) {
      const { retryAfterMs, global } = result.rateLimit;
      gate.block(global ? "bearer" : `bearer:${key}`, retryAfterMs);
      logger.warn(`[chat] /oauth2/@me limitado pelo Discord (429, ${global ? "global" : "token"}, ${retryAfterMs} ms)`);
      throw unavailable();
    }

    logger.warn(`[chat] /oauth2/@me indisponível (${describeResponse(result)})`);
    throw new ChatCloseError(CloseCode.TRY_AGAIN_LATER, "discord_unavailable");
  }

  return {
    async validate(accessToken) {
      // Sem o Client ID não há como conferir a aplicação do token: recusa sem chamar o Discord.
      if (!applicationId) throw new ChatCloseError(CloseCode.INTERNAL_ERROR, "server_misconfigured");
      const key = tokenCacheKey(accessToken);

      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return cached.user;
      if (cached) cache.delete(key);

      const refusedUntil = invalid.get(key);
      if (refusedUntil !== undefined && refusedUntil > now()) {
        throw new ChatCloseError(CloseCode.UNAUTHORIZED, "invalid_token");
      }
      if (refusedUntil !== undefined) invalid.delete(key);

      let pending = inflight.get(key);
      if (!pending) {
        // Só chamadas reais ao Discord passam por aqui (cache e chamadas em andamento não).
        if (gate.remaining("bearer", `bearer:${key}`) > 0) throw unavailable();
        if (!outbound.hit("discord").allowed) {
          logger.warn("[chat] teto de validações de token atingido; recusando temporariamente");
          throw unavailable();
        }
        pending = fetchAuthorization(accessToken, key)
          .then(({ user, expiresAtMs }) => {
            // Nunca guarda além do vencimento do próprio token.
            remember(cache, key, { user, expiresAt: Math.min(now() + ttlMs, expiresAtMs) }, maxEntries);
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
    /** Entradas do cache negativo (somente hashes), para testes. */
    invalidKeys: () => [...invalid.keys()],
    /** Remove entradas e janelas vencidas (chamado periodicamente). */
    sweep() {
      const at = now();
      for (const [key, until] of invalid) if (until <= at) invalid.delete(key);
      outbound.sweep();
    },
  };
}

/** Chave de cache: SHA-256 do token. */
export function tokenCacheKey(accessToken) {
  return createHash("sha256").update(accessToken, "utf8").digest("hex");
}

/** Formato mínimo de GET /oauth2/@me: aplicação com id e lista de escopos. */
function isAuthorizationInfo(body) {
  return (
    body !== null &&
    typeof body === "object" &&
    typeof body.application?.id === "string" &&
    Array.isArray(body.scopes) &&
    body.scopes.every((scope) => typeof scope === "string")
  );
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

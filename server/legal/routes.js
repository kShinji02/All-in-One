import express from "express";
import { CloseCode, MAX_ACCESS_TOKEN_LENGTH } from "../chat/config.js";
import { ChatCloseError } from "../chat/errors.js";
import { createSlidingWindowLimiter } from "../chat/rate-limit.js";
import { AcceptanceStoreUnavailableError } from "./acceptance-store.js";
import { LEGAL_VERSION_PATTERN } from "./config.js";

/**
 * Limites em duas camadas:
 *
 * - Por USUÁRIO autenticado (ID do Discord): a cota justa de cada pessoa. É a camada principal,
 *   porque o proxy das Activities do Discord esconde o IP dos usuários: no Render, muitas
 *   pessoas podem chegar com o mesmo IP (o do proxy), e um limite baixo por IP bloquearia todos.
 * - Por IP (req.ip, regra do TRUST_PROXY), aplicado ANTES de validar o token: só um teto alto
 *   contra enxurradas. Mesmo que o IP seja compartilhado, ele não atrapalha o uso normal; o teto
 *   global de validações no Discord (chat/config.js) continua valendo por cima de tudo.
 *
 * Quantos usuários de fato compartilham um IP só pode ser confirmado depois do deploy
 * (PROXY_DIAGNOSTICS; ver docs/DEPLOY-RENDER.md). Ajuste os tetos por IP com esse dado.
 */
export const LEGAL_STATUS_USER_RATE_LIMIT = Object.freeze({ limit: 20, windowMs: 60_000 });
export const LEGAL_ACCEPT_USER_RATE_LIMIT = Object.freeze({ limit: 6, windowMs: 60_000 });
export const LEGAL_STATUS_IP_RATE_LIMIT = Object.freeze({ limit: 300, windowMs: 60_000 });
export const LEGAL_ACCEPT_IP_RATE_LIMIT = Object.freeze({ limit: 300, windowMs: 60_000 });

/**
 * Rotas do aceite dos documentos legais (montadas em /api/legal):
 *
 *   GET  /status      → { documents, accepted, acceptedAt }
 *   POST /acceptance  { termsVersion, privacyVersion } → { accepted: true, acceptedAt, documents }
 *
 * A identidade vem SOMENTE do token OAuth (Authorization: Bearer), validado no Discord pelo
 * mesmo validador do chat (cache e teto de chamadas compartilhados). Nada no corpo identifica
 * o usuário. As versões enviadas precisam ser exatamente as atuais (409 caso contrário).
 */
export function createLegalRouter({
  validateToken,
  gate,
  documents,
  appVersion = null,
  now = Date.now,
  logger = console,
  statusUserRateLimit = LEGAL_STATUS_USER_RATE_LIMIT,
  acceptUserRateLimit = LEGAL_ACCEPT_USER_RATE_LIMIT,
  statusIpRateLimit = LEGAL_STATUS_IP_RATE_LIMIT,
  acceptIpRateLimit = LEGAL_ACCEPT_IP_RATE_LIMIT,
}) {
  const router = express.Router();
  const limiters = {
    statusIp: createSlidingWindowLimiter({ ...statusIpRateLimit, now }),
    acceptIp: createSlidingWindowLimiter({ ...acceptIpRateLimit, now }),
    statusUser: createSlidingWindowLimiter({ ...statusUserRateLimit, now }),
    acceptUser: createSlidingWindowLimiter({ ...acceptUserRateLimit, now }),
  };
  const sweeper = setInterval(() => {
    for (const limiter of Object.values(limiters)) limiter.sweep();
  }, 60_000);
  sweeper.unref?.();

  const publicDocuments = () => ({
    terms: { version: documents.terms.version, url: documents.terms.url },
    privacy: { version: documents.privacy.version, url: documents.privacy.url },
  });

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  function tooMany(res, retryAfterMs) {
    res.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).send({ error: "rate_limited", retryAfterMs });
  }

  /** Teto por IP, antes de qualquer validação (protege contra enxurradas sem token válido). */
  function limitedByIp(limiter) {
    return (req, res, next) => {
      const result = limiter.hit(req.ip ?? "unknown");
      return result.allowed ? next() : tooMany(res, result.retryAfterMs);
    };
  }

  /** Cota por usuário autenticado. Devolve false (e responde 429) se esgotou. */
  function withinUserLimit(limiter, user, res) {
    const result = limiter.hit(user.id);
    if (result.allowed) return true;
    tooMany(res, result.retryAfterMs);
    return false;
  }

  /** Valida o token e devolve o usuário do Discord, ou responde o erro e devolve null. */
  async function authenticate(req, res) {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/.exec(header);
    if (!match || match[1].length > MAX_ACCESS_TOKEN_LENGTH) {
      res.status(401).send({ error: "auth_required" });
      return null;
    }
    try {
      return await validateToken(match[1]);
    } catch (error) {
      if (error instanceof ChatCloseError && error.closeCode === CloseCode.UNAUTHORIZED) {
        res.status(401).send({ error: "invalid_token" });
      } else if (error instanceof ChatCloseError) {
        res.status(503).send({ error: error.reason === "server_misconfigured" ? "server_misconfigured" : "discord_unavailable" });
      } else {
        logger.error("[legal] falha inesperada ao validar o token:", error?.name ?? "erro");
        res.status(503).send({ error: "auth_failed" });
      }
      return null;
    }
  }

  function storeUnavailable(res) {
    return res.status(503).send({ error: "acceptance_unavailable" });
  }

  /** Express 4 não captura rejeições de handlers async: encaminha ao tratador de erros. */
  const route = (handler) => (req, res, next) => handler(req, res).catch(next);

  router.get("/status", limitedByIp(limiters.statusIp), route(async (req, res) => {
    const user = await authenticate(req, res);
    if (!user || !withinUserLimit(limiters.statusUser, user, res)) return;
    try {
      const found = await gate.findCurrent(user.id);
      res.send({ documents: publicDocuments(), accepted: Boolean(found), acceptedAt: found?.acceptedAt ?? null });
    } catch (error) {
      if (error instanceof AcceptanceStoreUnavailableError) return storeUnavailable(res);
      throw error;
    }
  }));

  router.post("/acceptance", limitedByIp(limiters.acceptIp), route(async (req, res) => {
    const user = await authenticate(req, res);
    if (!user || !withinUserLimit(limiters.acceptUser, user, res)) return;

    const termsVersion = req.body?.termsVersion;
    const privacyVersion = req.body?.privacyVersion;
    if (
      typeof termsVersion !== "string" ||
      typeof privacyVersion !== "string" ||
      !LEGAL_VERSION_PATTERN.test(termsVersion) ||
      !LEGAL_VERSION_PATTERN.test(privacyVersion)
    ) {
      return res.status(400).send({ error: "invalid_request" });
    }
    const current = gate.current();
    if (termsVersion !== current.terms || privacyVersion !== current.privacy) {
      return res.status(409).send({ error: "version_mismatch", documents: publicDocuments() });
    }

    try {
      const result = await gate.accept(user.id, appVersion);
      res.status(result.created ? 201 : 200).send({ accepted: true, acceptedAt: result.acceptedAt, documents: publicDocuments() });
    } catch (error) {
      if (error instanceof AcceptanceStoreUnavailableError) return storeUnavailable(res);
      throw error;
    }
  }));

  router.close = () => clearInterval(sweeper);
  return router;
}

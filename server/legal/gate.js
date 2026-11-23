import { remember } from "../chat/auth.js";
import { CloseCode } from "../chat/config.js";
import { ChatCloseError } from "../chat/errors.js";
import { AcceptanceStoreUnavailableError } from "./acceptance-store.js";

/** Aceites confirmados ficam em cache (um aceite de um par de versões nunca expira). */
export const ACCEPTANCE_CACHE_TTL_MS = 10 * 60_000;
export const ACCEPTANCE_CACHE_MAX_ENTRIES = 10_000;

/**
 * Verificação do aceite no servidor, usada pelo chat e pelas rotas /api/legal.
 *
 * - Só respostas positivas entram no cache; "não aceitou" e falhas sempre consultam de novo.
 * - Falha do armazenamento NUNCA libera o acesso.
 */
export function createLegalGate({ store, documents, now = Date.now, ttlMs = ACCEPTANCE_CACHE_TTL_MS, maxEntries = ACCEPTANCE_CACHE_MAX_ENTRIES }) {
  const cache = new Map(); // "userId|terms|privacy" -> { acceptedAt, expiresAt }
  const current = () => ({
    terms: documents.terms.version,
    privacy: documents.privacy.version,
    termsSha256: documents.terms.sha256 ?? null,
    privacySha256: documents.privacy.sha256 ?? null,
  });
  const keyOf = (userId, v) => `${userId}|${v.terms}|${v.privacy}|${v.termsSha256}|${v.privacySha256}`;

  /** { acceptedAt } das versões ATUAIS, ou null. Lança AcceptanceStoreUnavailableError. */
  async function findCurrent(userId) {
    const versions = current();
    const key = keyOf(userId, versions);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return { acceptedAt: cached.acceptedAt };
    if (cached) cache.delete(key);
    const found = await store.findAcceptance(userId, versions);
    if (found) remember(cache, key, { acceptedAt: found.acceptedAt, expiresAt: now() + ttlMs }, maxEntries);
    return found;
  }

  /** Registra o aceite das versões atuais (idempotente). */
  async function accept(userId, appVersion) {
    const versions = current();
    const result = await store.recordAcceptance({ userId, ...versions, appVersion });
    remember(cache, keyOf(userId, versions), { acceptedAt: result.acceptedAt, expiresAt: now() + ttlMs }, maxEntries);
    return result;
  }

  /** Para o chat: lança ChatCloseError se o usuário não aceitou as versões atuais. */
  async function requireAccepted(user) {
    let found;
    try {
      found = await findCurrent(user.id);
    } catch (error) {
      if (error instanceof AcceptanceStoreUnavailableError) {
        throw new ChatCloseError(CloseCode.TRY_AGAIN_LATER, "acceptance_unavailable");
      }
      throw error;
    }
    if (!found) throw new ChatCloseError(CloseCode.FORBIDDEN, "legal_acceptance_required");
  }

  return { current, findCurrent, accept, requireAccepted, cacheSize: () => cache.size };
}

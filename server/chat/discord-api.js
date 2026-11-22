import { DISCORD_API_BASE, DISCORD_MAX_RETRY_AFTER_MS } from "./config.js";

/** Espera padrão quando o Discord responde 429 sem informar quanto esperar. */
const DEFAULT_RETRY_AFTER_MS = 1_000;

/**
 * Faz uma requisição GET à API do Discord com tempo limite.
 *
 * Nunca lança erro: devolve { ok, status, body, failure, rateLimit }, em que `failure`
 * é "timeout" ou "network" quando não houve resposta HTTP e `rateLimit` só existe em
 * respostas 429 ({ retryAfterMs, global, scope }). O cabeçalho de autorização nunca é
 * registrado em log.
 */
export async function discordGet(path, { authorization, fetchImpl = globalThis.fetch, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
      method: "GET",
      headers: { Authorization: authorization, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const failure = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "network";
    return { ok: false, status: 0, body: null, failure, rateLimit: null };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const rateLimit = response.status === 429 ? parseRateLimit(body, response.headers) : null;
  return { ok: response.ok, status: response.status, body, failure: null, rateLimit };
}

/**
 * Interpreta um 429 do Discord ("Rate Limits" da documentação): `retry_after` do corpo
 * (segundos, com fração) ou o cabeçalho `Retry-After` (segundos). A espera é limitada a
 * DISCORD_MAX_RETRY_AFTER_MS para que um valor absurdo não trave o chat indefinidamente.
 * Um 429 sem corpo JSON (bloqueio por IP da Cloudflare) é tratado como global.
 */
export function parseRateLimit(body, headers) {
  const header = (name) => (typeof headers?.get === "function" ? headers.get(name) : null);
  const seconds = [body?.retry_after, header("retry-after"), header("x-ratelimit-reset-after")]
    .filter((value) => typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
    .map(Number)
    .find((value) => Number.isFinite(value) && value >= 0);
  const retryAfterMs =
    seconds === undefined ? DEFAULT_RETRY_AFTER_MS : Math.min(DISCORD_MAX_RETRY_AFTER_MS, Math.max(1, Math.ceil(seconds * 1000)));
  const scope = header("x-ratelimit-scope");
  const global =
    body === null || typeof body !== "object" || body.global === true || header("x-ratelimit-global") === "true" || scope === "global";
  return { retryAfterMs, global, scope };
}

/**
 * Bloqueios temporários impostos pelo Discord (429). Enquanto uma chave estiver
 * bloqueada, nenhuma chamada correspondente é feita: o chat responde "tente mais tarde".
 */
export function createRetryGate({ now = Date.now } = {}) {
  const until = new Map(); // chave -> instante em que o bloqueio termina
  return {
    /** Milissegundos restantes de bloqueio (0 = liberado) considerando todas as chaves. */
    remaining(...keys) {
      const at = now();
      let max = 0;
      for (const key of keys) {
        const end = until.get(key);
        if (end === undefined) continue;
        if (end <= at) until.delete(key);
        else max = Math.max(max, end - at);
      }
      return max;
    },
    block(key, ms) {
      const at = now();
      const end = at + ms;
      // Chaves por token só surgem de chamadas reais (limitadas), mas o mapa nunca cresce sem limite.
      if (until.size >= 1_000) for (const [k, e] of until) if (e <= at) until.delete(k);
      if ((until.get(key) ?? 0) < end) until.set(key, end);
    },
    size: () => until.size,
  };
}

/** Descrição segura de uma resposta para logs (somente status e tipo de falha). */
export function describeResponse({ status, failure }) {
  return failure ? failure : `HTTP ${status}`;
}

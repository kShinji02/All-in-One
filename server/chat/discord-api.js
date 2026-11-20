import { DISCORD_API_BASE } from "./config.js";

/**
 * Faz uma requisição GET à API do Discord com tempo limite.
 *
 * Nunca lança erro: devolve { ok, status, body, failure }, em que `failure`
 * é "timeout" ou "network" quando não houve resposta HTTP. O cabeçalho de
 * autorização nunca é registrado em log.
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
    return { ok: false, status: 0, body: null, failure };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body, failure: null };
}

/** Descrição segura de uma resposta para logs (somente status e tipo de falha). */
export function describeResponse({ status, failure }) {
  return failure ? failure : `HTTP ${status}`;
}

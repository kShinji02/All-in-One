/**
 * Requisições HTTP do cliente com prazo e cancelamento.
 *
 * O prazo cobre a requisição INTEIRA (cabeçalhos e corpo): um servidor que responde os
 * cabeçalhos e trava no corpo também estoura o prazo. Sem prazo, um backend que acorda
 * devagar (Render Free suspenso) ou um proxy que não responde deixaria a tela esperando
 * indefinidamente.
 */

/** Prazos padrão (ms). O Render Free leva até ~1 min para acordar um serviço suspenso. */
export const HTTP_TIMEOUTS = Object.freeze({
  /** POST /api/token: o servidor espera o Discord até 10 s; folga para o cold start. */
  tokenExchange: 30_000,
  /** GET /api/legal/status e POST /api/legal/acceptance. */
  legal: 20_000,
  /** Dado opcional (nome do servidor): não pode atrasar a entrada na Activity. */
  optional: 5_000,
});

export type HttpFailureKind =
  /** O prazo terminou antes da resposta completa. */
  | 'timeout'
  /** Cancelada por quem fez a chamada (ex.: a tela foi desmontada). */
  | 'aborted'
  /** Sem rede, DNS, CORS/CSP ou conexão recusada. */
  | 'network';

export class HttpRequestError extends Error {
  constructor(readonly kind: HttpFailureKind) {
    super(`http_${kind}`);
    this.name = 'HttpRequestError';
  }
}

export interface JsonResponse {
  status: number;
  ok: boolean;
  /** Corpo JSON como objeto; `{}` se vazio, inválido ou não for objeto. */
  body: Record<string, unknown>;
  /** O corpo era JSON de objeto (distingue resposta do backend de página de erro de proxy). */
  isJson: boolean;
  /** JSON decodificado como veio (ex.: listas); null se vazio ou inválido. */
  data: unknown;
}

export interface FetchJsonOptions {
  timeoutMs: number;
  /** Cancelamento externo (AbortController de quem chama). */
  signal?: AbortSignal;
}

/** Faz a requisição e lê o corpo JSON dentro do prazo. Falhas viram HttpRequestError. */
export async function fetchJson(url: string, init: RequestInit, { timeoutMs, signal }: FetchJsonOptions): Promise<JsonResponse> {
  if (signal?.aborted) throw new HttpRequestError('aborted');

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const failure = (): HttpRequestError => new HttpRequestError(timedOut ? 'timeout' : signal?.aborted ? 'aborted' : 'network');

  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch {
      throw failure();
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw failure();
    }
    // Abortado depois da leitura (corrida com o timer): trata como cancelado.
    if (timedOut || signal?.aborted) throw failure();

    let data: unknown = null;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      data = null;
    }
    const isJson = typeof data === 'object' && data !== null && !Array.isArray(data);
    return { status: response.status, ok: response.ok, body: isJson ? (data as Record<string, unknown>) : {}, isJson, data };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

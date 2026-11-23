import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, HTTP_TIMEOUTS, HttpRequestError } from '@/lib/http';

/*
 * M2: utilitário comum das chamadas HTTP do cliente. O prazo cobre a requisição inteira
 * (cabeçalhos e corpo) e o cancelamento externo é distinguido do timeout.
 */

const signals: AbortSignal[] = [];
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/** fetch que só termina quando abortado (servidor que não responde). */
function hangingFetch() {
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    signals.push(init.signal!);
    return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(abortError())));
  });
}

async function failure(promise: Promise<unknown>): Promise<HttpRequestError> {
  try {
    await promise;
  } catch (error) {
    return error as HttpRequestError;
  }
  throw new Error('esperava falha');
}

beforeEach(() => {
  signals.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchJson', () => {
  it('prazos padrão: troca de código com folga para o cold start; dado opcional curto', () => {
    expect(HTTP_TIMEOUTS.tokenExchange).toBe(30_000);
    expect(HTTP_TIMEOUTS.legal).toBe(20_000);
    expect(HTTP_TIMEOUTS.optional).toBe(5_000);
    expect(HTTP_TIMEOUTS.tokenExchange).toBeGreaterThan(10_000); // o servidor espera o Discord até 10 s
  });

  it('sucesso: devolve status, corpo JSON e limpa o timer', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: 1 }), { status: 201 }));
    const result = await fetchJson('/x', {}, { timeoutMs: 1_000 });
    expect(result).toEqual({ status: 201, ok: true, body: { ok: 1 }, isJson: true, data: { ok: 1 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('corpo não JSON (página de erro de proxy), vazio ou lista: body vazio e isJson=false', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect(await fetchJson('/x', {}, { timeoutMs: 1_000 })).toMatchObject({ status: 502, ok: false, body: {}, isJson: false, data: null });
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }));
    expect(await fetchJson('/x', {}, { timeoutMs: 1_000 })).toMatchObject({ body: {}, isJson: false, data: null });
    vi.stubGlobal('fetch', async () => new Response('[1,2]', { status: 200 }));
    expect(await fetchJson('/x', {}, { timeoutMs: 1_000 })).toMatchObject({ body: {}, isJson: false, data: [1, 2] });
  });

  it('sem resposta dentro do prazo: aborta a requisição e falha com "timeout"', async () => {
    hangingFetch();
    const pending = failure(fetchJson('/x', {}, { timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBeInstanceOf(HttpRequestError);
    expect(error.kind).toBe('timeout');
    expect(signals[0]!.aborted).toBe(true);
  });

  it('cabeçalhos chegam mas o corpo trava: o prazo também vale para o corpo', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init.signal!.addEventListener('abort', () => controller.error(abortError()));
        },
      });
      return new Response(body, { status: 200 });
    });
    const pending = failure(fetchJson('/x', {}, { timeoutMs: 2_000 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).kind).toBe('timeout');
  });

  it('cancelamento externo: falha com "aborted" (não é timeout) e limpa o timer', async () => {
    hangingFetch();
    const controller = new AbortController();
    const pending = failure(fetchJson('/x', {}, { timeoutMs: 5_000, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect((await pending).kind).toBe('aborted');
    expect(signals[0]!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sinal já cancelado: não chega a chamar o fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const controller = new AbortController();
    controller.abort();
    expect((await failure(fetchJson('/x', {}, { timeoutMs: 1_000, signal: controller.signal }))).kind).toBe('aborted');
    expect(spy).not.toHaveBeenCalled();
  });

  it('falha de rede (sem conexão, CSP): "network"', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await failure(fetchJson('/x', {}, { timeoutMs: 1_000 }))).kind).toBe('network');
  });

  it('repassa método, cabeçalhos e corpo, e usa o próprio sinal de cancelamento', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response('{}', { status: 200 });
    });
    await fetchJson('/x', { method: 'POST', headers: { A: 'b' }, body: '{}' }, { timeoutMs: 1_000 });
    expect(seen[0]).toMatchObject({ method: 'POST', headers: { A: 'b' }, body: '{}' });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});

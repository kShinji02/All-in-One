import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeCodeForToken, fetchCurrentGuild } from '@/discord/api';
import { DiscordSessionError, requiresReload } from '@/discord/errors';
import { HTTP_TIMEOUTS } from '@/lib/http';

/*
 * Compatibilidade do fluxo OAuth do client com as respostas de POST /api/token,
 * inclusive o 429 do rate limit da fase 4.9 (sem mudança visual: vira
 * token_exchange_failed, que já oferece "Tentar novamente").
 */

const respond = (status: number, body: unknown) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as DiscordSessionError;
  }
  throw new Error('esperava falha');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** fetch que só termina quando abortado (backend acordando, proxy travado). */
function hangingFetch() {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    signals.push(init.signal!);
    return new Promise<Response>((_, reject) =>
      init.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))),
    );
  });
  return signals;
}

describe('exchangeCodeForToken × POST /api/token', () => {
  it('sucesso devolve o access_token', async () => {
    respond(200, { access_token: 'token-1' });
    await expect(exchangeCodeForToken('codigo')).resolves.toBe('token-1');
  });

  it('429 rate_limited vira token_exchange_failed com o motivo (botão "Tentar novamente")', async () => {
    respond(429, { error: 'rate_limited', retryAfterMs: 42_000, message: 'Muitas tentativas' });
    const error = await failure(exchangeCodeForToken('codigo'));
    expect(error).toBeInstanceOf(DiscordSessionError);
    expect(error.code).toBe('token_exchange_failed');
    expect(error.detail).toBe('HTTP 429 · rate_limited');
  });

  it('erros conhecidos continuam com o mesmo mapeamento', async () => {
    respond(500, { error: 'server_misconfigured' });
    expect((await failure(exchangeCodeForToken('c'))).code).toBe('server_misconfigured');
    respond(400, { error: 'token_exchange_failed', discordError: 'invalid_grant' });
    expect((await failure(exchangeCodeForToken('c'))).detail).toBe('HTTP 400 · invalid_grant');
    respond(502, { error: 'discord_unreachable' });
    expect((await failure(exchangeCodeForToken('c'))).code).toBe('token_exchange_failed');
  });
});

describe('M2: prazos da troca de código e do nome do servidor', () => {
  it('/api/token sem resposta em 30 s → backend_timeout (com "Tentar novamente", sem recarregar)', async () => {
    vi.useFakeTimers();
    const signals = hangingFetch();
    const pending = failure(exchangeCodeForToken('codigo'));
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUTS.tokenExchange - 1);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error).toBeInstanceOf(DiscordSessionError);
    expect(error.code).toBe('backend_timeout');
    expect(error.detail).toBe('sem resposta em 30 s');
    expect(error.message).toMatch(/pode estar sendo iniciado/i);
    expect(requiresReload(error.code)).toBe(false);
    expect(signals[0]!.aborted).toBe(true);
  });

  it('falha de rede continua backend_unreachable; 502/503/504 sem o JSON do backend viram backend_unavailable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await failure(exchangeCodeForToken('c'))).code).toBe('backend_unreachable');
    for (const status of [502, 503, 504]) {
      vi.stubGlobal('fetch', async () => new Response('<html>Bad Gateway</html>', { status }));
      const error = await failure(exchangeCodeForToken('c'));
      expect(error.code, String(status)).toBe('backend_unavailable');
      expect(error.detail).toBe(`HTTP ${status}`);
    }
    // Outras respostas fora do formato do backend (ex.: 404 de um proxy mal configurado).
    vi.stubGlobal('fetch', async () => new Response('<html>Not Found</html>', { status: 404 }));
    expect((await failure(exchangeCodeForToken('c'))).code).toBe('backend_unreachable');
    // JSON do backend com 502 (Discord fora): continua token_exchange_failed.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'discord_unreachable' }), { status: 502 }));
    expect((await failure(exchangeCodeForToken('c'))).code).toBe('token_exchange_failed');
  });

  it('nome do servidor: sem resposta em 5 s vira null e não trava a sessão', async () => {
    vi.useFakeTimers();
    const signals = hangingFetch();
    const pending = fetchCurrentGuild('tok', '1');
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUTS.optional);
    await expect(pending).resolves.toBeNull();
    expect(signals[0]!.aborted).toBe(true);
  });

  it('nome do servidor: lista válida encontra o servidor; resposta inválida vira null', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{ id: '1', name: 'Servidor', icon: null }]), { status: 200 }));
    await expect(fetchCurrentGuild('tok', '1')).resolves.toMatchObject({ id: '1', name: 'Servidor' });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'x' }), { status: 200 }));
    await expect(fetchCurrentGuild('tok', '1')).resolves.toBeNull();
  });
});

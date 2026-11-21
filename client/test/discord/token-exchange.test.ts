import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeCodeForToken } from '@/discord/api';
import { DiscordSessionError } from '@/discord/errors';

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
});

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

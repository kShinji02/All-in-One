import { describe, expect, it } from 'vitest';
import { DiscordSessionError, requiresReload, type DiscordErrorCode } from '@/discord/errors';

const ALL_CODES: DiscordErrorCode[] = [
  'ready_timeout',
  'sdk_init_failed',
  'authorize_failed',
  'server_misconfigured',
  'token_exchange_failed',
  'backend_unreachable',
  'authenticate_failed',
];

describe('mensagens de erro (C2/C3)', () => {
  it('backend indisponível orienta a iniciar o servidor', () => {
    const { message } = new DiscordSessionError('backend_unreachable');
    expect(message).toContain('npm run dev');
    expect(message).toContain('server/');
  });

  it('servidor sem credenciais orienta a preencher o .env e reiniciar', () => {
    const { message } = new DiscordSessionError('server_misconfigured');
    expect(message).toContain('.env');
    expect(message).toMatch(/reinicie o backend/i);
  });

  it('timeout do handshake não afirma que o Discord recusou a conexão', () => {
    const { message } = new DiscordSessionError('ready_timeout');
    expect(message).toMatch(/não respondeu/i);
    expect(message).not.toMatch(/recus/i);
    expect(message).toMatch(/recarregue a activity/i);
  });

  it('todo código tem mensagem e o detalhe técnico é preservado separadamente', () => {
    for (const code of ALL_CODES) {
      const error = new DiscordSessionError(code, 'HTTP 500');
      expect(error.message.length).toBeGreaterThan(10);
      expect(error.code).toBe(code);
      expect(error.detail).toBe('HTTP 500');
    }
  });
});

describe('requiresReload (C3)', () => {
  it('exige recarregar só quando o handshake não pode ser repetido pela mesma instância', () => {
    expect(requiresReload('ready_timeout')).toBe(true);
    expect(requiresReload('sdk_init_failed')).toBe(true);
  });

  it('erros depois do handshake usam "Tentar novamente" (refaz o fluxo sem recarregar)', () => {
    for (const code of ALL_CODES.filter((c) => c !== 'ready_timeout' && c !== 'sdk_init_failed')) {
      expect(requiresReload(code), code).toBe(false);
    }
    expect(requiresReload('unexpected')).toBe(false);
  });
});

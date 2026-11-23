import { describe, expect, it } from 'vitest';
import { describeSessionError, DiscordSessionError, isTransientSessionError, requiresReload, type DiscordErrorCode } from '@/discord/errors';

const ALL_CODES: DiscordErrorCode[] = [
  'ready_timeout',
  'sdk_init_failed',
  'authorize_failed',
  'server_misconfigured',
  'token_exchange_failed',
  'backend_unreachable',
  'backend_timeout',
  'backend_unavailable',
  'authenticate_failed',
];

describe('mensagens de erro (C2/C3)', () => {
  it('em PRODUÇÃO nenhuma mensagem traz comandos, arquivos, variáveis ou termos internos', () => {
    for (const code of ALL_CODES) {
      const message = describeSessionError(code, { isDev: false });
      expect(message, code).not.toMatch(/npm|server\/|\.env|VITE_|DISCORD_|backend|Express|handshake|OAuth|SDK|Vite/i);
    }
  });

  it('em DESENVOLVIMENTO, a orientação técnica é acrescentada (backend local, .env)', () => {
    expect(describeSessionError('backend_unreachable', { isDev: true })).toContain('npm run dev');
    expect(describeSessionError('backend_unreachable', { isDev: true })).toContain('server/');
    expect(describeSessionError('server_misconfigured', { isDev: true })).toContain('.env');
    expect(describeSessionError('server_misconfigured', { isDev: true })).toMatch(/reinicie o backend/i);
    expect(describeSessionError('backend_unreachable', { isDev: false })).not.toContain('npm run dev');
  });

  it('servidor acordando (502/503/504 ou prazo) explica que é passageiro, sem pedir ação técnica', () => {
    expect(describeSessionError('backend_unavailable', { isDev: false })).toMatch(/iniciando ou temporariamente indisponível/i);
    expect(describeSessionError('backend_timeout', { isDev: false })).toMatch(/pode estar sendo iniciado/i);
  });

  it('só falhas passageiras do servidor são repetidas automaticamente', () => {
    const transient = ALL_CODES.filter((code) => isTransientSessionError(code));
    expect(transient.sort()).toEqual(['backend_timeout', 'backend_unavailable', 'backend_unreachable']);
    expect(isTransientSessionError('unexpected')).toBe(false);
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

import { describe, expect, it } from 'vitest';
import { classifyClose, SERVER_CLOSE_REASONS, type CloseCategory } from '@/realtime/chat-close-codes';

describe('classifyClose — fechamentos do servidor', () => {
  const expected: Array<[number, string, CloseCategory, boolean]> = [
    [4008, 'auth_timeout', 'transient', true],
    [1013, 'discord_unavailable', 'transient', true],
    [4029, 'too_many_frames', 'transient', true],
    [4001, 'invalid_token', 'session_expired', false],
    [4001, 'auth_failed', 'transient', true],
    [4001, 'auth_required', 'session_expired', false],
    [4003, 'not_in_instance', 'left_instance', false],
    [4003, 'instance_not_found', 'left_instance', false],
    [4029, 'too_many_connections', 'limit', false],
    [4029, 'room_full', 'limit', false],
    [4001, 'auth_unavailable', 'unavailable', false],
    [1011, 'server_misconfigured', 'unavailable', false],
    [4000, 'invalid_json', 'protocol', false],
    [4000, 'invalid_message', 'protocol', false],
    [4000, 'binary_not_supported', 'protocol', false],
    [4000, 'invalid_auth', 'protocol', false],
    [4000, 'auth_in_progress', 'protocol', false],
    [4000, 'invalid_instance', 'protocol', false],
  ];

  for (const [code, reason, category, reconnect] of expected) {
    it(`${code} ${reason} → ${category}${reconnect ? ' (reconecta)' : ' (para)'}`, () => {
      expect(classifyClose(code, reason)).toEqual({ category, reconnect });
    });
  }

  it('a tabela tem exatamente os 18 pares acima', () => {
    expect(Object.keys(SERVER_CLOSE_REASONS).sort()).toEqual(expected.map(([, reason]) => reason).sort());
  });

  it('só a categoria "transient" reconecta', () => {
    for (const [reason, { code, category }] of Object.entries(SERVER_CLOSE_REASONS)) {
      expect(classifyClose(code, reason).reconnect, reason).toBe(category === 'transient');
    }
  });
});

describe('classifyClose — códigos padrão e casos sem motivo', () => {
  it('1006 (queda de rede ou terminate) reconecta', () => {
    expect(classifyClose(1006, '')).toEqual({ category: 'transient', reconnect: true });
  });

  it('1001 (servidor reiniciando) e 1012 reconectam', () => {
    expect(classifyClose(1001, '').reconnect).toBe(true);
    expect(classifyClose(1012, '').reconnect).toBe(true);
  });

  it('1000 (encerrado pelo próprio cliente) não reconecta', () => {
    expect(classifyClose(1000, '')).toEqual({ category: 'client_closed', reconnect: false });
  });

  it('1009 (frame acima do limite) é erro de protocolo e não reconecta', () => {
    expect(classifyClose(1009, '')).toEqual({ category: 'protocol', reconnect: false });
  });

  it('1011 sem motivo é indisponibilidade e não reconecta', () => {
    expect(classifyClose(1011, '')).toEqual({ category: 'unavailable', reconnect: false });
  });

  it('código da aplicação com motivo desconhecido não reconecta (evita laço)', () => {
    expect(classifyClose(4999, 'novo_motivo')).toEqual({ category: 'protocol', reconnect: false });
    expect(classifyClose(4001, '')).toEqual({ category: 'protocol', reconnect: false });
  });

  it('motivo conhecido com código divergente é classificado pelo código, não pelo motivo', () => {
    // "auth_timeout" (que reconectaria) chegando com 4003 não pode virar reconexão.
    expect(classifyClose(4003, 'auth_timeout')).toEqual({ category: 'protocol', reconnect: false });
    // "invalid_token" com 1006 é tratado como queda.
    expect(classifyClose(1006, 'invalid_token')).toEqual({ category: 'transient', reconnect: true });
  });
});

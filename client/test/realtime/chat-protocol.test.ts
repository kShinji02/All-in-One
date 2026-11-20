import { describe, expect, it } from 'vitest';
import {
  encodeAuth,
  encodeSend,
  HISTORY_LIMIT,
  MAX_SERVER_FRAME_BYTES,
  parseServerFrame,
  type ParseFailure,
} from '@/realtime/chat-protocol';

const AUTHOR = {
  id: '205519959982473217',
  username: 'ana',
  displayName: 'Ana',
  avatarUrl: 'https://cdn.discordapp.com/avatars/205519959982473217/a1b2c3.png?size=128',
};
const MESSAGE = {
  id: '3b241101-e2bb-4255-8caf-4136c566a962',
  author: AUTHOR,
  text: 'Olá!',
  createdAt: '2026-11-19T12:00:00.000Z',
};

const raw = (value: unknown) => JSON.stringify(value);
const parse = (value: unknown) => parseServerFrame(raw(value));
function expectFailure(input: string | unknown, reason: ParseFailure, detail?: string) {
  const result = typeof input === 'string' ? parseServerFrame(input) : parse(input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe(reason);
    if (detail !== undefined) expect(result.detail).toBe(detail);
  }
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('parseServerFrame — todos os tipos válidos', () => {
  it('ready', () => {
    expect(parse({ type: 'ready', self: AUTHOR })).toEqual({ ok: true, frame: { type: 'ready', self: AUTHOR } });
  });

  it('history vazio e com mensagens, incluindo nonce próprio (4.1)', () => {
    expect(parse({ type: 'history', messages: [] })).toEqual({ ok: true, frame: { type: 'history', messages: [] } });
    const own = { ...MESSAGE, nonce: 'n-1' };
    expect(parse({ type: 'history', messages: [MESSAGE, own] })).toEqual({
      ok: true,
      frame: { type: 'history', messages: [MESSAGE, own] },
    });
  });

  it('history no limite de 100 mensagens', () => {
    const messages = Array.from({ length: HISTORY_LIMIT }, () => MESSAGE);
    expect(parse({ type: 'history', messages }).ok).toBe(true);
  });

  it('message com e sem nonce (confirmação ou reenvio idempotente)', () => {
    expect(parse({ type: 'message', message: MESSAGE })).toEqual({ ok: true, frame: { type: 'message', message: MESSAGE } });
    expect(parse({ type: 'message', message: MESSAGE, nonce: 'abc_123-X' })).toEqual({
      ok: true,
      frame: { type: 'message', message: MESSAGE, nonce: 'abc_123-X' },
    });
  });

  it('rate_limited com e sem nonce', () => {
    expect(parse({ type: 'rate_limited', retryAfterMs: 4_200 })).toEqual({ ok: true, frame: { type: 'rate_limited', retryAfterMs: 4_200 } });
    expect(parse({ type: 'rate_limited', retryAfterMs: 1, nonce: 'n6' })).toEqual({
      ok: true,
      frame: { type: 'rate_limited', retryAfterMs: 1, nonce: 'n6' },
    });
  });

  it('error com cada código conhecido, com e sem nonce', () => {
    for (const code of ['empty_message', 'invalid_message', 'invalid_nonce', 'message_too_long', 'unsupported_message']) {
      expect(parse({ type: 'error', code })).toEqual({ ok: true, frame: { type: 'error', code, known: true } });
    }
    expect(parse({ type: 'error', code: 'message_too_long', nonce: 'n' })).toEqual({
      ok: true,
      frame: { type: 'error', code: 'message_too_long', known: true, nonce: 'n' },
    });
  });

  it('error com código futuro é aceito, mas marcado como desconhecido', () => {
    expect(parse({ type: 'error', code: 'novo_codigo_futuro' })).toEqual({
      ok: true,
      frame: { type: 'error', code: 'novo_codigo_futuro', known: false },
    });
  });

  it('texto no limite: 500 caracteres, contando emoji como 1', () => {
    expect(parse({ type: 'message', message: { ...MESSAGE, text: 'a'.repeat(500) } }).ok).toBe(true);
    expect(parse({ type: 'message', message: { ...MESSAGE, text: '😀'.repeat(500) } }).ok).toBe(true);
  });
});

describe('parseServerFrame — frames malformados', () => {
  it('entrada que não é texto (binário, null, número)', () => {
    for (const value of [new ArrayBuffer(4), new Uint8Array([1]), null, undefined, 42, {}]) {
      const result = parseServerFrame(value);
      expect(result).toEqual({ ok: false, reason: 'not_text' });
    }
  });

  it('JSON inválido', () => {
    for (const text of ['', '{', '{type:"ready"}', 'undefined', "{'type':'ready'}"]) expectFailure(text, 'invalid_json');
  });

  it('JSON que não é objeto com type textual', () => {
    for (const text of ['null', '42', '"ready"', '[]', '[{"type":"ready"}]', '{}', '{"type":1}', '{"type":null}']) {
      expectFailure(text, 'not_object');
    }
  });
});

describe('parseServerFrame — tipos desconhecidos', () => {
  it('rejeita tipos que o servidor não envia, inclusive frames do próprio cliente', () => {
    for (const type of ['foo', 'auth', 'send', 'READY', 'Message', 'ping', '']) {
      expectFailure({ type, message: MESSAGE }, 'unknown_type', type);
    }
  });

  it('o detalhe do tipo desconhecido é truncado', () => {
    const result = parse({ type: 'x'.repeat(200) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toHaveLength(64);
  });
});

describe('parseServerFrame — campos obrigatórios ausentes', () => {
  const cases: Array<[string, unknown, string]> = [
    ['ready sem self', { type: 'ready' }, 'self'],
    ['self sem id', { type: 'ready', self: { ...AUTHOR, id: undefined } }, 'self.id'],
    ['self sem username', { type: 'ready', self: { ...AUTHOR, username: undefined } }, 'self.username'],
    ['self sem displayName', { type: 'ready', self: { ...AUTHOR, displayName: undefined } }, 'self.displayName'],
    ['self sem avatarUrl', { type: 'ready', self: { ...AUTHOR, avatarUrl: undefined } }, 'self.avatarUrl'],
    ['history sem messages', { type: 'history' }, 'messages'],
    ['message sem message', { type: 'message' }, 'message'],
    ['message sem id', { type: 'message', message: { ...MESSAGE, id: undefined } }, 'message.id'],
    ['message sem author', { type: 'message', message: { ...MESSAGE, author: undefined } }, 'message.author'],
    ['message sem text', { type: 'message', message: { ...MESSAGE, text: undefined } }, 'message.text'],
    ['message sem createdAt', { type: 'message', message: { ...MESSAGE, createdAt: undefined } }, 'message.createdAt'],
    ['rate_limited sem retryAfterMs', { type: 'rate_limited' }, 'retryAfterMs'],
    ['error sem code', { type: 'error' }, 'code'],
    ['mensagem do histórico sem author', { type: 'history', messages: [MESSAGE, { ...MESSAGE, author: undefined }] }, 'messages[1].author'],
  ];
  for (const [name, frame, path] of cases) {
    it(name, () => expectFailure(frame, 'invalid_fields', path));
  }
});

describe('parseServerFrame — tipos incorretos', () => {
  const cases: Array<[string, unknown, string]> = [
    ['self como texto', { type: 'ready', self: 'Ana' }, 'self'],
    ['self como lista', { type: 'ready', self: [AUTHOR] }, 'self'],
    ['id do autor numérico', { type: 'ready', self: { ...AUTHOR, id: 205519959982473217 } }, 'self.id'],
    ['messages como objeto', { type: 'history', messages: { 0: MESSAGE } }, 'messages'],
    ['mensagem nula no histórico', { type: 'history', messages: [null] }, 'messages[0]'],
    ['text numérico', { type: 'message', message: { ...MESSAGE, text: 42 } }, 'message.text'],
    ['createdAt numérico', { type: 'message', message: { ...MESSAGE, createdAt: 1_790_000_000_000 } }, 'message.createdAt'],
    ['nonce numérico', { type: 'message', message: MESSAGE, nonce: 123 }, 'nonce'],
    ['nonce nulo', { type: 'message', message: MESSAGE, nonce: null }, 'nonce'],
    ['retryAfterMs texto', { type: 'rate_limited', retryAfterMs: '4200' }, 'retryAfterMs'],
    ['retryAfterMs fracionário', { type: 'rate_limited', retryAfterMs: 1.5 }, 'retryAfterMs'],
    ['code numérico', { type: 'error', code: 400 }, 'code'],
  ];
  for (const [name, frame, path] of cases) {
    it(name, () => expectFailure(frame, 'invalid_fields', path));
  }
});

describe('parseServerFrame — dados excessivos ou inválidos', () => {
  it('frame acima do teto defensivo', () => {
    expectFailure(' '.repeat(MAX_SERVER_FRAME_BYTES + 1), 'too_large');
  });

  const cases: Array<[string, unknown, string]> = [
    ['texto com 501 caracteres', { type: 'message', message: { ...MESSAGE, text: 'a'.repeat(501) } }, 'message.text'],
    ['texto com 501 emoji', { type: 'message', message: { ...MESSAGE, text: '😀'.repeat(501) } }, 'message.text'],
    ['texto vazio', { type: 'message', message: { ...MESSAGE, text: '' } }, 'message.text'],
    ['histórico com 101 mensagens', { type: 'history', messages: Array.from({ length: HISTORY_LIMIT + 1 }, () => MESSAGE) }, 'messages.length'],
    ['username enorme', { type: 'ready', self: { ...AUTHOR, username: 'x'.repeat(101) } }, 'self.username'],
    ['displayName vazio', { type: 'ready', self: { ...AUTHOR, displayName: '' } }, 'self.displayName'],
    ['id do autor não numérico', { type: 'ready', self: { ...AUTHOR, id: 'admin' } }, 'self.id'],
    ['id do autor com 21 dígitos', { type: 'ready', self: { ...AUTHOR, id: '1'.repeat(21) } }, 'self.id'],
    ['avatar fora do CDN do Discord', { type: 'ready', self: { ...AUTHOR, avatarUrl: 'https://evil.com/a.png' } }, 'self.avatarUrl'],
    ['avatar javascript:', { type: 'ready', self: { ...AUTHOR, avatarUrl: 'javascript:alert(1)' } }, 'self.avatarUrl'],
    ['avatar com http', { type: 'ready', self: { ...AUTHOR, avatarUrl: 'http://cdn.discordapp.com/a.png' } }, 'self.avatarUrl'],
    ['avatar com domínio parecido', { type: 'ready', self: { ...AUTHOR, avatarUrl: 'https://cdn.discordapp.com.evil.com/a.png' } }, 'self.avatarUrl'],
    ['id da mensagem fora do formato UUID', { type: 'message', message: { ...MESSAGE, id: 'forjado' } }, 'message.id'],
    ['createdAt inválido', { type: 'message', message: { ...MESSAGE, createdAt: 'ontem' } }, 'message.createdAt'],
    ['createdAt sem formato ISO', { type: 'message', message: { ...MESSAGE, createdAt: 'Thu, 19 Nov 2026 12:00:00 GMT' } }, 'message.createdAt'],
    ['nonce com caracteres proibidos', { type: 'message', message: MESSAGE, nonce: '<script>' }, 'nonce'],
    ['nonce com 65 caracteres', { type: 'message', message: MESSAGE, nonce: 'n'.repeat(65) }, 'nonce'],
    ['nonce inválido no histórico', { type: 'history', messages: [{ ...MESSAGE, nonce: 'com espaço' }] }, 'messages[0].nonce'],
    ['retryAfterMs zero', { type: 'rate_limited', retryAfterMs: 0 }, 'retryAfterMs'],
    ['retryAfterMs negativo', { type: 'rate_limited', retryAfterMs: -1 }, 'retryAfterMs'],
    ['retryAfterMs acima de 60 s', { type: 'rate_limited', retryAfterMs: 60_001 }, 'retryAfterMs'],
    ['code com maiúsculas', { type: 'error', code: 'Invalid' }, 'code'],
    ['code com espaço', { type: 'error', code: 'invalid message' }, 'code'],
    ['code longo demais', { type: 'error', code: 'a'.repeat(65) }, 'code'],
  ];
  for (const [name, frame, path] of cases) {
    it(name, () => expectFailure(frame, 'invalid_fields', path));
  }
});

describe('parseServerFrame — saída limpa e robustez', () => {
  it('descarta campos desconhecidos em todos os níveis', () => {
    const noisy = {
      type: 'message',
      extra: 1,
      message: { ...MESSAGE, html: '<b>x</b>', author: { ...AUTHOR, email: 'a@b.c', accessToken: 'segredo' } },
    };
    const result = parse(noisy);
    expect(result).toEqual({ ok: true, frame: { type: 'message', message: MESSAGE } });
    expect(JSON.stringify(result)).not.toContain('segredo');
  });

  it('__proto__ no JSON não contamina objetos', () => {
    const result = parseServerFrame('{"type":"ready","self":' + raw(AUTHOR).slice(0, -1) + ',"__proto__":{"polluted":true}},"__proto__":{"polluted":true}}');
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (result.ok && result.frame.type === 'ready') expect(Object.getPrototypeOf(result.frame.self)).toBe(Object.prototype);
  });

  it('não devolve as referências recebidas (as listas e objetos são novos)', () => {
    const input = { type: 'history', messages: [clone(MESSAGE)] };
    const text = raw(input);
    const a = parseServerFrame(text);
    const b = parseServerFrame(text);
    expect(a).toEqual(b);
    if (a.ok && b.ok && a.frame.type === 'history' && b.frame.type === 'history') {
      expect(a.frame.messages).not.toBe(b.frame.messages);
    }
  });

  it('nunca lança erro, para nenhuma entrada (varredura com valores arbitrários)', () => {
    const atoms: unknown[] = [null, true, 0, -1, 1.5, NaN, '', 'x', [], {}, [null], { type: 'message' }, AUTHOR, MESSAGE];
    const shapes = ['ready', 'history', 'message', 'rate_limited', 'error', 'foo'];
    let checked = 0;
    for (const type of shapes) {
      for (const a of atoms) {
        for (const b of atoms) {
          const frames = [
            { type, self: a, messages: [a, b], message: a, retryAfterMs: a, code: a, nonce: b },
            { type, self: { ...AUTHOR, id: a, avatarUrl: b }, message: { ...MESSAGE, author: a, text: b }, messages: a },
          ];
          for (const frame of frames) {
            expect(() => parseServerFrame(JSON.stringify(frame))).not.toThrow();
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(shapes.length * atoms.length * atoms.length * 2);
  });
});

describe('encodeAuth / encodeSend', () => {
  it('auth tem exatamente os campos esperados pelo servidor', () => {
    expect(JSON.parse(encodeAuth('tok', 'i-1-gc-2-3'))).toEqual({ type: 'auth', accessToken: 'tok', instanceId: 'i-1-gc-2-3' });
  });

  it('send com e sem nonce', () => {
    expect(JSON.parse(encodeSend('oi'))).toEqual({ type: 'send', text: 'oi' });
    expect(JSON.parse(encodeSend('oi', 'n-1'))).toEqual({ type: 'send', text: 'oi', nonce: 'n-1' });
  });

  it('nonce inválido é erro de programação e lança', () => {
    for (const nonce of ['', 'com espaço', '<x>', 'n'.repeat(65)]) expect(() => encodeSend('oi', nonce)).toThrow();
  });
});

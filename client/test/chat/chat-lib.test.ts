import { describe, expect, it } from 'vitest';
import { describeChatStatus, describeFailure } from '@/features/chat/lib/chat-status';
import { dayLabel, GROUP_WINDOW_MS, groupMessages } from '@/features/chat/lib/group-messages';
import { linkify } from '@/features/chat/lib/linkify';
import type { ChatEntry } from '@/realtime/message-store';

describe('linkify', () => {
  it('texto sem URL fica intacto, inclusive HTML (nunca interpretado)', () => {
    expect(linkify('<b>oi</b> <img src=x onerror=alert(1)>')).toEqual([{ type: 'text', text: '<b>oi</b> <img src=x onerror=alert(1)>' }]);
  });

  it('http e https viram link; o restante continua texto', () => {
    expect(linkify('veja https://discord.com/a?b=1#c e http://ex.com')).toEqual([
      { type: 'text', text: 'veja ' },
      { type: 'link', text: 'https://discord.com/a?b=1#c', href: 'https://discord.com/a?b=1#c' },
      { type: 'text', text: ' e ' },
      { type: 'link', text: 'http://ex.com', href: 'http://ex.com/' },
    ]);
  });

  it('esquemas perigosos nunca viram link', () => {
    for (const text of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'ftp://ex.com']) {
      expect(linkify(text).every((s) => s.type === 'text')).toBe(true);
    }
  });

  it('pontuação final fica fora do link; parênteses balanceados ficam dentro', () => {
    expect(linkify('fim https://ex.com/a.')[1]).toMatchObject({ href: 'https://ex.com/a' });
    expect(linkify('(ver https://ex.com/x)')).toEqual([
      { type: 'text', text: '(ver ' },
      { type: 'link', text: 'https://ex.com/x', href: 'https://ex.com/x' },
      { type: 'text', text: ')' },
    ]);
    expect(linkify('https://pt.wikipedia.org/wiki/A_(b)')[0]).toMatchObject({ type: 'link', text: 'https://pt.wikipedia.org/wiki/A_(b)' });
  });

  it('aspas e < > encerram a URL (não dá para injetar atributos)', () => {
    expect(linkify('https://ex.com/"onmouseover="x')[0]).toMatchObject({ type: 'link', href: 'https://ex.com/' });
  });

  it('URL sem host não vira link', () => {
    expect(linkify('https://')).toEqual([{ type: 'text', text: 'https://' }]);
  });
});

const entry = (key: string, authorId: string, minute: number, own = false): ChatEntry => ({
  key,
  status: 'sent',
  id: key,
  nonce: null,
  text: key,
  author: { id: authorId, username: authorId, displayName: authorId, avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' },
  own,
  createdAt: new Date(Date.UTC(2026, 10, 20, 12, 0, 0) + minute * 60_000).toISOString(),
  attempts: 0,
  failure: null,
});

describe('groupMessages', () => {
  const now = new Date(Date.UTC(2026, 10, 20, 18, 0, 0));

  it('agrupa mensagens seguidas do mesmo autor e separa autores diferentes', () => {
    const groups = groupMessages([entry('a1', 'a', 0), entry('a2', 'a', 1), entry('b1', 'b', 2), entry('a3', 'a', 3)], null, now);
    expect(groups.map((g) => g.messages.map((m) => m.key))).toEqual([['a1', 'a2'], ['b1'], ['a3']]);
    expect(groups.map((g) => g.key)).toEqual(['a1', 'b1', 'a3']);
  });

  it('intervalo maior que a janela inicia outro grupo', () => {
    const gap = GROUP_WINDOW_MS / 60_000 + 1;
    expect(groupMessages([entry('a1', 'a', 0), entry('a2', 'a', gap)], null, now)).toHaveLength(2);
  });

  it('mensagem local logo antes de uma confirmada (relógios diferentes) continua no grupo', () => {
    const local = { ...entry('l', 'a', 2, true), status: 'pending' as const, id: null };
    expect(groupMessages([entry('c', 'a', 3, true), local], null, now)).toHaveLength(1);
  });

  it('novo dia inicia grupo com rótulo; o primeiro grupo também recebe o rótulo', () => {
    // Datas locais: o rótulo do dia segue o fuso do usuário.
    const at = (date: Date) => ({ ...entry('x', 'a', 0), createdAt: date.toISOString() });
    const yesterday = { ...at(new Date(2026, 10, 19, 22, 0)), key: 'y' };
    const today = { ...at(new Date(2026, 10, 20, 9, 0)), key: 't' };
    const groups = groupMessages([yesterday, today], null, new Date(2026, 10, 20, 18, 0));
    expect(groups.map((g) => g.dayLabel)).toEqual(['Ontem', 'Hoje']);
  });

  it('rótulos de dia', () => {
    const today = new Date(2026, 10, 20, 15);
    expect(dayLabel(new Date(2026, 10, 20, 1), today)).toBe('Hoje');
    expect(dayLabel(new Date(2026, 10, 19, 23), today)).toBe('Ontem');
    expect(dayLabel(new Date(2026, 9, 3), today)).toBe('3 de outubro');
    expect(dayLabel(new Date(2025, 9, 3), today)).toBe('3 de outubro de 2025');
  });
});

describe('describeChatStatus', () => {
  const base = { isReady: false, isLoading: true, error: null };

  it('mapeia cada estado da conexão para um rótulo', () => {
    expect(describeChatStatus({ ...base, connectionState: { status: 'connecting', attempt: 1 } }).label).toBe('Conectando');
    expect(describeChatStatus({ ...base, connectionState: { status: 'authenticating', attempt: 1 } }).label).toBe('Autenticando');
    const self = { id: '1', username: 'a', displayName: 'A', avatarUrl: 'https://cdn.discordapp.com/x.png' };
    expect(describeChatStatus({ ...base, connectionState: { status: 'ready', self } }).label).toBe('Carregando histórico');
    expect(describeChatStatus({ isReady: true, isLoading: false, error: null, connectionState: { status: 'ready', self } })).toMatchObject({
      label: 'Conectado',
      tone: 'ok',
      banner: null,
      composerDisabledReason: null,
    });
  });

  it('sem sessão: indisponível e campo desabilitado', () => {
    expect(describeChatStatus({ isReady: false, isLoading: false, error: null, connectionState: { status: 'idle' } })).toMatchObject({
      label: 'Indisponível',
      banner: null,
    });
    expect(describeChatStatus({ isReady: false, isLoading: false, error: null, connectionState: { status: 'idle' } }).composerDisabledReason).toBeTruthy();
  });

  it('reconectando: aviso com "Tentar agora" e campo habilitado', () => {
    const view = describeChatStatus({
      ...base,
      connectionState: { status: 'reconnecting', attempt: 2, delayMs: 500, lastClose: { code: 1006, reason: '', category: 'transient' } },
    });
    expect(view).toMatchObject({ label: 'Reconectando', banner: { action: { kind: 'reconnect' } }, composerDisabledReason: null });
  });

  it.each([
    ['session_expired', 'reload', true],
    ['left_instance', 'reload', true],
    ['limit', 'reconnect', false],
    ['unavailable', 'reconnect', true],
    ['retries_exhausted', 'reconnect', false],
    ['protocol', 'reconnect', false],
    ['client_closed', 'reconnect', false],
  ] as const)('parada %s → ação %s, campo desabilitado: %s', (reason, action, disabled) => {
    const view = describeChatStatus({
      isReady: false,
      isLoading: false,
      error: { reason, closeCode: 4000 },
      connectionState: { status: 'stopped', reason, lastClose: null },
    });
    expect(view.banner?.action?.kind).toBe(action);
    expect(view.composerDisabledReason !== null).toBe(disabled);
  });

  it('describeFailure usa o código do servidor quando conhecido', () => {
    expect(describeFailure({ reason: 'rejected', code: 'message_too_long', retryable: false })).toBe('passou de 500 caracteres');
    expect(describeFailure({ reason: 'rejected', code: 'codigo_futuro', retryable: false })).toBe('recusada pelo servidor');
    expect(describeFailure({ reason: 'timeout', code: null, retryable: true })).toBe('o servidor não respondeu');
  });
});

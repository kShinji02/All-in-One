import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConnectionState } from '@/realtime/chat-connection';
import { HISTORY_LIMIT, type ChatAuthor, type ChatMessage, type ServerFrame } from '@/realtime/chat-protocol';
import {
  ACK_TIMEOUT_MS,
  createMessageStore,
  MAX_OUTSTANDING,
  MAX_SEND_ATTEMPTS,
  type ChatEntry,
  type MessageStoreOptions,
} from '@/realtime/message-store';

/* ------------------------------------------------------------------ *
 * Apoio
 * ------------------------------------------------------------------ */
const ANA: ChatAuthor = { id: '205519959982473217', username: 'ana', displayName: 'Ana', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' };
const BRUNO: ChatAuthor = { id: '175928847299117063', username: 'bruno', displayName: 'Bruno', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png' };

let idCounter = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function msg(text: string, opts: { author?: ChatAuthor; at?: number; id?: string; nonce?: string } = {}): ChatMessage {
  const m: ChatMessage = {
    id: opts.id ?? uuid(++idCounter),
    author: opts.author ?? BRUNO,
    text,
    createdAt: new Date(Date.UTC(2026, 10, 20, 12, 0, 0) + (opts.at ?? idCounter) * 1_000).toISOString(),
  };
  if (opts.nonce) m.nonce = opts.nonce;
  return m;
}

const READY: ChatConnectionState = { status: 'ready', self: ANA };
const RECONNECTING: ChatConnectionState = {
  status: 'reconnecting',
  attempt: 2,
  delayMs: 500,
  lastClose: { code: 1006, reason: '', category: 'transient' },
};
const STOPPED: ChatConnectionState = {
  status: 'stopped',
  reason: 'session_expired',
  lastClose: { code: 4001, reason: 'invalid_token', category: 'session_expired' },
};

function setup(overrides: Partial<MessageStoreOptions> = {}) {
  const sent: { text: string; nonce: string }[] = [];
  const transport = { accept: true, send: vi.fn((text: string, nonce: string) => (transport.accept ? (sent.push({ text, nonce }), true) : false)) };
  let n = 0;
  const store = createMessageStore({
    transport,
    generateNonce: () => `nonce-${++n}`,
    now: () => Date.UTC(2026, 10, 20, 13, 0, 0),
    ...overrides,
  });
  const notify = vi.fn();
  store.subscribe(notify);
  const frame = (f: ServerFrame) => store.handleFrame(f);
  /** Como a ChatConnection entrega: estado ready → frame ready → frame history. */
  const openRoom = (history: ChatMessage[] = []) => {
    store.handleConnectionState(READY);
    frame({ type: 'ready', self: ANA });
    frame({ type: 'history', messages: history });
  };
  const drop = (state: ChatConnectionState = RECONNECTING) => store.handleConnectionState(state);
  const list = () => store.getSnapshot().messages;
  const texts = () => list().map((m) => m.text);
  const byText = (text: string) => list().filter((m) => m.text === text);
  return { store, transport, sent, notify, frame, openRoom, drop, list, texts, byText };
}

/** Confirmação do servidor para a conexão que enviou. */
const confirm = (text: string, nonce: string, extra: { id?: string; at?: number } = {}): ServerFrame => ({
  type: 'message',
  message: msg(text, { author: ANA, ...extra }),
  nonce,
});

beforeEach(() => {
  idCounter = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * Histórico, ordem e deduplicação
 * ------------------------------------------------------------------ */
describe('histórico, ordem e deduplicação', () => {
  it('histórico entra em ordem cronológica, mesmo fora de ordem; empate mantém a chegada', () => {
    const { openRoom, texts, list } = setup();
    openRoom([msg('c', { at: 30 }), msg('a', { at: 10 }), msg('b1', { at: 20 }), msg('b2', { at: 20 })]);
    expect(texts()).toEqual(['a', 'b1', 'b2', 'c']);
    expect(list().every((m) => m.status === 'sent' && m.id !== null)).toBe(true);
  });

  it('mensagem em tempo real é inserida na posição cronológica', () => {
    const { openRoom, frame, texts } = setup();
    openRoom([msg('a', { at: 10 }), msg('c', { at: 30 })]);
    frame({ type: 'message', message: msg('b', { at: 20 }) });
    expect(texts()).toEqual(['a', 'b', 'c']);
  });

  it('deduplica por id: histórico repetido e mensagem repetida em tempo real', () => {
    const { openRoom, frame, texts, notify } = setup();
    const a = msg('a');
    const b = msg('b');
    openRoom([a, b]);
    frame({ type: 'history', messages: [a, b] });
    frame({ type: 'message', message: b });
    frame({ type: 'message', message: { ...b } });
    expect(texts()).toEqual(['a', 'b']);
    // Frames sem mudança não notificam.
    const calls = notify.mock.calls.length;
    frame({ type: 'message', message: b });
    expect(notify).toHaveBeenCalledTimes(calls);
  });

  it('novo histórico (reconexão) mescla com o que já está na lista, sem duplicar', () => {
    const { openRoom, drop, texts } = setup();
    const a = msg('a', { at: 1 });
    const b = msg('b', { at: 2 });
    const c = msg('c', { at: 3 });
    openRoom([a, b]);
    drop();
    openRoom([b, c]);
    expect(texts()).toEqual(['a', 'b', 'c']);
  });

  it(`mantém só as ${HISTORY_LIMIT} confirmadas mais recentes`, () => {
    const { openRoom, frame, texts, list } = setup();
    openRoom(Array.from({ length: HISTORY_LIMIT }, (_, i) => msg(`m${i}`, { at: i })));
    for (let i = HISTORY_LIMIT; i < HISTORY_LIMIT + 5; i += 1) frame({ type: 'message', message: msg(`m${i}`, { at: i }) });
    expect(list()).toHaveLength(HISTORY_LIMIT);
    expect(texts()[0]).toBe('m5');
    expect(texts().at(-1)).toBe(`m${HISTORY_LIMIT + 4}`);
  });

  it('pendentes não contam no limite e não são descartadas por ele', () => {
    const { store, openRoom, frame, list } = setup();
    openRoom(Array.from({ length: HISTORY_LIMIT }, (_, i) => msg(`m${i}`, { at: i })));
    store.handleConnectionState(RECONNECTING);
    store.send('ainda pendente');
    frame({ type: 'message', message: msg('extra', { at: 999 }) });
    expect(list()).toHaveLength(HISTORY_LIMIT + 1);
    expect(list().at(-1)).toMatchObject({ text: 'ainda pendente', status: 'pending' });
  });

  it('marca como próprias as mensagens do usuário do "ready"', () => {
    const { openRoom, list } = setup();
    openRoom([msg('minha', { author: ANA }), msg('dele', { author: BRUNO })]);
    expect(list().map((m) => [m.text, m.own])).toEqual([
      ['minha', true],
      ['dele', false],
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Envio otimista e reconciliação por nonce
 * ------------------------------------------------------------------ */
describe('envio otimista e reconciliação por nonce', () => {
  it('entra na lista na hora como pending e é entregue à conexão com um nonce', () => {
    const { store, openRoom, list, sent, notify } = setup();
    openRoom();
    notify.mockClear();
    const result = store.send('  olá  ');

    expect(result).toEqual({ ok: true, key: 'l:nonce-1', nonce: 'nonce-1' });
    expect(sent).toEqual([{ text: 'olá', nonce: 'nonce-1' }]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(list()).toEqual([
      {
        key: 'l:nonce-1',
        status: 'pending',
        id: null,
        nonce: 'nonce-1',
        text: 'olá',
        author: ANA,
        own: true,
        createdAt: '2026-11-20T13:00:00.000Z',
        attempts: 1,
        failure: null,
      },
    ]);
  });

  it('entregue ao socket não é "sent": só a confirmação do servidor muda o estado', () => {
    const { store, openRoom, list } = setup();
    openRoom();
    store.send('oi');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS - 1);
    expect(list()[0]!.status).toBe('pending');
  });

  it('a confirmação com o nonce substitui a otimista: uma única entrada, mesma chave', () => {
    const { store, openRoom, frame, list, byText } = setup();
    openRoom();
    store.send('oi');
    const optimistic = list()[0]!;
    frame(confirm('oi', 'nonce-1', { id: uuid(500) }));

    expect(byText('oi')).toHaveLength(1);
    expect(list()).toHaveLength(1);
    expect(list()[0]).toMatchObject({ key: optimistic.key, status: 'sent', id: uuid(500), nonce: 'nonce-1', attempts: 1 });
    expect(vi.getTimerCount()).toBe(0); // prazo da confirmação cancelado
  });

  it('o texto confirmado é o normalizado pelo servidor', () => {
    const { store, openRoom, frame, list } = setup();
    openRoom();
    store.send('a\r\nb');
    frame(confirm('a\nb', 'nonce-1'));
    expect(list().map((m) => m.text)).toEqual(['a\nb']);
  });

  it('confirmação repetida (mesmo id e nonce) não gera segunda entrada', () => {
    const { store, openRoom, frame, list } = setup();
    openRoom();
    store.send('oi');
    const c = confirm('oi', 'nonce-1');
    frame(c);
    frame(c);
    expect(list()).toHaveLength(1);
  });

  it('confirmação de mensagem que já está na lista (veio antes no histórico) não duplica', () => {
    const { store, openRoom, drop, frame, list } = setup();
    openRoom();
    store.send('oi');
    drop();
    const published = msg('oi', { author: ANA, nonce: 'nonce-1' });
    openRoom([published]); // histórico já traz a mensagem com o próprio nonce
    frame({ type: 'message', message: { ...published, nonce: undefined } as ChatMessage, nonce: 'nonce-1' });
    expect(list()).toHaveLength(1);
    expect(list()[0]).toMatchObject({ key: 'l:nonce-1', status: 'sent', id: published.id });
  });

  it('a mesma mensagem chegando em broadcast (sem nonce) depois da confirmação não duplica', () => {
    const { store, openRoom, frame, list } = setup();
    openRoom();
    store.send('oi');
    const c = confirm('oi', 'nonce-1');
    frame(c);
    if (c.type !== 'message') throw new Error();
    frame({ type: 'message', message: c.message });
    expect(list()).toHaveLength(1);
  });

  it('nonce de outro autor não reconcilia a mensagem local', () => {
    const { store, openRoom, frame, list } = setup();
    openRoom();
    store.send('oi');
    frame({ type: 'message', message: msg('oi', { author: BRUNO }), nonce: 'nonce-1' });
    expect(list().map((m) => [m.text, m.status, m.own])).toEqual([
      ['oi', 'sent', false],
      ['oi', 'pending', true],
    ]);
  });

  it('várias mensagens pendentes reconciliam cada uma pelo seu nonce, em qualquer ordem', () => {
    const { store, openRoom, frame, list } = setup();
    openRoom();
    store.send('um');
    store.send('dois');
    store.send('três');
    frame(confirm('dois', 'nonce-2', { at: 2 }));
    frame(confirm('um', 'nonce-1', { at: 1 }));
    expect(list().map((m) => [m.text, m.status])).toEqual([
      ['um', 'sent'],
      ['dois', 'sent'],
      ['três', 'pending'],
    ]);
  });

  it('a chave das entradas não muda e entradas inalteradas mantêm a mesma referência', () => {
    const { store, openRoom, frame, list } = setup();
    openRoom([msg('antiga', { at: 0 })]);
    const old = list()[0]!;
    store.send('oi');
    frame(confirm('oi', 'nonce-1', { at: 10 }));
    expect(list()[0]).toBe(old);
    expect(list()[1]!.key).toBe('l:nonce-1');
  });
});

/* ------------------------------------------------------------------ *
 * Queda de conexão, reconexão e reenvio com o mesmo nonce
 * ------------------------------------------------------------------ */
describe('queda de conexão e reconexão', () => {
  it('enviada sem conexão: fica pending e só é entregue depois do histórico da sala', () => {
    const { store, frame, sent, list } = setup();
    store.send('offline');
    expect(sent).toEqual([]);
    expect(list()[0]).toMatchObject({ status: 'pending', attempts: 0, author: null });

    store.handleConnectionState(READY);
    frame({ type: 'ready', self: ANA });
    expect(sent).toEqual([]); // "ready" sozinho não basta: o histórico pode já conter a mensagem
    frame({ type: 'history', messages: [] });
    expect(sent).toEqual([{ text: 'offline', nonce: 'nonce-1' }]);
    expect(list()[0]!.author).toEqual(ANA);
  });

  it('queda antes da confirmação: a mensagem continua pending', () => {
    const { store, openRoom, drop, list } = setup();
    openRoom();
    store.send('oi');
    drop();
    expect(list()).toHaveLength(1);
    expect(list()[0]).toMatchObject({ status: 'pending', attempts: 1 });
    vi.advanceTimersByTime(10 * ACK_TIMEOUT_MS); // sem prazo correndo sem conexão
    expect(list()[0]!.status).toBe('pending');
  });

  it('reconexão com o histórico contendo o próprio nonce: confirma sem reenviar', () => {
    const { store, openRoom, drop, list, sent } = setup();
    openRoom();
    store.send('oi');
    drop();
    openRoom([msg('oi', { author: ANA, nonce: 'nonce-1' })]);
    expect(sent).toHaveLength(1);
    expect(list()).toHaveLength(1);
    expect(list()[0]).toMatchObject({ key: 'l:nonce-1', status: 'sent', nonce: 'nonce-1' });
  });

  it('reconexão sem o nonce no histórico: reenvia com o MESMO nonce e confirma uma vez', () => {
    const { store, openRoom, drop, frame, list, sent } = setup();
    openRoom();
    store.send('oi');
    drop();
    openRoom([msg('outra', { at: 0 })]);
    expect(sent).toEqual([
      { text: 'oi', nonce: 'nonce-1' },
      { text: 'oi', nonce: 'nonce-1' },
    ]);
    expect(list().at(-1)).toMatchObject({ status: 'pending', attempts: 2 });

    // O servidor (idempotente) responde com a mensagem original.
    frame(confirm('oi', 'nonce-1', { at: 5 }));
    expect(list().map((m) => [m.text, m.status])).toEqual([
      ['outra', 'sent'],
      ['oi', 'sent'],
    ]);
  });

  it('reenvio de resultado desconhecido: se o servidor já tinha publicado, a resposta e o histórico seguinte não duplicam', () => {
    const { store, openRoom, drop, frame, list } = setup();
    openRoom();
    store.send('oi');
    drop();
    openRoom(); // histórico vazio (ex.: sala recriada) → reenvia com o mesmo nonce
    const original = msg('oi', { author: ANA, id: uuid(900), at: 1 });
    frame({ type: 'message', message: original, nonce: 'nonce-1' });
    drop();
    openRoom([{ ...original, nonce: 'nonce-1' }]);
    expect(list()).toHaveLength(1);
    expect(list()[0]).toMatchObject({ id: uuid(900), status: 'sent' });
  });

  it('não presume confirmação após reconectar: sem evidência, continua pending', () => {
    const { store, openRoom, drop, list } = setup();
    openRoom();
    store.send('oi');
    drop();
    openRoom();
    expect(list()[0]!.status).toBe('pending');
  });

  it(`reenvio automático limitado: após ${MAX_SEND_ATTEMPTS} entregas sem prova, vira failed (unconfirmed)`, () => {
    const { store, openRoom, drop, list, sent } = setup();
    openRoom();
    store.send('oi');
    for (let i = 1; i < MAX_SEND_ATTEMPTS; i += 1) {
      drop();
      openRoom();
    }
    expect(sent).toHaveLength(MAX_SEND_ATTEMPTS);
    drop();
    openRoom();
    expect(sent).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(list()[0]).toMatchObject({ status: 'failed', failure: { reason: 'unconfirmed', code: null, retryable: true } });
    drop();
    openRoom();
    expect(sent).toHaveLength(MAX_SEND_ATTEMPTS); // nada de laço
  });

  it('retry manual de uma failed reutiliza o nonce original', () => {
    const { store, openRoom, drop, frame, list, sent } = setup();
    openRoom();
    store.send('oi');
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) {
      drop();
      openRoom();
    }
    const key = list()[0]!.key;
    expect(store.retry(key)).toBe(true);
    expect(sent.at(-1)).toEqual({ text: 'oi', nonce: 'nonce-1' });
    expect(new Set(sent.map((s) => s.nonce))).toEqual(new Set(['nonce-1']));
    expect(list()[0]).toMatchObject({ key, status: 'pending', attempts: 1, failure: null });
    frame(confirm('oi', 'nonce-1'));
    expect(list()).toHaveLength(1);
    expect(list()[0]!.status).toBe('sent');
  });

  it('retry com a conexão fora do ar fica pending e é entregue após o próximo histórico', () => {
    const { store, openRoom, drop, sent, list } = setup();
    openRoom();
    store.send('oi');
    drop(STOPPED);
    const before = sent.length;
    store.retry(list()[0]!.key);
    expect(sent).toHaveLength(before);
    expect(list()[0]!.status).toBe('pending');
    openRoom();
    expect(sent).toHaveLength(before + 1);
  });

  it('retry entre o "ready" e o "history" espera o histórico, que pode já provar a publicação', () => {
    const { store, openRoom, drop, frame, sent, list } = setup();
    openRoom();
    store.send('oi');
    drop(STOPPED); // failed: connection_lost, resultado desconhecido
    store.handleConnectionState(READY);
    frame({ type: 'ready', self: ANA });

    expect(store.retry(list()[0]!.key)).toBe(true);
    expect(sent).toHaveLength(1); // nada antes do histórico
    frame({ type: 'history', messages: [msg('oi', { author: ANA, nonce: 'nonce-1' })] });
    expect(sent).toHaveLength(1); // o histórico confirmou: não reenviou
    expect(list()).toHaveLength(1);
    expect(list()[0]).toMatchObject({ key: 'l:nonce-1', status: 'sent' });
  });

  it('envio novo entre o "ready" e o "history" também espera o histórico', () => {
    const { store, frame, sent } = setup();
    store.handleConnectionState(READY);
    frame({ type: 'ready', self: ANA });
    store.send('cedo');
    expect(sent).toEqual([]);
    frame({ type: 'history', messages: [] });
    expect(sent).toEqual([{ text: 'cedo', nonce: 'nonce-1' }]);
  });

  it('transport recusando (socket indisponível) mantém pending sem contar tentativa', () => {
    const { store, openRoom, transport, list } = setup();
    openRoom();
    transport.accept = false;
    store.send('oi');
    expect(list()[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('transport que lança não derruba a store', () => {
    const { store, openRoom, transport, list } = setup();
    openRoom();
    transport.send.mockImplementationOnce(() => {
      throw new Error('socket fechado');
    });
    expect(store.send('oi').ok).toBe(true);
    expect(list()[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * Falhas
 * ------------------------------------------------------------------ */
describe('falhas', () => {
  it('erro do servidor com o nonce: failed definitivo, sem retry', () => {
    const { store, openRoom, frame, list, sent } = setup();
    openRoom();
    store.send('oi');
    frame({ type: 'error', code: 'message_too_long', known: true, nonce: 'nonce-1' });
    expect(list()[0]).toMatchObject({ status: 'failed', failure: { reason: 'rejected', code: 'message_too_long', retryable: false } });
    expect(store.retry(list()[0]!.key)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('erro sem nonce não é atribuído a nenhuma mensagem', () => {
    const { store, openRoom, frame, list } = setup();
    openRoom();
    store.send('oi');
    frame({ type: 'error', code: 'unsupported_message', known: true });
    expect(list()[0]!.status).toBe('pending');
  });

  it('conexão parada de vez: pendentes viram failed (connection_lost) e podem ser reenviadas', () => {
    const { store, openRoom, drop, list } = setup();
    openRoom();
    store.send('a');
    drop();
    store.send('b');
    drop(STOPPED);
    expect(list().map((m) => [m.text, m.status, m.failure?.reason])).toEqual([
      ['a', 'failed', 'connection_lost'],
      ['b', 'failed', 'connection_lost'],
    ]);
    expect(list().every((m) => m.failure?.retryable)).toBe(true);
  });

  it('sem resposta no prazo com a conexão aberta: failed (timeout); confirmação tardia ainda reconcilia', () => {
    const { store, openRoom, frame, list } = setup();
    openRoom();
    store.send('oi');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    expect(list()[0]).toMatchObject({ status: 'failed', failure: { reason: 'timeout', retryable: true } });
    frame(confirm('oi', 'nonce-1'));
    expect(list()).toHaveLength(1);
    expect(list()[0]).toMatchObject({ key: 'l:nonce-1', status: 'sent' });
  });

  it('rate_limited: reenvia uma vez após retryAfterMs, com o mesmo nonce', () => {
    const { store, openRoom, frame, sent, list } = setup();
    openRoom();
    store.send('oi');
    frame({ type: 'rate_limited', retryAfterMs: 2_000, nonce: 'nonce-1' });
    expect(list()[0]!.status).toBe('pending');
    vi.advanceTimersByTime(1_999);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([
      { text: 'oi', nonce: 'nonce-1' },
      { text: 'oi', nonce: 'nonce-1' },
    ]);
  });

  it(`rate_limited repetido: para em ${MAX_SEND_ATTEMPTS} tentativas (failed rate_limited)`, () => {
    const { store, openRoom, frame, sent, list } = setup();
    openRoom();
    store.send('oi');
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) {
      frame({ type: 'rate_limited', retryAfterMs: 1_000, nonce: 'nonce-1' });
      vi.advanceTimersByTime(1_000);
    }
    expect(sent).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(list()[0]).toMatchObject({ status: 'failed', failure: { reason: 'rate_limited', retryable: true } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('queda durante a espera do rate limit: cancela o timer; o histórico seguinte decide', () => {
    const { store, openRoom, drop, frame, sent } = setup();
    openRoom();
    store.send('oi');
    frame({ type: 'rate_limited', retryAfterMs: 5_000, nonce: 'nonce-1' });
    drop();
    expect(vi.getTimerCount()).toBe(0);
    openRoom();
    expect(sent).toHaveLength(2);
  });

  it('discard remove só mensagens failed', () => {
    const { store, openRoom, frame, list } = setup();
    openRoom();
    store.send('ok');
    store.send('ruim');
    frame({ type: 'error', code: 'empty_message', known: true, nonce: 'nonce-2' });
    expect(store.discard('l:nonce-1')).toBe(false); // pendente
    expect(store.discard('l:nonce-2')).toBe(true);
    expect(list().map((m) => m.text)).toEqual(['ok']);
  });
});

/* ------------------------------------------------------------------ *
 * Validação local, assinaturas, recursos e isolamento
 * ------------------------------------------------------------------ */
describe('validação local', () => {
  it('vazio e acima do limite não entram na lista nem vão ao servidor', () => {
    const { store, openRoom, sent, list } = setup();
    openRoom();
    expect(store.send('   \n ')).toEqual({ ok: false, reason: 'empty' });
    expect(store.send('😀'.repeat(501))).toEqual({ ok: false, reason: 'too_long' });
    expect(store.send('😀'.repeat(500)).ok).toBe(true); // 500 code points
    expect(sent).toHaveLength(1);
    expect(list()).toHaveLength(1);
  });

  it(`no máximo ${MAX_OUTSTANDING} mensagens locais ao mesmo tempo`, () => {
    const { store } = setup();
    for (let i = 0; i < MAX_OUTSTANDING; i += 1) expect(store.send(`m${i}`).ok).toBe(true);
    expect(store.send('excedente')).toEqual({ ok: false, reason: 'too_many_pending' });
  });

  it('gerador de nonce inválido ou repetido é erro de programação', () => {
    const { store } = setup({ generateNonce: () => 'mesmo' });
    store.send('a');
    expect(() => store.send('b')).toThrow(/nonce/);
    const { store: bad } = setup({ generateNonce: () => 'com espaço' });
    expect(() => bad.send('a')).toThrow(/nonce/);
  });

  it('o gerador padrão produz nonces válidos e distintos', () => {
    const store = createMessageStore({ transport: { send: () => true } });
    const a = store.send('a');
    const b = store.send('b');
    expect(a.ok && b.ok && a.nonce !== b.nonce).toBe(true);
    if (a.ok) expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    store.dispose();
  });
});

describe('assinaturas, recursos e isolamento', () => {
  it('subscribe notifica mudanças; unsubscribe para de notificar', () => {
    const { store, openRoom } = setup();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    openRoom([msg('a')]);
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    store.send('b');
    expect(listener).not.toHaveBeenCalled();
  });

  it('getSnapshot devolve a mesma referência enquanto nada muda', () => {
    const { store, openRoom, frame } = setup();
    openRoom([msg('a')]);
    const first = store.getSnapshot();
    frame({ type: 'history', messages: [] });
    frame({ type: 'error', code: 'unsupported_message', known: true });
    expect(store.getSnapshot()).toBe(first);
    expect(Object.isFrozen(first.messages)).toBe(true);
  });

  it('dispose cancela todos os timers, remove assinaturas e ignora chamadas posteriores', () => {
    const { store, openRoom, frame, notify, sent } = setup();
    openRoom();
    store.send('a'); // prazo de confirmação
    store.send('b');
    frame({ type: 'rate_limited', retryAfterMs: 3_000, nonce: 'nonce-2' }); // timer de reenvio
    expect(vi.getTimerCount()).toBe(2);
    const snapshot = store.getSnapshot();

    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
    notify.mockClear();
    frame(confirm('a', 'nonce-1'));
    store.handleConnectionState(RECONNECTING);
    expect(store.send('c')).toEqual({ ok: false, reason: 'disposed' });
    expect(store.retry('l:nonce-1')).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(notify).not.toHaveBeenCalled();
    expect(sent).toHaveLength(2);
    expect(store.getSnapshot()).toBe(snapshot);
    expect(store.subscribe(() => undefined)).toBeTypeOf('function');
  });

  it('stores de instâncias diferentes são independentes', () => {
    const one = setup();
    const two = setup();
    one.openRoom([msg('na sala 1')]);
    two.openRoom([msg('na sala 2')]);
    one.store.send('só na 1');
    expect(one.texts()).toEqual(['na sala 1', 'só na 1']);
    expect(two.texts()).toEqual(['na sala 2']);
    expect(two.sent).toEqual([]);
  });

  it('não usa localStorage/sessionStorage nem escreve em log', () => {
    const storage = [vi.spyOn(Storage.prototype, 'setItem'), vi.spyOn(Storage.prototype, 'getItem')];
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    const { store, openRoom, frame } = setup();
    openRoom([msg('a')]);
    store.send('segredo');
    frame({ type: 'error', code: 'empty_message', known: true, nonce: 'nonce-1' });
    for (const spy of [...storage, ...logs]) expect(spy).not.toHaveBeenCalled();
  });
});

/** Garante que a lista nunca tem duas entradas para a mesma mensagem (id ou nonce). */
function assertNoDuplicates(list: readonly ChatEntry[]) {
  const ids = list.flatMap((m) => (m.id ? [m.id] : []));
  const nonces = list.flatMap((m) => (m.nonce ? [m.nonce] : []));
  const keys = list.map((m) => m.key);
  expect(new Set(ids).size).toBe(ids.length);
  expect(new Set(nonces).size).toBe(nonces.length);
  expect(new Set(keys).size).toBe(keys.length);
}

describe('invariante: nenhum roteiro produz duplicatas', () => {
  it('sequência mista de envios, quedas, históricos, confirmações e duplicatas', () => {
    const { store, openRoom, drop, frame, list } = setup();
    const x = msg('x', { at: 0 });
    openRoom([x]);
    store.send('a');
    store.send('b');
    frame(confirm('a', 'nonce-1', { id: uuid(700), at: 1 }));
    drop();
    store.send('c');
    openRoom([msg('a', { author: ANA, id: uuid(700), at: 1, nonce: 'nonce-1' }), x]);
    frame(confirm('b', 'nonce-2', { id: uuid(701), at: 2 }));
    frame(confirm('b', 'nonce-2', { id: uuid(701), at: 2 }));
    frame(confirm('c', 'nonce-3', { id: uuid(702), at: 3 }));
    drop();
    openRoom([
      msg('a', { author: ANA, id: uuid(700), at: 1, nonce: 'nonce-1' }),
      msg('b', { author: ANA, id: uuid(701), at: 2, nonce: 'nonce-2' }),
      msg('c', { author: ANA, id: uuid(702), at: 3, nonce: 'nonce-3' }),
    ]);
    assertNoDuplicates(list());
    expect(list().map((m) => [m.text, m.status])).toEqual([
      ['x', 'sent'],
      ['a', 'sent'],
      ['b', 'sent'],
      ['c', 'sent'],
    ]);
    expect(list().slice(1).map((m) => m.key)).toEqual(['l:nonce-1', 'l:nonce-2', 'l:nonce-3']);
  });
});

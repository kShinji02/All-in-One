import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatUrl,
  createChatConnection,
  HANDSHAKE_TIMEOUT_MS,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  reconnectDelay,
  type ChatConnectionOptions,
  type ChatConnectionState,
} from '@/realtime/chat-connection';
import type { ServerFrame } from '@/realtime/chat-protocol';
import { acceptConnection, FakeSocket, message, readyFrame, SELF } from './fake-socket';

const CREDENTIALS = { accessToken: 'token-ana', instanceId: 'i-1-gc-2-3' };
const URL = 'ws://localhost:5173/api/chat';

function setup(overrides: Partial<ChatConnectionOptions> = {}) {
  const states: ChatConnectionState[] = [];
  const frames: ServerFrame[] = [];
  const invalid: string[] = [];
  const connection = createChatConnection({
    url: URL,
    credentials: CREDENTIALS,
    createSocket: (url) => new FakeSocket(url),
    random: () => 0, // menor espera de cada faixa: torna o backoff previsível
    onStateChange: (s) => states.push(s),
    onFrame: (f) => frames.push(f),
    onInvalidFrame: (r) => invalid.push(r),
    ...overrides,
  });
  const status = () => connection.getState().status;
  return { connection, states, frames, invalid, status };
}

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reconnectDelay — backoff exponencial com jitter', () => {
  it('dobra a cada tentativa e respeita o teto', () => {
    const min = [1, 2, 3, 4, 5, 6, 7].map((n) => reconnectDelay(n, () => 0));
    const max = [1, 2, 3, 4, 5, 6, 7].map((n) => reconnectDelay(n, () => 1));
    expect(min).toEqual([500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    expect(max).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('nunca fica abaixo do mínimo nem acima do máximo, mesmo com random fora de [0,1]', () => {
    for (let n = 1; n <= 50; n += 1) {
      for (const r of [-5, 0, 0.37, 0.99, 1, 7]) {
        const delay = reconnectDelay(n, () => r);
        expect(delay).toBeGreaterThanOrEqual(RECONNECT_BASE_DELAY_MS / 2);
        expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
      }
    }
  });

  it('o jitter espalha as esperas dentro da faixa', () => {
    expect(reconnectDelay(3, () => 0.5)).toBe(3_000);
  });
});

describe('chatUrl', () => {
  it('usa wss em https e ws em http, na mesma origem da página', () => {
    expect(chatUrl({ protocol: 'https:', host: '123.discordsays.com' })).toBe('wss://123.discordsays.com/api/chat');
    expect(chatUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/chat');
  });
});

describe('conexão', () => {
  it('não abre nada antes de start()', () => {
    setup();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('conexão bem-sucedida: connecting → authenticating → ready', () => {
    const { connection, states, frames } = setup();
    connection.start();
    expect(FakeSocket.last.url).toBe(URL);
    acceptConnection(FakeSocket.last, [message('oi')]);

    expect(states.map((s) => s.status)).toEqual(['connecting', 'authenticating', 'ready']);
    expect(connection.getState()).toEqual({ status: 'ready', self: SELF });
    expect(frames.map((f) => f.type)).toEqual(['ready', 'history']);
  });

  it('envia exatamente o frame de autenticação do protocolo, uma única vez, ao abrir', () => {
    const { connection } = setup();
    connection.start();
    const socket = FakeSocket.last;
    expect(socket.sent).toEqual([]); // nada antes do open
    socket.serverOpen();
    expect(socket.sent).toEqual([JSON.stringify({ type: 'auth', accessToken: 'token-ana', instanceId: 'i-1-gc-2-3' })]);
  });

  it('entrega os frames válidos já normalizados pelo parser', () => {
    const { connection, frames } = setup();
    connection.start();
    acceptConnection(FakeSocket.last);
    FakeSocket.last.serverSend({ type: 'message', message: { ...message('olá'), extra: 'descartado' }, nonce: 'n-1' });
    FakeSocket.last.serverSend({ type: 'rate_limited', retryAfterMs: 2_000 });
    FakeSocket.last.serverSend({ type: 'error', code: 'empty_message' });

    expect(frames.slice(2)).toEqual([
      { type: 'message', message: message('olá'), nonce: 'n-1' },
      { type: 'rate_limited', retryAfterMs: 2_000 },
      { type: 'error', code: 'empty_message', known: true },
    ]);
  });

  it('frames inválidos são descartados e nunca chegam ao consumidor', () => {
    const { connection, frames, invalid, status } = setup();
    connection.start();
    acceptConnection(FakeSocket.last);
    const before = frames.length;

    FakeSocket.last.serverSendRaw('{não é json');
    FakeSocket.last.serverSendRaw(new ArrayBuffer(4));
    FakeSocket.last.serverSend({ type: 'desconhecido' });
    FakeSocket.last.serverSend({ type: 'message', message: { ...message('x'), author: { ...SELF, avatarUrl: 'https://evil.example/a.png' } } });
    FakeSocket.last.serverSend({ type: 'rate_limited', retryAfterMs: -1 });

    expect(frames).toHaveLength(before);
    expect(invalid).toEqual(['invalid_json', 'not_text', 'unknown_type', 'invalid_fields', 'invalid_fields']);
    expect(status()).toBe('ready'); // a conexão continua
  });

  it('frames fora de ordem (antes do "ready") são descartados', () => {
    const { connection, frames, invalid } = setup();
    connection.start();
    FakeSocket.last.serverOpen();
    FakeSocket.last.serverSend({ type: 'history', messages: [] });
    expect(frames).toEqual([]);
    expect(invalid).toEqual(['invalid_fields']);
  });

  it('start() repetido não cria conexões duplicadas', () => {
    const { connection } = setup();
    connection.start();
    connection.start();
    FakeSocket.last.serverOpen();
    connection.start();
    acceptConnection(FakeSocket.last);
    connection.start();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('start() durante a espera de reconexão não antecipa nem duplica a tentativa', () => {
    const { connection } = setup();
    connection.start();
    FakeSocket.last.networkFailure();
    connection.start();
    connection.start();
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('nunca registra o token em log', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const { connection } = setup();
    connection.start();
    FakeSocket.last.serverOpen();
    FakeSocket.last.serverSendRaw('lixo');
    FakeSocket.last.serverClose(4001, 'invalid_token');
    const logged = spies.flatMap((s) => s.mock.calls).flat().map(String).join(' ');
    expect(logged).not.toContain('token-ana');
  });
});

describe('falhas e reconexão', () => {
  it('falha de conexão (1006) agenda nova tentativa com backoff crescente', () => {
    const { connection, states } = setup();
    connection.start();

    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      FakeSocket.last.networkFailure();
      const s = connection.getState();
      if (s.status !== 'reconnecting') throw new Error(`esperava reconnecting, veio ${s.status}`);
      delays.push(s.delayMs);
      expect(s.lastClose).toEqual({ code: 1006, reason: '', category: 'transient' });
      // Nada é criado antes do fim da espera.
      vi.advanceTimersByTime(s.delayMs - 1);
      expect(FakeSocket.instances).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(i + 2);
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000]);
    expect(states.filter((s) => s.status === 'connecting').map((s) => (s as { attempt: number }).attempt)).toEqual([1, 2, 3, 4, 5]);
  });

  it('o backoff volta ao início depois de um "ready"', () => {
    const { connection } = setup();
    connection.start();
    FakeSocket.last.networkFailure();
    vi.advanceTimersByTime(500);
    FakeSocket.last.networkFailure();
    vi.advanceTimersByTime(1_000);
    acceptConnection(FakeSocket.last);
    FakeSocket.last.serverClose(1001, ''); // servidor reiniciando
    const s = connection.getState();
    expect(s.status === 'reconnecting' && s.delayMs).toBe(500);
  });

  it('abrir o socket sem chegar ao "ready" não zera o backoff (ex.: auth_timeout em laço)', () => {
    const { connection } = setup();
    connection.start();
    FakeSocket.last.serverOpen();
    FakeSocket.last.serverClose(4008, 'auth_timeout');
    vi.advanceTimersByTime(500);
    FakeSocket.last.serverOpen();
    FakeSocket.last.serverClose(4008, 'auth_timeout');
    const s = connection.getState();
    expect(s.status === 'reconnecting' && s.delayMs).toBe(1_000);
  });

  it(`para após ${MAX_RECONNECT_ATTEMPTS} tentativas seguidas sem sucesso (sem laço infinito)`, () => {
    const { connection, status } = setup();
    connection.start();
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS - 1; i += 1) {
      FakeSocket.last.networkFailure();
      vi.runOnlyPendingTimers();
    }
    expect(FakeSocket.instances).toHaveLength(MAX_RECONNECT_ATTEMPTS);
    FakeSocket.last.networkFailure();
    expect(connection.getState()).toMatchObject({ status: 'stopped', reason: 'retries_exhausted' });
    vi.advanceTimersByTime(10 * RECONNECT_MAX_DELAY_MS);
    expect(FakeSocket.instances).toHaveLength(MAX_RECONNECT_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);

    connection.retry(); // ação do usuário recomeça do zero
    expect(status()).toBe('connecting');
    expect(FakeSocket.instances).toHaveLength(MAX_RECONNECT_ATTEMPTS + 1);
  });

  describe('4001: auth_failed é passageiro; invalid_token e auth_required não', () => {
    /** Servidor aceita o socket e recusa o auth com 4001 e o motivo dado. */
    const rejectAuth = (reason: string) => {
      FakeSocket.last.serverOpen();
      FakeSocket.last.serverClose(4001, reason);
    };

    it('auth_failed reconecta com backoff crescente', () => {
      const { connection } = setup();
      connection.start();
      const delays: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        rejectAuth('auth_failed');
        const s = connection.getState();
        if (s.status !== 'reconnecting') throw new Error(`esperava reconnecting, veio ${s.status}`);
        expect(s.lastClose).toEqual({ code: 4001, reason: 'auth_failed', category: 'transient' });
        delays.push(s.delayMs);
        vi.advanceTimersByTime(s.delayMs - 1);
        expect(FakeSocket.instances).toHaveLength(i + 1);
        vi.advanceTimersByTime(1);
        expect(FakeSocket.instances).toHaveLength(i + 2);
      }
      expect(delays).toEqual([500, 1_000, 2_000]);
      acceptConnection(FakeSocket.last);
      expect(connection.getState().status).toBe('ready');
    });

    it(`auth_failed repetido para após ${MAX_RECONNECT_ATTEMPTS} tentativas`, () => {
      const { connection } = setup();
      connection.start();
      for (let i = 0; i < MAX_RECONNECT_ATTEMPTS - 1; i += 1) {
        rejectAuth('auth_failed');
        vi.runOnlyPendingTimers();
      }
      expect(FakeSocket.instances).toHaveLength(MAX_RECONNECT_ATTEMPTS);
      rejectAuth('auth_failed');
      expect(connection.getState()).toEqual({
        status: 'stopped',
        reason: 'retries_exhausted',
        lastClose: { code: 4001, reason: 'auth_failed', category: 'transient' },
      });
      vi.advanceTimersByTime(10 * RECONNECT_MAX_DELAY_MS);
      expect(FakeSocket.instances).toHaveLength(MAX_RECONNECT_ATTEMPTS);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['invalid_token', 'auth_required'])('%s não reconecta (session_expired), mesmo depois de um auth_failed', (reason) => {
      const { connection } = setup();
      connection.start();
      rejectAuth('auth_failed');
      vi.runOnlyPendingTimers();
      rejectAuth(reason);
      expect(connection.getState()).toEqual({
        status: 'stopped',
        reason: 'session_expired',
        lastClose: { code: 4001, reason, category: 'session_expired' },
      });
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10 * RECONNECT_MAX_DELAY_MS);
      expect(FakeSocket.instances).toHaveLength(2);
    });
  });

  it('1013 discord_unavailable e 4029 too_many_frames são passageiros: reconecta', () => {
    for (const [code, reason] of [
      [1013, 'discord_unavailable'],
      [4029, 'too_many_frames'],
      [4008, 'auth_timeout'],
    ] as const) {
      FakeSocket.reset();
      const { connection, status } = setup();
      connection.start();
      FakeSocket.last.serverOpen();
      FakeSocket.last.serverClose(code, reason);
      expect(status()).toBe('reconnecting');
      vi.runOnlyPendingTimers();
      expect(FakeSocket.instances).toHaveLength(2);
      connection.dispose();
    }
  });

  it.each([
    [4001, 'invalid_token', 'session_expired'],
    [4001, 'auth_required', 'session_expired'],
    [4003, 'not_in_instance', 'left_instance'],
    [4003, 'instance_not_found', 'left_instance'],
    [4029, 'too_many_connections', 'limit'],
    [4029, 'room_full', 'limit'],
    [4001, 'auth_unavailable', 'unavailable'],
    [1011, 'server_misconfigured', 'unavailable'],
    [4000, 'invalid_auth', 'protocol'],
    [4999, 'motivo_futuro', 'protocol'],
    [1000, '', 'client_closed'],
  ])('fechamento %i %s → parada definitiva (%s), sem nova tentativa', (code, reason, category) => {
    const { connection } = setup();
    connection.start();
    FakeSocket.last.serverOpen();
    FakeSocket.last.serverClose(code, reason);

    expect(connection.getState()).toEqual({ status: 'stopped', reason: category, lastClose: { code, reason, category } });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * RECONNECT_MAX_DELAY_MS);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('token expirado: não reenvia o mesmo token automaticamente', () => {
    const { connection } = setup();
    connection.start();
    acceptConnection(FakeSocket.last);
    FakeSocket.last.serverClose(4001, 'invalid_token');
    vi.advanceTimersByTime(60_000);
    const authFrames = FakeSocket.instances.flatMap((s) => s.sent).filter((f) => f.includes('"auth"'));
    expect(authFrames).toHaveLength(1);
    expect(connection.getState()).toMatchObject({ status: 'stopped', reason: 'session_expired' });
  });

  it('usuário removido da Activity com a sala aberta: para e não tenta reentrar', () => {
    const { connection, frames } = setup();
    connection.start();
    acceptConnection(FakeSocket.last);
    const before = frames.length;
    FakeSocket.last.serverClose(4003, 'not_in_instance');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(frames).toHaveLength(before);
    expect(connection.getState()).toMatchObject({ status: 'stopped', reason: 'left_instance' });
  });

  it('handshake sem resposta: o cliente desiste no prazo e reconecta', () => {
    const { connection } = setup();
    connection.start();
    const first = FakeSocket.last;
    first.serverOpen(); // servidor aceitou o socket, mas nunca responde ao auth
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 1);
    expect(connection.getState().status).toBe('authenticating');
    vi.advanceTimersByTime(1);
    expect(first.closeCalls).toEqual([{ code: 4900, reason: 'handshake_timeout' }]);
    expect(first.listenerCount()).toBe(0);
    expect(connection.getState()).toMatchObject({ status: 'reconnecting', attempt: 2 });
  });

  it('retry() durante a espera antecipa a tentativa sem duplicar', () => {
    const { connection } = setup();
    connection.start();
    FakeSocket.last.networkFailure();
    connection.retry();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1); // só o prazo do handshake da nova tentativa
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 1); // a espera cancelada não dispara
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('retry() com a conexão ativa não faz nada', () => {
    const { connection } = setup();
    connection.start();
    acceptConnection(FakeSocket.last);
    connection.retry();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('dispose e limpeza', () => {
  it('fecha o socket com 1000, remove todos os listeners e cancela o prazo do handshake', () => {
    const { connection } = setup();
    connection.start();
    const socket = FakeSocket.last;
    expect(socket.listenerCount()).toBe(4);
    expect(vi.getTimerCount()).toBe(1);

    connection.dispose();
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: '' }]);
    expect(socket.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancela a reconexão agendada', () => {
    const { connection } = setup();
    connection.start();
    FakeSocket.last.networkFailure();
    expect(vi.getTimerCount()).toBe(1);
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('depois do dispose, nada mais muda: eventos atrasados, start e retry são ignorados', () => {
    const { connection, states, frames } = setup();
    connection.start();
    const socket = FakeSocket.last;
    socket.serverOpen();
    connection.dispose();
    const statesBefore = states.length;

    socket.serverSend(readyFrame()); // evento que já estava a caminho
    socket.serverClose(1006);
    connection.start();
    connection.retry();
    vi.advanceTimersByTime(60_000);

    expect(states).toHaveLength(statesBefore);
    expect(frames).toEqual([]);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(connection.getState()).toEqual({ status: 'idle' });
  });

  it('um socket substituído não altera o estado do atual', () => {
    const { connection, frames } = setup();
    connection.start();
    const old = FakeSocket.last;
    old.networkFailure();
    vi.runOnlyPendingTimers();
    const current = FakeSocket.last;
    acceptConnection(current);
    const before = frames.length;

    old.serverSend({ type: 'history', messages: [] });
    old.serverClose(4003, 'not_in_instance');
    expect(frames).toHaveLength(before);
    expect(connection.getState().status).toBe('ready');
    expect(old.listenerCount()).toBe(0);
  });

  it('falha ao criar o socket é tratada como falha passageira', () => {
    let calls = 0;
    const { connection, status } = setup({
      createSocket: (url) => {
        calls += 1;
        if (calls === 1) throw new Error('SyntaxError');
        return new FakeSocket(url);
      },
    });
    connection.start();
    expect(status()).toBe('reconnecting');
    vi.runOnlyPendingTimers();
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('send (4.4)', () => {
  it('só escreve com a sala aberta; antes disso devolve false sem tocar no socket', () => {
    const { connection } = setup();
    expect(connection.send('oi', 'n-1')).toBe(false); // sem socket
    connection.start();
    expect(connection.send('oi', 'n-1')).toBe(false); // connecting
    FakeSocket.last.serverOpen();
    expect(connection.send('oi', 'n-1')).toBe(false); // authenticating
    expect(FakeSocket.last.sent).toHaveLength(1); // só o auth
    acceptConnection(FakeSocket.last);
    expect(connection.send('oi', 'n-1')).toBe(true);
    expect(FakeSocket.last.sent.at(-1)).toBe(JSON.stringify({ type: 'send', text: 'oi', nonce: 'n-1' }));
  });

  it('devolve false reconectando, parado ou depois do dispose', () => {
    const { connection } = setup();
    connection.start();
    acceptConnection(FakeSocket.last);
    FakeSocket.last.networkFailure();
    expect(connection.send('oi', 'n-1')).toBe(false);
    vi.runOnlyPendingTimers();
    FakeSocket.last.serverOpen();
    FakeSocket.last.serverClose(4001, 'invalid_token');
    expect(connection.send('oi', 'n-1')).toBe(false);
    connection.dispose();
    expect(connection.send('oi', 'n-1')).toBe(false);
  });

  it('socket que lança no send devolve false', () => {
    const { connection } = setup();
    connection.start();
    acceptConnection(FakeSocket.last);
    vi.spyOn(FakeSocket.last, 'send').mockImplementation(() => {
      throw new Error('InvalidStateError');
    });
    expect(connection.send('oi', 'n-1')).toBe(false);
  });

  it('nonce inválido é erro de programação (lança), mesmo sem conexão', () => {
    const { connection } = setup();
    expect(() => connection.send('oi', 'com espaço')).toThrow(/nonce/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChatConnection,
  HANDSHAKE_TIMEOUT_MS,
  MAX_RECONNECT_ATTEMPTS,
  OFFLINE_PROBE_MS,
  ONLINE_RESET_COOLDOWN_MS,
  RECONNECT_MAX_DELAY_MS,
  STABLE_CONNECTION_MS,
  type ChatConnection,
} from '@/realtime/chat-connection';
import { ACK_TIMEOUT_MS, createMessageStore, type MessageStore } from '@/realtime/message-store';
import { acceptConnection, FakeNetwork, FakeSocket, SELF } from './fake-socket';

/*
 * Rede instável no Discord Mobile. Conexão e store são as REAIS, ligadas como o
 * ChatConnectionProvider liga (estado → store, frames → store, prazo da confirmação →
 * recycle). O WebSocket e a rede do aparelho são simulados.
 *
 * Causas reproduzidas (antes da correção):
 *  A. sockets presos em "connecting" + "online" repetido → o contador zerava a cada evento
 *     e o ciclo "Reconectando…" nunca parava (91 sockets em 30 min);
 *  B. conexões que caíam logo após o "ready" zeravam o contador → ciclo sem fim;
 *  C. um "offline" falso derrubava uma conexão saudável;
 *  D. prazo atrasado pela suspensão do app → falso handshake_timeout.
 */

let network: FakeNetwork;
let connection: ChatConnection;
let store: MessageStore;
/** Maior número de sockets vivos ao mesmo tempo observado no teste. */
let maxLive = 0;

function setup({ withRecycle = true, open = true } = {}) {
  network = new FakeNetwork();
  maxLive = 0;
  let conn: ChatConnection | null = null;
  store = createMessageStore({
    transport: { send: (text, nonce) => conn?.send(text, nonce) ?? false },
    onAckTimeout: withRecycle ? () => conn?.recycle() ?? false : undefined,
  });
  conn = createChatConnection({
    url: 'ws://test/api/chat',
    credentials: { accessToken: 'token-1', instanceId: 'i-1' },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      maxLive = Math.max(maxLive, FakeSocket.live().length);
      return socket;
    },
    random: () => 1, // maior espera de cada faixa (pior caso)
    network,
    onStateChange: (s) => store.handleConnectionState(s),
    onFrame: (f) => store.handleFrame(f),
  });
  connection = conn;
  connection.start();
  if (open) acceptConnection(FakeSocket.last);
}

const status = () => connection.getState().status;
const messages = () => store.getSnapshot().messages.map((m) => [m.text, m.status]);
const sendFrames = () =>
  FakeSocket.instances.flatMap((s) => s.sent.map((raw) => JSON.parse(raw) as { type: string; text?: string; nonce?: string })).filter((f) => f.type === 'send');
const confirmFrame = (text: string, nonce: string) => ({
  type: 'message',
  message: { id: '00000000-0000-4000-8000-000000000001', author: SELF, text, createdAt: '2026-11-20T15:00:00.000Z' },
  nonce,
});
/** Sem rede de verdade: todo socket que tenta abrir falha. */
const failPending = () => {
  const last = FakeSocket.instances.at(-1);
  if (last && last.readyState === 0) last.networkFailure();
};
/** Avança o tempo em passos, derrubando cada tentativa (rede/proxy indisponível). */
function runWithoutService(totalMs: number, step = 1_000) {
  for (let t = 0; t < totalMs; t += step) {
    vi.advanceTimersByTime(step);
    failPending();
  }
}

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  expect(maxLive).toBeLessThanOrEqual(1); // nunca dois WebSockets vivos ao mesmo tempo
  vi.useRealTimers();
});

describe('internet cai e volta (cenário do teste real)', () => {
  it('envia sem internet, rede volta, reconecta, recupera o histórico, publica uma vez e PERMANECE conectado', () => {
    setup();
    network.set(false);
    expect(status()).toBe('ready'); // "offline" sozinho não derruba nada
    FakeSocket.last.networkFailure(); // a queda real chega pelo socket
    expect(status()).toBe('offline');

    store.send('enviada sem internet');
    expect(messages()).toEqual([['enviada sem internet', 'pending']]);

    runWithoutService(60_000);
    network.set(true);
    expect(status()).toBe('connecting');
    acceptConnection(FakeSocket.last, []);
    expect(sendFrames()).toEqual([{ type: 'send', text: 'enviada sem internet', nonce: expect.any(String) }]);
    FakeSocket.last.serverSend(confirmFrame('enviada sem internet', sendFrames()[0]!.nonce!));
    expect(messages()).toEqual([['enviada sem internet', 'sent']]);

    // Permanece conectado: nada mais acontece por 10 minutos.
    const sockets = FakeSocket.instances.length;
    vi.advanceTimersByTime(10 * 60_000);
    expect(status()).toBe('ready');
    expect(FakeSocket.instances).toHaveLength(sockets);
  });

  it('socket meio aberto: a falta de confirmação recicla a conexão; reenvio com o MESMO nonce, publicado uma vez', () => {
    setup();
    store.send('no socket morto');
    const nonce = sendFrames()[0]!.nonce!;
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    expect(FakeSocket.instances[0]!.closeCalls).toEqual([{ code: 4902, reason: 'stalled' }]);
    expect(messages()).toEqual([['no socket morto', 'pending']]);
    vi.runOnlyPendingTimers();
    acceptConnection(FakeSocket.last, []);
    expect(sendFrames().map((f) => f.nonce)).toEqual([nonce, nonce]);
    FakeSocket.last.serverSend(confirmFrame('no socket morto', nonce));
    expect(messages()).toEqual([['no socket morto', 'sent']]);
  });

  it('socket meio aberto, mas o servidor TINHA publicado: o histórico confirma sem reenviar', () => {
    setup();
    store.send('publicada');
    const nonce = sendFrames()[0]!.nonce!;
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    vi.runOnlyPendingTimers();
    acceptConnection(FakeSocket.last, [
      { id: '00000000-0000-4000-8000-000000000009', author: SELF, text: 'publicada', createdAt: '2026-11-20T15:00:00.000Z', nonce },
    ]);
    expect(sendFrames()).toHaveLength(1);
    expect(messages()).toEqual([['publicada', 'sent']]);
  });
});

describe('regressões do ciclo "Reconectando…" sem fim', () => {
  it('A: sockets que nunca abrem + "online" disparado repetidamente → o limite vale e o ciclo PARA', () => {
    setup({ open: false });
    for (let minute = 0; minute < 30; minute += 1) {
      vi.advanceTimersByTime(60_000); // cada tentativa fica presa até o prazo do handshake
      network.set(true); // evento repetido: a rede já estava "online"
    }
    expect(connection.getState()).toMatchObject({ status: 'stopped', reason: 'retries_exhausted' });
    expect(FakeSocket.instances).toHaveLength(MAX_RECONNECT_ATTEMPTS); // antes: 91
    expect(vi.getTimerCount()).toBe(0);
  });

  it('B: conexões que caem logo após o "ready" contam como falha: backoff cresce e o ciclo PARA', () => {
    setup({ open: false });
    const delays: number[] = [];
    for (let i = 0; i < 50 && status() !== 'stopped'; i += 1) {
      acceptConnection(FakeSocket.last);
      vi.advanceTimersByTime(2_000); // abre e cai em 2 s (proxy derrubando, por exemplo)
      FakeSocket.last.networkFailure();
      const s = connection.getState();
      if (s.status === 'reconnecting') delays.push(s.delayMs);
      vi.runOnlyPendingTimers();
    }
    expect(connection.getState()).toMatchObject({ status: 'stopped', reason: 'retries_exhausted' });
    expect(FakeSocket.instances).toHaveLength(MAX_RECONNECT_ATTEMPTS); // antes: 51 e sem fim
    expect(delays).toEqual([...delays].sort((a, b) => a - b)); // espera nunca diminui
    expect(delays.at(-1)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it('B: uma conexão que fica estável zera o contador (quedas esporádicas não acumulam)', () => {
    setup();
    for (let i = 0; i < 3 * MAX_RECONNECT_ATTEMPTS; i += 1) {
      vi.advanceTimersByTime(STABLE_CONNECTION_MS); // ficou aberta tempo suficiente
      FakeSocket.last.networkFailure();
      expect(connection.getState()).toMatchObject({ status: 'reconnecting', attempt: 1 });
      vi.runOnlyPendingTimers();
      acceptConnection(FakeSocket.last);
    }
    expect(status()).toBe('ready');
  });

  it('C: "offline" falso não derruba uma conexão saudável; o chat continua funcionando', () => {
    setup();
    network.set(false);
    network.set(true);
    network.set(false);
    expect(status()).toBe('ready');
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.last.closeCalls).toEqual([]);
    store.send('ainda conectado');
    FakeSocket.last.serverSend(confirmFrame('ainda conectado', sendFrames()[0]!.nonce!));
    expect(messages()).toEqual([['ainda conectado', 'sent']]);
  });

  it('D: prazo do handshake atrasado pela suspensão do app é renovado uma vez (sem falso timeout)', () => {
    setup({ open: false });
    FakeSocket.last.serverOpen();
    vi.setSystemTime(Date.now() + 120_000); // app em segundo plano: relógio anda, timers não
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS); // ao voltar, o timer atrasado dispara
    expect(FakeSocket.last.closeCalls).toEqual([]);
    expect(status()).toBe('authenticating');
    FakeSocket.last.serverSend({ type: 'ready', self: SELF }); // a resposta estava na fila
    FakeSocket.last.serverSend({ type: 'history', messages: [] });
    expect(status()).toBe('ready');
  });

  it('D: sem resposta mesmo após a renovação, o prazo encerra normalmente', () => {
    setup({ open: false });
    FakeSocket.last.serverOpen();
    vi.setSystemTime(Date.now() + 120_000);
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS);
    expect(FakeSocket.instances[0]!.closeCalls).toEqual([{ code: 4900, reason: 'handshake_timeout' }]);
    expect(status()).toBe('reconnecting');
  });

  it('D: prazo da confirmação atrasado pela suspensão não recicla a conexão', () => {
    setup();
    store.send('enviada antes de suspender');
    vi.setSystemTime(Date.now() + 120_000);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    expect(status()).toBe('ready');
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.last.serverSend(confirmFrame('enviada antes de suspender', sendFrames()[0]!.nonce!));
    expect(messages()).toEqual([['enviada antes de suspender', 'sent']]);
  });
});

describe('estado de rede: navigator.onLine não é a única fonte', () => {
  it('onLine=false por engano: a sondagem periódica conecta mesmo assim', () => {
    setup();
    network.online = false; // webview informa offline, mas a rede funciona
    FakeSocket.last.networkFailure();
    expect(status()).toBe('offline');
    vi.advanceTimersByTime(OFFLINE_PROBE_MS);
    expect(FakeSocket.instances).toHaveLength(2);
    acceptConnection(FakeSocket.last);
    expect(status()).toBe('ready');
  });

  it('sem rede de verdade por muito tempo: as sondagens contam no limite e param', () => {
    setup();
    network.set(false);
    FakeSocket.last.networkFailure();
    runWithoutService(30 * 60_000, 5_000);
    expect(connection.getState()).toMatchObject({ status: 'stopped', reason: 'retries_exhausted' });
    expect(FakeSocket.instances.length).toBeLessThanOrEqual(1 + MAX_RECONNECT_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a volta real da rede (offline → online) recomeça depois de esgotar', () => {
    setup();
    network.set(false);
    FakeSocket.last.networkFailure();
    runWithoutService(30 * 60_000, 5_000);
    expect(status()).toBe('stopped');
    network.set(true);
    expect(status()).toBe('connecting');
    acceptConnection(FakeSocket.last);
    expect(status()).toBe('ready');
  });

  it('rede oscilando: o contador zera no máximo uma vez por minuto', () => {
    setup({ open: false });
    for (let i = 0; i < 40; i += 1) {
      network.set(false);
      network.set(true); // transição real, porém em rajada
      failPending();
      vi.advanceTimersByTime(1_000);
      failPending();
    }
    // Em 40 s só pode ter havido uma zerada: no máximo 2 ciclos completos de tentativas.
    expect(FakeSocket.instances.length).toBeLessThanOrEqual(2 * MAX_RECONNECT_ATTEMPTS);
    expect(ONLINE_RESET_COOLDOWN_MS).toBeGreaterThan(40_000);
  });

  it('"online" com a sala aberta ou parada por sessão expirada não faz nada', () => {
    setup();
    network.set(false);
    network.set(true);
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.last.serverClose(4001, 'invalid_token');
    network.set(false);
    network.set(true);
    expect(connection.getState()).toMatchObject({ status: 'stopped', reason: 'session_expired' });
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('"Tentar agora" sem rede tenta mesmo assim', () => {
    setup();
    network.set(false);
    FakeSocket.last.networkFailure();
    connection.retry();
    expect(FakeSocket.instances).toHaveLength(2);
    acceptConnection(FakeSocket.last);
    expect(status()).toBe('ready');
  });
});

describe('contratos preservados', () => {
  it('sem o handler de recycle, a falta de confirmação falha com "timeout" (4.4)', () => {
    setup({ withRecycle: false });
    store.send('x');
    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    expect(store.getSnapshot().messages[0]).toMatchObject({ status: 'failed', failure: { reason: 'timeout' } });
  });

  it('recycle só age com a sala aberta', () => {
    setup({ open: false });
    expect(connection.recycle()).toBe(false);
  });

  it('dispose remove o ouvinte da rede e todos os timers', () => {
    setup();
    network.set(false);
    FakeSocket.last.networkFailure(); // offline: sondagem agendada
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    connection.dispose();
    expect(network.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    network.set(true);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('a reconexão usa o mesmo token e a mesma instância da sessão', () => {
    setup();
    FakeSocket.last.networkFailure();
    vi.runOnlyPendingTimers();
    FakeSocket.last.serverOpen();
    const auths = FakeSocket.instances.map((s) => JSON.parse(s.sent[0]!) as Record<string, string>);
    expect(auths).toEqual([
      { type: 'auth', accessToken: 'token-1', instanceId: 'i-1' },
      { type: 'auth', accessToken: 'token-1', instanceId: 'i-1' },
    ]);
  });
});

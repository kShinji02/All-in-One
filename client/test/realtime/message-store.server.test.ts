// @vitest-environment node
import http from 'node:http';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { createChatConnection, type ChatConnection, type NetworkMonitor, type WebSocketLike } from '@/realtime/chat-connection';
import type { ChatMessage, ServerFrame } from '@/realtime/chat-protocol';
import { createMessageStore, type ChatEntry, type MessageStore } from '@/realtime/message-store';

/*
 * Store + ChatConnection + servidor REAL (attachChat, salas, histórico com nonce,
 * idempotência, rate limit e normalização de server/chat). Só o autenticador do
 * Discord é substituído por um mapa token → usuário (ver chat-connection.server.test.ts).
 *
 * Para provocar perdas em pontos exatos, os testes usam três costuras:
 * - um registro de salas que embrulha o real e avisa quando uma mensagem é gravada;
 * - um filtro dos frames entregues à store (simula confirmação perdida);
 * - um transport que pode "perder" um envio antes de chegar ao servidor.
 */

const SERVER = new URL('../../../server/', import.meta.url);
const importServer = <T>(file: string) => import(/* @vite-ignore */ new URL(file, SERVER).href) as Promise<T>;

type User = { id: string; username: string; displayName: string; avatarUrl: string };
type Rooms = {
  append(id: string, message: ChatMessage, nonce?: string): void;
  historyFor(id: string, viewer: string): ChatMessage[];
  [key: string]: unknown;
};
type Chat = { close(): void; wss: { clients: Set<{ terminate(): void; chatSession?: { user?: { id: string } } }> } };
type WsCtor = new (url: string, opts: { origin: string }) => WebSocketLike;

let server: http.Server;
let chat: Chat;
let rooms: Rooms;
let url: string;
let NodeWebSocket: WsCtor;

const users = new Map<string, User>(); // token → usuário
let onAppend: ((message: ChatMessage) => void) | null = null;

let seq = 0;
function newUser(name: string): { token: string; user: User } {
  seq += 1;
  const id = String(100000000000000000n + BigInt(seq));
  const user = { id, username: name.toLowerCase(), displayName: name, avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' };
  const token = `tok-${name}-${seq}`;
  users.set(token, user);
  return { token, user };
}
const newInstance = () => `i-test-${++seq}`;

beforeAll(async () => {
  const { attachChat } = await importServer<{ attachChat: (s: http.Server, o: unknown) => Chat }>('chat/index.js');
  const { createRoomRegistry } = await importServer<{ createRoomRegistry: () => Rooms }>('chat/rooms.js');
  const { ChatCloseError } = await importServer<{ ChatCloseError: new (c: number, r: string) => Error }>('chat/errors.js');
  NodeWebSocket = ((await import(/* @vite-ignore */ new URL('node_modules/ws/index.js', SERVER).href)) as { default: WsCtor }).default;

  const real = createRoomRegistry();
  rooms = {
    ...real,
    append(id, message, nonce) {
      real.append(id, message, nonce);
      onAppend?.(message);
    },
  };

  server = http.createServer();
  chat = attachChat(server, {
    rooms,
    authenticate: async ({ accessToken, instanceId }: { accessToken: string; instanceId: string }) => {
      const user = users.get(accessToken);
      if (!user) throw new ChatCloseError(4001, 'invalid_token');
      return { user, instanceId };
    },
    messageRateLimit: { limit: 2, windowMs: 400 },
    logger: { error: () => undefined },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/chat`;
});

afterAll(async () => {
  chat?.close();
  await new Promise((resolve) => server?.close(resolve));
});

interface Client {
  store: MessageStore;
  connection: ChatConnection;
  sendSpy: Mock<(text: string, nonce: string) => boolean>;
  /** Se definido e devolver false, o frame não chega à store. */
  filter: ((frame: ServerFrame) => boolean) | null;
  /** Se definido e devolver true, o envio "se perde" antes do servidor. */
  loseSend: ((text: string) => boolean) | null;
  list(): readonly ChatEntry[];
}
const clients: Client[] = [];

afterEach(async () => {
  onAppend = null;
  for (const c of clients.splice(0)) {
    c.connection.dispose();
    c.store.dispose();
  }
  await vi.waitFor(() => expect(chat.wss.clients.size).toBe(0));
});

function join(
  token: string,
  instanceId: string,
  { ackTimeoutMs, network, recycleOnAckTimeout = false }: { ackTimeoutMs?: number; network?: NetworkMonitor; recycleOnAckTimeout?: boolean } = {},
): Client {
  const client = {} as Client;
  client.filter = null;
  client.loseSend = null;
  client.sendSpy = vi.fn((text: string, nonce: string): boolean => {
    if (client.loseSend?.(text)) return true; // "entregue" ao socket, mas nunca chega
    return client.connection.send(text, nonce);
  });
  client.store = createMessageStore({
    transport: { send: (t, n) => client.sendSpy(t, n) },
    ackTimeoutMs,
    // Como o ChatConnectionProvider liga (4.6+): sem confirmação no prazo → recicla a conexão.
    onAckTimeout: recycleOnAckTimeout ? () => client.connection.recycle() : undefined,
  });
  client.connection = createChatConnection({
    url,
    credentials: { accessToken: token, instanceId },
    createSocket: (target) => new NodeWebSocket(target, { origin: 'http://localhost:5173' }),
    random: () => 0,
    network,
    onStateChange: (s) => client.store.handleConnectionState(s),
    onFrame: (f) => {
      if (client.filter && !client.filter(f)) return;
      client.store.handleFrame(f);
    },
  });
  client.list = () => client.store.getSnapshot().messages;
  clients.push(client);
  client.connection.start();
  return client;
}

const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5_000, interval: 10 });
const ready = (c: Client) => until(() => expect(c.connection.getState().status).toBe('ready'));
const roomTexts = (instanceId: string) => rooms.historyFor(instanceId, 'ninguém').map((m) => m.text);
const statuses = (c: Client) => c.list().map((m) => [m.text, m.status]);
function terminateSocketOf(userId: string) {
  for (const ws of chat.wss.clients) if (ws.chatSession?.user?.id === userId) ws.terminate();
}
/** Nenhuma mensagem aparece duas vezes na lista. */
function expectUnique(c: Client) {
  const ids = c.list().flatMap((m) => (m.id ? [m.id] : []));
  expect(new Set(ids).size).toBe(ids.length);
  const keys = c.list().map((m) => m.key);
  expect(new Set(keys).size).toBe(keys.length);
}

describe('store × servidor real', () => {
  it('envio normal: otimista na hora, confirmado pelo servidor, uma entrada para cada lado', async () => {
    const room = newInstance();
    const ana = newUser('Ana');
    const bruno = newUser('Bruno');
    const a = join(ana.token, room);
    const b = join(bruno.token, room);
    await ready(a);
    await ready(b);
    await until(() => expect(a.store.getSnapshot().self?.id).toBe(ana.user.id));

    const result = a.store.send('  olá, Bruno  ');
    expect(a.list()).toMatchObject([{ text: 'olá, Bruno', status: 'pending', own: true }]);
    await until(() => expect(statuses(a)).toEqual([['olá, Bruno', 'sent']]));
    await until(() => expect(statuses(b)).toEqual([['olá, Bruno', 'sent']]));

    expect(result.ok && a.list()[0]!.key === result.key).toBe(true);
    expect(a.list()[0]!.id).toBe(b.list()[0]!.id);
    expect(b.list()[0]!.own).toBe(false);
    expect(roomTexts(room)).toEqual(['olá, Bruno']);
    expect(a.sendSpy).toHaveBeenCalledTimes(1);
  });

  it('confirmação perdida na queda (servidor já publicou): o histórico com o nonce confirma, sem reenviar', async () => {
    const room = newInstance();
    const ana = newUser('Ana');
    const bruno = newUser('Bruno');
    const a = join(ana.token, room);
    const b = join(bruno.token, room);
    await ready(a);
    await ready(b);

    // Grava a mensagem e derruba a conexão da Ana antes de o servidor responder.
    onAppend = (m) => {
      if (m.text === 'perdida') terminateSocketOf(ana.user.id);
    };
    a.store.send('perdida');
    await until(() => expect(a.connection.getState().status).toBe('reconnecting'));
    expect(statuses(a)).toEqual([['perdida', 'pending']]);

    await ready(a);
    await until(() => expect(statuses(a)).toEqual([['perdida', 'sent']]));
    expect(a.sendSpy).toHaveBeenCalledTimes(1); // não reenviou
    expect(roomTexts(room)).toEqual(['perdida']);
    await until(() => expect(statuses(b)).toEqual([['perdida', 'sent']]));
    expectUnique(a);
    expectUnique(b);
  });

  it('envio perdido antes do servidor: após reconectar, reenvia com o mesmo nonce e publica uma vez', async () => {
    const room = newInstance();
    const ana = newUser('Ana');
    const bruno = newUser('Bruno');
    const a = join(ana.token, room);
    const b = join(bruno.token, room);
    await ready(a);
    await ready(b);

    let lost = false;
    a.loseSend = (text) => {
      if (text !== 'nunca chegou' || lost) return false;
      lost = true;
      return true;
    };
    a.store.send('nunca chegou');
    terminateSocketOf(ana.user.id);

    await until(() => expect(statuses(a)).toEqual([['nunca chegou', 'sent']]));
    const nonces = a.sendSpy.mock.calls.map((call) => call[1]);
    expect(nonces).toHaveLength(2);
    expect(new Set(nonces).size).toBe(1); // mesmo nonce
    expect(roomTexts(room)).toEqual(['nunca chegou']);
    await until(() => expect(statuses(b)).toEqual([['nunca chegou', 'sent']]));
    expectUnique(a);
  });

  it('confirmação perdida com a conexão aberta: timeout, retry manual e o servidor devolve a ORIGINAL', async () => {
    const room = newInstance();
    const ana = newUser('Ana');
    const bruno = newUser('Bruno');
    const a = join(ana.token, room, { ackTimeoutMs: 300 });
    const b = join(bruno.token, room);
    await ready(a);
    await ready(b);

    let dropped = 0;
    a.filter = (f) => !(f.type === 'message' && f.nonce !== undefined && dropped++ === 0);
    a.store.send('eco');
    await until(() => expect(a.list()[0]).toMatchObject({ status: 'failed', failure: { reason: 'timeout' } }));
    await until(() => expect(statuses(b)).toEqual([['eco', 'sent']]));
    const publishedId = b.list()[0]!.id;

    expect(a.store.retry(a.list()[0]!.key)).toBe(true);
    await until(() => expect(statuses(a)).toEqual([['eco', 'sent']]));
    expect(a.list()[0]!.id).toBe(publishedId); // a mensagem original, não uma nova
    expect(roomTexts(room)).toEqual(['eco']);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.list()).toHaveLength(1); // o reenvio idempotente não foi retransmitido à sala
  });

  it('rate limit real: o excedente espera o retryAfterMs e é publicado uma única vez', async () => {
    const room = newInstance();
    const carla = newUser('Carla');
    const c = join(carla.token, room);
    await ready(c);

    c.store.send('1');
    c.store.send('2');
    c.store.send('3'); // limite do teste: 2 a cada 400 ms
    await until(() => expect(c.list().find((m) => m.text === '3')?.attempts).toBe(1));
    await until(() => expect(statuses(c)).toEqual([['1', 'sent'], ['2', 'sent'], ['3', 'sent']]));
    expect(roomTexts(room)).toEqual(['1', '2', '3']);
    expect(c.list().find((m) => m.text === '3')!.attempts).toBe(2);
  });

  it('texto que o servidor rejeita: failed definitivo com o código real', async () => {
    const room = newInstance();
    const ana = newUser('Ana');
    const a = join(ana.token, room);
    await ready(a);
    a.store.send('\u0000\u0001'); // só controles: o servidor normaliza para vazio
    await until(() =>
      expect(a.list()[0]).toMatchObject({ status: 'failed', failure: { reason: 'rejected', code: 'empty_message', retryable: false } }),
    );
    expect(roomTexts(room)).toEqual([]);
  });

  it('histórico ao entrar traz o nonce só nas próprias mensagens e não duplica com a lista', async () => {
    const room = newInstance();
    const ana = newUser('Ana');
    const bruno = newUser('Bruno');
    const a = join(ana.token, room);
    await ready(a);
    a.store.send('antes');
    await until(() => expect(statuses(a)).toEqual([['antes', 'sent']]));

    const b = join(bruno.token, room);
    await ready(b);
    await until(() => expect(b.list()).toHaveLength(1));
    expect(b.list()[0]).toMatchObject({ text: 'antes', own: false, nonce: null });

    terminateSocketOf(ana.user.id); // Ana reentra e recebe o histórico com o próprio nonce
    await until(() => expect(a.connection.getState().status).toBe('reconnecting'));
    await ready(a);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.list()).toHaveLength(1);
    expect(a.list()[0]!.nonce).not.toBeNull();
  });

  it('isolamento: stores de instâncias diferentes não veem as mensagens uma da outra', async () => {
    const roomA = newInstance();
    const roomB = newInstance();
    const ana = newUser('Ana');
    const bruno = newUser('Bruno');
    const a = join(ana.token, roomA);
    const b = join(bruno.token, roomB);
    await ready(a);
    await ready(b);
    a.store.send('só na sala A');
    await until(() => expect(statuses(a)).toEqual([['só na sala A', 'sent']]));
    await new Promise((r) => setTimeout(r, 100));
    expect(b.list()).toEqual([]);
    expect(roomTexts(roomB)).toEqual([]);
  });

  /* ---------------- perda de internet (Discord Mobile) ---------------- */
  class Network implements NetworkMonitor {
    online = true;
    private listeners = new Set<(online: boolean) => void>();
    isOnline = () => this.online;
    subscribe = (listener: (online: boolean) => void) => {
      this.listeners.add(listener);
      return () => void this.listeners.delete(listener);
    };
    set(online: boolean) {
      this.online = online;
      for (const l of [...this.listeners]) l(online);
    }
  }

  it('internet cai, mensagem enviada offline, internet volta: reconecta, histórico e publicação única', async () => {
    const room = newInstance();
    const ana = newUser('Ana');
    const bruno = newUser('Bruno');
    const network = new Network();
    const a = join(ana.token, room, { network, recycleOnAckTimeout: true });
    const b = join(bruno.token, room);
    await ready(a);
    await ready(b);
    b.store.send('antes da queda');
    await until(() => expect(statuses(a)).toEqual([['antes da queda', 'sent']]));

    network.set(false);
    expect(a.connection.getState().status).toBe('ready'); // o evento sozinho não derruba
    terminateSocketOf(ana.user.id); // a queda real: o socket morre
    await until(() => expect(a.connection.getState().status).toBe('offline'));
    a.store.send('escrita sem internet');
    expect(statuses(a).at(-1)).toEqual(['escrita sem internet', 'pending']);
    b.store.send('enquanto a Ana estava fora');
    await until(() => expect(statuses(b)).toHaveLength(2));

    network.set(true);
    await ready(a);
    await until(() =>
      expect(statuses(a)).toEqual([
        ['antes da queda', 'sent'],
        ['enquanto a Ana estava fora', 'sent'], // recuperada pelo histórico
        ['escrita sem internet', 'sent'],
      ]),
    );
    await until(() => expect(statuses(b).map(([t]) => t)).toEqual(['antes da queda', 'enquanto a Ana estava fora', 'escrita sem internet']));
    expect(roomTexts(room)).toEqual(['antes da queda', 'enquanto a Ana estava fora', 'escrita sem internet']);
    expect(a.sendSpy).toHaveBeenCalledTimes(1); // nada foi enviado enquanto estava offline
    expectUnique(a);
    expectUnique(b);
  });

  it('socket meio aberto (o envio se perde sem aviso): o prazo recicla a conexão e o reenvio publica uma vez', async () => {
    const room = newInstance();
    const ana = newUser('Ana');
    const bruno = newUser('Bruno');
    const a = join(ana.token, room, { ackTimeoutMs: 300, recycleOnAckTimeout: true });
    const b = join(bruno.token, room);
    await ready(a);
    await ready(b);

    let lost = false;
    a.loseSend = (text) => {
      if (text !== 'no vazio' || lost) return false;
      lost = true;
      return true; // o frame "sai" do aparelho mas nunca chega ao servidor
    };
    a.store.send('no vazio');
    await until(() => expect(a.connection.getState().status).not.toBe('ready'));
    expect(statuses(a)).toEqual([['no vazio', 'pending']]); // nunca "failed: timeout"

    await until(() => expect(statuses(a)).toEqual([['no vazio', 'sent']]));
    const nonces = a.sendSpy.mock.calls.map((call) => call[1]);
    expect(nonces).toHaveLength(2);
    expect(new Set(nonces).size).toBe(1);
    expect(roomTexts(room)).toEqual(['no vazio']);
    await until(() => expect(statuses(b)).toEqual([['no vazio', 'sent']]));
  });
});

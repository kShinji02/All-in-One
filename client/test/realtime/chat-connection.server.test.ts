// @vitest-environment node
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChatConnection,
  type ChatConnection,
  type ChatConnectionState,
  type WebSocketLike,
} from '@/realtime/chat-connection';
import type { ServerFrame } from '@/realtime/chat-protocol';

/*
 * Integração com o servidor REAL: attachChat de server/chat/index.js (upgrade,
 * verificação de Origin, auth, salas, histórico, limites, revalidação e códigos de
 * fechamento) e o cliente `ws` do servidor no lugar do WebSocket do navegador.
 *
 * Limitação: só o autenticador externo é substituído. Em produção ele consulta
 * /users/@me e activity-instances no Discord (server/chat/authenticator.js, coberto
 * pelos testes do servidor); aqui um mapa token → usuário decide o resultado e lança
 * os mesmos ChatCloseError que o autenticador real lança.
 */

const SERVER_CHAT = new URL('../../../server/chat/', import.meta.url);
const importServer = <T>(file: string) => import(/* @vite-ignore */ new URL(file, SERVER_CHAT).href) as Promise<T>;

type User = { id: string; username: string; displayName: string; avatarUrl: string };
const user = (id: string, name: string): User => ({
  id,
  username: name.toLowerCase(),
  displayName: name,
  avatarUrl: `https://cdn.discordapp.com/embed/avatars/${Number(id.at(-1)) % 6}.png`,
});
const ANA = user('205519959982473217', 'Ana');
const BRUNO = user('175928847299117063', 'Bruno');
const INSTANCE = 'i-1276580072400224306-gc-912952092627435520-912954213460484116';

type ChatCloseErrorCtor = new (code: number, reason: string) => Error;
type Chat = {
  close(): void;
  revalidate(): Promise<void>;
  rooms: { clientCount(id: string): number };
  wss: { clients: Set<{ terminate(): void; chatSession?: { user?: { id: string } } }> };
};
type WsCtor = new (url: string, opts: { origin: string }) => WebSocketLike;

let server: http.Server;
let chat: Chat;
let url: string;
let NodeWebSocket: WsCtor;
let ChatCloseError: ChatCloseErrorCtor;

/** Comportamento do autenticador por token (controlado em cada teste). */
const tokens = new Map<string, (attempt: number) => User | Error>();
const authCalls: { accessToken: string; instanceId: string }[] = [];
const members = new Set<string>();

beforeAll(async () => {
  const { attachChat } = await importServer<{ attachChat: (s: http.Server, o: unknown) => Chat }>('index.js');
  ({ ChatCloseError } = await importServer<{ ChatCloseError: ChatCloseErrorCtor }>('errors.js'));
  const wsModule = (await import(/* @vite-ignore */ new URL('../../../server/node_modules/ws/index.js', import.meta.url).href)) as {
    default: WsCtor;
  };
  NodeWebSocket = wsModule.default;

  server = http.createServer();
  chat = attachChat(server, {
    discordClientId: '123456789012345678',
    authenticate: async ({ accessToken, instanceId }: { accessToken: string; instanceId: string }) => {
      authCalls.push({ accessToken, instanceId });
      const behaviour = tokens.get(accessToken);
      if (!behaviour) throw new ChatCloseError(4001, 'invalid_token');
      const result = behaviour(authCalls.filter((c) => c.accessToken === accessToken).length);
      if (result instanceof Error) throw result;
      return { user: result, instanceId };
    },
    getMembers: async () => new Set(members),
    revalidateIntervalMs: 3_600_000, // revalidação disparada manualmente pelo teste
    logger: { error: () => undefined, warn: () => undefined, info: () => undefined },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/chat`;
});

afterAll(async () => {
  chat?.close();
  await new Promise((resolve) => server?.close(resolve));
});

const open: ChatConnection[] = [];

beforeEach(() => {
  tokens.clear();
  authCalls.length = 0;
  members.clear();
  members.add(ANA.id).add(BRUNO.id);
  tokens.set('tok-ana', () => ANA);
  tokens.set('tok-bruno', () => BRUNO);
});

afterEach(async () => {
  for (const c of open.splice(0)) c.dispose();
  await vi.waitFor(() => expect(chat.wss.clients.size).toBe(0));
});

function connect(accessToken: string, { origin = 'http://localhost:5173' } = {}) {
  const states: ChatConnectionState[] = [];
  const frames: ServerFrame[] = [];
  const invalid: string[] = [];
  let sockets = 0;
  const connection = createChatConnection({
    url,
    credentials: { accessToken, instanceId: INSTANCE },
    createSocket: (target) => {
      sockets += 1;
      return new NodeWebSocket(target, { origin });
    },
    random: () => 0, // menor espera: 1ª nova tentativa em 500 ms
    onStateChange: (s) => states.push(s),
    onFrame: (f) => frames.push(f),
    onInvalidFrame: (r) => invalid.push(r),
  });
  open.push(connection);
  connection.start();
  return { connection, states, frames, invalid, sockets: () => sockets };
}

const waitForStatus = (c: ChatConnection, status: ChatConnectionState['status']) =>
  vi.waitFor(() => expect(c.getState().status).toBe(status), { timeout: 5_000, interval: 10 });

describe('ChatConnection × attachChat real', () => {
  it('conecta, autentica com o token e a instância exatos e recebe ready + history', async () => {
    const ana = connect('tok-ana');
    await waitForStatus(ana.connection, 'ready');

    expect(authCalls).toEqual([{ accessToken: 'tok-ana', instanceId: INSTANCE }]);
    expect(ana.connection.getState()).toEqual({ status: 'ready', self: ANA });
    await vi.waitFor(() => expect(ana.frames.map((f) => f.type)).toEqual(['ready', 'history']));
    expect(ana.invalid).toEqual([]);
    expect(ana.states.map((s) => s.status)).toEqual(['connecting', 'authenticating', 'ready']);
  });

  it('origem não permitida: o upgrade é recusado (403) e o cliente tenta com backoff', async () => {
    const intruso = connect('tok-ana', { origin: 'https://evil.example' });
    await vi.waitFor(() => expect(intruso.connection.getState().status).toBe('reconnecting'));
    expect(intruso.connection.getState()).toMatchObject({ lastClose: { code: 1006, category: 'transient' } });
    expect(authCalls).toEqual([]);
  });

  it('token expirado/inválido: para em session_expired e não reenvia o token', async () => {
    const c = connect('tok-expirado');
    await waitForStatus(c.connection, 'stopped');
    expect(c.connection.getState()).toMatchObject({
      status: 'stopped',
      reason: 'session_expired',
      lastClose: { code: 4001, reason: 'invalid_token' },
    });
    await delay(1_200); // mais que duas esperas de backoff
    expect(authCalls).toHaveLength(1);
    expect(c.sockets()).toBe(1);
  });

  it('Discord indisponível (1013) no 1º auth: reconecta com backoff e entra na sala', async () => {
    tokens.set('tok-instavel', (n) => (n === 1 ? new ChatCloseError(1013, 'discord_unavailable') : ANA));
    const c = connect('tok-instavel');
    await waitForStatus(c.connection, 'reconnecting');
    expect(c.connection.getState()).toMatchObject({ attempt: 2, delayMs: 500, lastClose: { code: 1013, reason: 'discord_unavailable' } });
    await waitForStatus(c.connection, 'ready');
    expect(c.sockets()).toBe(2);
  });

  it('falha inesperada no autenticador (4001 auth_failed real): reconecta com backoff e entra na sala', async () => {
    // Um Error comum (não ChatCloseError) faz o servidor fechar com 4001 auth_failed.
    tokens.set('tok-falha', (n) => (n === 1 ? new Error('bug no autenticador') : ANA));
    const c = connect('tok-falha');
    await waitForStatus(c.connection, 'reconnecting');
    expect(c.connection.getState()).toMatchObject({
      attempt: 2,
      delayMs: 500,
      lastClose: { code: 4001, reason: 'auth_failed', category: 'transient' },
    });
    await waitForStatus(c.connection, 'ready');
    expect(c.sockets()).toBe(2);
    expect(authCalls).toHaveLength(2);
  });

  it('queda da conexão já autenticada: reconecta e recebe o histórico da sala', async () => {
    const ana = connect('tok-ana');
    const bruno = connect('tok-bruno');
    await waitForStatus(ana.connection, 'ready');
    await waitForStatus(bruno.connection, 'ready');

    // Bruno publica direto pelo protocolo; a mensagem fica no histórico da sala.
    const raw = new NodeWebSocket(url, { origin: 'http://localhost:5173' }) as WebSocketLike;
    await new Promise<void>((resolve) => raw.addEventListener('open', () => resolve()));
    raw.send(JSON.stringify({ type: 'auth', accessToken: 'tok-bruno', instanceId: INSTANCE }));
    await delay(50);
    raw.send(JSON.stringify({ type: 'send', text: 'antes da queda' }));
    await vi.waitFor(() => expect(ana.frames.some((f) => f.type === 'message')).toBe(true));
    raw.close();

    // Servidor derruba a conexão da Ana sem fechamento limpo (1006).
    for (const ws of chat.wss.clients) if (ws.chatSession?.user?.id === ANA.id) ws.terminate();
    await waitForStatus(ana.connection, 'reconnecting');
    await waitForStatus(ana.connection, 'ready');

    const history = ana.frames.filter((f): f is Extract<ServerFrame, { type: 'history' }> => f.type === 'history');
    expect(history).toHaveLength(2);
    expect(history[1]!.messages.map((m) => m.text)).toEqual(['antes da queda']);
    expect(bruno.connection.getState().status).toBe('ready'); // Bruno não foi afetado
  });

  it('usuário removido da Activity: a revalidação fecha com 4003 e o cliente não tenta reentrar', async () => {
    const ana = connect('tok-ana');
    await waitForStatus(ana.connection, 'ready');
    members.delete(ANA.id);
    await chat.revalidate();

    await waitForStatus(ana.connection, 'stopped');
    expect(ana.connection.getState()).toMatchObject({ reason: 'left_instance', lastClose: { code: 4003, reason: 'not_in_instance' } });
    await delay(1_200);
    expect(authCalls).toHaveLength(1);
    expect(ana.sockets()).toBe(1);
  });

  it('limite de conexões por usuário: a excedente para em "limit" sem ciclo de tentativas', async () => {
    const tabs = [connect('tok-ana'), connect('tok-ana'), connect('tok-ana')];
    for (const t of tabs) await waitForStatus(t.connection, 'ready');

    const extra = connect('tok-ana');
    await waitForStatus(extra.connection, 'stopped');
    expect(extra.connection.getState()).toMatchObject({ reason: 'limit', lastClose: { code: 4029, reason: 'too_many_connections' } });
    await delay(1_200);
    expect(extra.sockets()).toBe(1);
    expect(authCalls).toHaveLength(4);
  });

  it('dispose: o servidor vê a saída da sala e nenhuma nova conexão é aberta', async () => {
    const ana = connect('tok-ana');
    await waitForStatus(ana.connection, 'ready');
    expect(chat.rooms.clientCount(INSTANCE)).toBe(1);

    ana.connection.dispose();
    await vi.waitFor(() => expect(chat.rooms.clientCount(INSTANCE)).toBe(0));
    await delay(700);
    expect(chat.wss.clients.size).toBe(0);
    expect(ana.sockets()).toBe(1);
  });

  it('dispose durante a espera de reconexão cancela a tentativa', async () => {
    tokens.set('tok-instavel', () => new ChatCloseError(1013, 'discord_unavailable'));
    const c = connect('tok-instavel');
    await waitForStatus(c.connection, 'reconnecting');
    c.connection.dispose();
    await delay(800);
    expect(c.sockets()).toBe(1);
    expect(authCalls).toHaveLength(1);
  });
});

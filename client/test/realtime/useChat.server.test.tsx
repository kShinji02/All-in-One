import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import path from 'node:path';
import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DiscordState } from '@/discord/types';
import { createChatConnection, type ChatConnection, type WebSocketLike } from '@/realtime/chat-connection';
import { ChatConnectionProvider } from '@/realtime/ChatConnectionProvider';
import { createMessageStore, type MessageStore } from '@/realtime/message-store';
import { useChat } from '@/realtime/useChat';

/*
 * useChat + provider + conexão + store contra o servidor REAL (attachChat), que roda
 * num processo Node separado (fixtures/chat-server.mjs). O cliente é o `ws` do servidor
 * (API compatível com a do navegador), carregado por require nativo: no jsdom, o
 * WebSocket global do Node é incompatível com as classes Event do jsdom.
 *
 * A Ana usa o hook (React, StrictMode); o Bruno é um cliente sem React com a mesma
 * conexão e store. Substituídos: a sessão Discord (useDiscord/getAccessToken) e o
 * autenticador do Discord no servidor (mapa token → usuário).
 */

const fake = vi.hoisted(() => ({ discord: null as unknown, token: null as string | null }));
vi.mock('@/discord/useDiscord', () => ({
  useDiscord: () => ({ state: fake.discord, sdkReady: true, retry: () => undefined }),
}));
vi.mock('@/discord/session', () => ({ getAccessToken: () => fake.token }));

const ANA = { id: '205519959982473217', username: 'ana', displayName: 'Ana', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' };
const BRUNO = { id: '175928847299117063', username: 'bruno', displayName: 'Bruno', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png' };
const USERS = { 'tok-ana': ANA, 'tok-ana-2': ANA, 'tok-bruno': BRUNO };

type WsCtor = new (url: string, opts: { origin: string }) => WebSocketLike;
const requireFromServer = createRequire(path.resolve(process.cwd(), '../server/package.json'));
const NodeWebSocket = requireFromServer('ws') as WsCtor;
const createSocket = (target: string) => new NodeWebSocket(target, { origin: 'http://localhost:5173' });

let child: ChildProcess;
let base: string;
let url: string;
let room = 0;
const newRoom = () => `i-hook-${++room}`;

beforeAll(async () => {
  // No jsdom, import.meta.url é http:; o caminho sai do cwd do Vitest (client/).
  const fixture = path.resolve(process.cwd(), 'test/realtime/fixtures/chat-server.mjs');
  child = spawn(process.execPath, [fixture], { env: { ...process.env, CHAT_TEST_USERS: JSON.stringify(USERS) }, stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`servidor de teste saiu (${code})`)));
    createInterface({ input: child.stdout! }).once('line', resolve);
  });
  const { port } = JSON.parse(line) as { port: number };
  base = `http://127.0.0.1:${port}`;
  url = `ws://127.0.0.1:${port}/api/chat`;
});

afterAll(() => {
  child?.kill();
});

const control = async <T,>(path: string, method = 'GET') => (await (await fetch(`${base}/__test/${path}`, { method })).json()) as T;
const history = (id: string) => control<string[]>(`history?room=${id}`);
const clientsOf = (userId: string) => control<number>(`clients?user=${userId}`);

const cleanup: (() => void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) fn();
  await vi.waitFor(async () => expect((await clientsOf(ANA.id)) + (await clientsOf(BRUNO.id))).toBe(0), { timeout: 5_000 });
});

const session = (instanceId: string): DiscordState => ({
  status: 'ready',
  session: {
    user: { id: ANA.id, username: 'ana', globalName: 'Ana', avatarUrl: ANA.avatarUrl },
    scopes: ['identify', 'guilds'],
    expires: '2026-12-01T00:00:00.000Z',
    context: { instanceId, platform: 'desktop', guildId: null, channelId: null, locationId: null },
    channel: null,
    guild: null,
  },
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <ChatConnectionProvider url={url} createSocket={createSocket} random={() => 0}>
        {children}
      </ChatConnectionProvider>
    </StrictMode>
  );
}

function renderAna(instanceId: string, token = 'tok-ana') {
  fake.discord = session(instanceId);
  fake.token = token;
  const hook = renderHook(() => useChat(), { wrapper });
  cleanup.push(() => hook.unmount());
  return hook;
}

/** Bruno: o mesmo par conexão + store, sem React. */
function bruno(instanceId: string): { store: MessageStore; connection: ChatConnection } {
  let connection: ChatConnection | null = null;
  const store = createMessageStore({ transport: { send: (t, n) => connection?.send(t, n) ?? false } });
  connection = createChatConnection({
    url,
    credentials: { accessToken: 'tok-bruno', instanceId },
    createSocket,
    random: () => 0,
    onStateChange: (s) => store.handleConnectionState(s),
    onFrame: (f) => store.handleFrame(f),
  });
  connection.start();
  cleanup.push(() => {
    connection?.dispose();
    store.dispose();
  });
  return { store, connection };
}

/**
 * Espera a asserção passar. Cada volta é um `act` curto: dentro de um único act longo
 * o React só aplicaria as atualizações vindas do socket no fim, e a espera nunca veria.
 */
async function until(assertion: () => void | Promise<void>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
    }
  }
}
const texts = (messages: readonly { text: string; status: string }[]) => messages.map((m) => [m.text, m.status]);

describe('useChat × servidor real', () => {
  it('fluxo completo: histórico, tempo real e envio otimista pelo hook, sem duplicar', async () => {
    const id = newRoom();
    const b = bruno(id);
    await vi.waitFor(() => expect(b.connection.getState().status).toBe('ready'));
    b.store.send('oi, Ana');
    await vi.waitFor(() => expect(b.store.getSnapshot().messages[0]?.status).toBe('sent'));

    const { result } = renderAna(id);
    await until(() => expect(result.current.isReady).toBe(true));
    expect(texts(result.current.messages)).toEqual([['oi, Ana', 'sent']]); // histórico

    act(() => void result.current.sendMessage('oi, Bruno'));
    expect(result.current.messages.at(-1)).toMatchObject({ text: 'oi, Bruno', status: 'pending' });
    await until(() => expect(result.current.messages.at(-1)?.status).toBe('sent'));
    await vi.waitFor(() =>
      expect(texts(b.store.getSnapshot().messages)).toEqual([
        ['oi, Ana', 'sent'],
        ['oi, Bruno', 'sent'],
      ]),
    );

    b.store.send('tempo real');
    await until(() =>
      expect(texts(result.current.messages)).toEqual([
        ['oi, Ana', 'sent'],
        ['oi, Bruno', 'sent'],
        ['tempo real', 'sent'],
      ]),
    );
    expect(await history(id)).toEqual(['oi, Ana', 'oi, Bruno', 'tempo real']);
    expect(await clientsOf(ANA.id)).toBe(1); // StrictMode: um único socket
  });

  it('queda após o servidor publicar: reconecta sozinho e o histórico confirma a pendente uma vez', async () => {
    const id = newRoom();
    const { result } = renderAna(id);
    await until(() => expect(result.current.isReady).toBe(true));

    await control(`terminate-on?user=${ANA.id}&text=${encodeURIComponent('na queda')}`, 'POST');
    act(() => void result.current.sendMessage('na queda'));
    await until(() => expect(result.current.connectionState.status).toBe('reconnecting'));
    expect(texts(result.current.messages)).toEqual([['na queda', 'pending']]);

    await until(() => expect(result.current.isReady).toBe(true));
    expect(texts(result.current.messages)).toEqual([['na queda', 'sent']]);
    expect(await history(id)).toEqual(['na queda']);
  });

  it('mudança de instância: só as mensagens da sala nova aparecem', async () => {
    const roomA = newRoom();
    const roomB = newRoom();
    const bB = bruno(roomB);
    await vi.waitFor(() => expect(bB.connection.getState().status).toBe('ready'));
    bB.store.send('na sala B');
    await vi.waitFor(() => expect(bB.store.getSnapshot().messages[0]?.status).toBe('sent'));

    const { result, rerender } = renderAna(roomA);
    await until(() => expect(result.current.isReady).toBe(true));
    act(() => void result.current.sendMessage('na sala A'));
    await until(() => expect(result.current.messages[0]?.status).toBe('sent'));

    fake.discord = session(roomB);
    rerender();
    await until(() => expect(result.current.isReady).toBe(true));
    expect(texts(result.current.messages)).toEqual([['na sala B', 'sent']]);
    expect(await history(roomB)).toEqual(['na sala B']);
    expect(await history(roomA)).toEqual(['na sala A']);
    expect(await clientsOf(ANA.id)).toBe(1);
  });

  it('mudança de token com pendente: a pendente antiga não é enviada com o token novo', async () => {
    const id = newRoom();
    const { result, rerender } = renderAna(id);
    await until(() => expect(result.current.isReady).toBe(true));
    await control(`terminate?user=${ANA.id}`, 'POST');
    await until(() => expect(result.current.connectionState.status).toBe('reconnecting'));
    act(() => void result.current.sendMessage('da sessão antiga'));
    expect(texts(result.current.messages)).toEqual([['da sessão antiga', 'pending']]);

    fake.token = 'tok-ana-2';
    rerender();
    expect(result.current.messages).toEqual([]);
    await until(() => expect(result.current.isReady).toBe(true));
    await new Promise((r) => setTimeout(r, 150));
    expect(result.current.messages).toEqual([]);
    expect(await history(id)).toEqual([]);
  });
});

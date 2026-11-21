import { StrictMode, useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordState } from '@/discord/types';
import type { ChatConnectionState } from '@/realtime/chat-connection';
import { ChatConnectionProvider } from '@/realtime/ChatConnectionProvider';
import type { ServerFrame } from '@/realtime/chat-protocol';
import { useChatConnection } from '@/realtime/useChatConnection';
import { acceptConnection, FakeSocket, message } from './fake-socket';

/*
 * ChatConnectionProvider com a sessão Discord controlada pelo teste: useDiscord e
 * getAccessToken são simulados para trocar token e instância à vontade.
 * O WebSocket é o FakeSocket; a conexão (chat-connection.ts) é a real.
 */

const fake = vi.hoisted(() => ({
  discord: { status: 'connecting', step: 'ready' } as unknown,
  token: null as string | null,
}));

vi.mock('@/discord/useDiscord', () => ({
  useDiscord: () => ({ state: fake.discord, sdkReady: true, retry: () => undefined }),
}));
vi.mock('@/discord/session', () => ({
  getAccessToken: () => fake.token,
}));

const readyState = (instanceId: string): DiscordState => ({
  status: 'ready',
  session: {
    user: { id: '205519959982473217', username: 'ana', globalName: 'Ana', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' },
    scopes: ['identify', 'guilds'],
    expires: '2026-12-01T00:00:00.000Z',
    context: { instanceId, platform: 'desktop', guildId: null, channelId: null, locationId: null },
    channel: null,
    guild: null,
  },
});

const seen = { states: [] as ChatConnectionState[], frames: [] as ServerFrame[], retry: null as null | (() => void) };

function Probe() {
  const { state, subscribe, retry } = useChatConnection();
  seen.retry = retry;
  useEffect(() => {
    seen.states.push(state);
  }, [state]);
  useEffect(() => subscribe((frame) => seen.frames.push(frame)), [subscribe]);
  return <output data-testid="status">{state.status}</output>;
}

function ui(strict = true) {
  const tree = (
    <ChatConnectionProvider url="ws://test/api/chat" createSocket={(url) => new FakeSocket(url)} random={() => 0}>
      <Probe />
    </ChatConnectionProvider>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

/** Deixa rodar o microtask que abre a conexão. */
const flush = () => act(async () => undefined);
const status = (container: HTMLElement) => container.querySelector('output')!.textContent;
/** Credenciais do frame de auth enviado (confere também o tipo e que foi o único frame). */
function authOf(socket: FakeSocket) {
  expect(socket.sent).toHaveLength(1);
  const { type, ...credentials } = JSON.parse(socket.sent[0]!) as { type: string; accessToken: string; instanceId: string };
  expect(type).toBe('auth');
  return credentials;
}

beforeEach(() => {
  FakeSocket.reset();
  fake.discord = { status: 'connecting', step: 'ready' };
  fake.token = null;
  seen.states = [];
  seen.frames = [];
  seen.retry = null;
});

describe('ChatConnectionProvider', () => {
  it('não conecta antes de a sessão Discord estar pronta', async () => {
    const { container, rerender } = render(ui());
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(status(container)).toBe('idle');

    // Erro na sessão: continua sem conectar.
    fake.discord = { status: 'error', code: 'backend_unreachable', message: '', detail: null };
    rerender(ui());
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('sessão pronta sem token em memória também não conecta', async () => {
    fake.discord = readyState('i-1');
    render(ui());
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('com a sessão pronta, conecta UMA vez (StrictMode) com o token e a instância da sessão', async () => {
    fake.discord = readyState('i-1');
    fake.token = 'token-1';
    const { container } = render(ui());
    await flush();

    expect(FakeSocket.instances).toHaveLength(1); // StrictMode não gera socket extra
    const socket = FakeSocket.last;
    expect(socket.url).toBe('ws://test/api/chat');
    await act(async () => acceptConnection(socket, [message('oi')]));

    expect(authOf(socket)).toEqual({ accessToken: 'token-1', instanceId: 'i-1' });
    expect(status(container)).toBe('ready');
    expect(seen.frames.map((f) => f.type)).toEqual(['ready', 'history']);
  });

  it('re-renderizações com as mesmas credenciais não reconectam', async () => {
    fake.discord = readyState('i-1');
    fake.token = 'token-1';
    const { rerender } = render(ui());
    await flush();
    await act(async () => acceptConnection(FakeSocket.last));
    fake.discord = readyState('i-1'); // objeto novo, mesmos valores
    rerender(ui());
    rerender(ui());
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it.each([
    ['token', () => (fake.token = 'token-2'), { accessToken: 'token-2', instanceId: 'i-1' }],
    ['instância', () => (fake.discord = readyState('i-2')), { accessToken: 'token-1', instanceId: 'i-2' }],
  ])('troca de %s: fecha a conexão anterior antes de abrir a nova', async (_label, change, expected) => {
    fake.discord = readyState('i-1');
    fake.token = 'token-1';
    const { rerender, container } = render(ui());
    await flush();
    const old = FakeSocket.last;
    await act(async () => acceptConnection(old));

    change();
    rerender(ui());
    // A antiga já está fechada e sem listeners quando a nova é criada.
    expect(old.closeCalls).toEqual([{ code: 1000, reason: '' }]);
    expect(old.listenerCount()).toBe(0);
    await flush();

    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.live()).toEqual([FakeSocket.last]);
    const current = FakeSocket.last;
    await act(async () => current.serverOpen());
    expect(authOf(current)).toEqual(expected);
    expect(status(container)).toBe('authenticating');

    // Eventos atrasados da conexão antiga não alteram o estado da nova.
    const frames = seen.frames.length;
    await act(async () => {
      old.serverSend({ type: 'history', messages: [] });
      old.serverClose(4003, 'not_in_instance');
    });
    expect(status(container)).toBe('authenticating');
    expect(seen.frames).toHaveLength(frames);
  });

  it('a sessão deixar de estar pronta encerra a conexão e volta a idle', async () => {
    fake.discord = readyState('i-1');
    fake.token = 'token-1';
    const { rerender, container } = render(ui());
    await flush();
    const socket = FakeSocket.last;
    await act(async () => acceptConnection(socket));

    fake.discord = { status: 'connecting', step: 'ready' };
    rerender(ui());
    await flush();
    expect(socket.closeCalls).toHaveLength(1);
    expect(status(container)).toBe('idle');
    expect(FakeSocket.live()).toEqual([]);
  });

  it('desmontar fecha o socket, remove listeners e cancela timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fake.discord = readyState('i-1');
      fake.token = 'token-1';
      const { unmount } = render(ui());
      await flush();
      const socket = FakeSocket.last;
      socket.networkFailure(); // deixa uma reconexão agendada
      expect(vi.getTimerCount()).toBe(1);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
      expect(socket.listenerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('desmontar antes do microtask de abertura não cria socket', async () => {
    fake.discord = readyState('i-1');
    fake.token = 'token-1';
    const { unmount } = render(ui());
    unmount();
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('parada definitiva fica parada; retry() manual reconecta', async () => {
    fake.discord = readyState('i-1');
    fake.token = 'token-1';
    const { container } = render(ui());
    await flush();
    await act(async () => {
      FakeSocket.last.serverOpen();
      FakeSocket.last.serverClose(4029, 'too_many_connections');
    });
    expect(status(container)).toBe('stopped');
    expect(seen.states.at(-1)).toMatchObject({ status: 'stopped', reason: 'limit' });

    await act(async () => seen.retry?.());
    expect(FakeSocket.instances).toHaveLength(2);
    expect(status(container)).toBe('connecting');
  });

  it('inscrições canceladas deixam de receber frames', async () => {
    fake.discord = readyState('i-1');
    fake.token = 'token-1';
    const { unmount } = render(ui(false));
    await flush();
    const socket = FakeSocket.last;
    await act(async () => acceptConnection(socket));
    const count = seen.frames.length;
    unmount();
    socket.serverSend({ type: 'history', messages: [] });
    expect(seen.frames).toHaveLength(count);
  });

  it('useChatConnection fora do provider lança erro claro', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/ChatConnectionProvider/);
    spy.mockRestore();
  });
});

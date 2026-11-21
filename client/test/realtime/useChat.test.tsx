import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordState } from '@/discord/types';
import { createChatConnection } from '@/realtime/chat-connection';
import { ChatConnectionProvider } from '@/realtime/ChatConnectionProvider';
import { createMessageStore, type MessageStore } from '@/realtime/message-store';
import { useChat } from '@/realtime/useChat';
import { useChatConnection } from '@/realtime/useChatConnection';
import { acceptConnection, FakeNetwork, FakeSocket, SELF } from './fake-socket';

/*
 * useChat + ChatConnectionProvider + ChatConnection + message-store REAIS.
 * Simulados: a sessão Discord (useDiscord/getAccessToken, para trocar token e
 * instância) e o WebSocket (FakeSocket). createMessageStore é espionado só para
 * contar e inspecionar as stores criadas.
 */

const fake = vi.hoisted(() => ({ discord: { status: 'connecting', step: 'ready' } as unknown, token: null as string | null }));

vi.mock('@/discord/useDiscord', () => ({
  useDiscord: () => ({ state: fake.discord, sdkReady: true, retry: () => undefined }),
}));
vi.mock('@/discord/session', () => ({ getAccessToken: () => fake.token }));
vi.mock('@/realtime/chat-connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/realtime/chat-connection')>();
  return { ...actual, createChatConnection: vi.fn(actual.createChatConnection) };
});
vi.mock('@/realtime/message-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/realtime/message-store')>();
  return { ...actual, createMessageStore: vi.fn(actual.createMessageStore) };
});

const stores = () => vi.mocked(createMessageStore).mock.results.map((r) => r.value as MessageStore);

const sessionReady = (instanceId: string): DiscordState => ({
  status: 'ready',
  session: {
    user: { id: SELF.id, username: 'ana', globalName: 'Ana', avatarUrl: SELF.avatarUrl },
    scopes: ['identify', 'guilds'],
    expires: '2026-12-01T00:00:00.000Z',
    context: { instanceId, platform: 'desktop', guildId: null, channelId: null, locationId: null },
    channel: null,
    guild: null,
  },
});

const BRUNO = { id: '175928847299117063', username: 'bruno', displayName: 'Bruno', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png' };
let seq = 0;
const serverMessage = (text: string, author = BRUNO, nonce?: string) => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  author,
  text,
  createdAt: new Date(Date.UTC(2026, 10, 20, 12, 0, seq)).toISOString(),
  ...(nonce ? { nonce } : {}),
});

let renders = 0;
function wrapper({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <ChatConnectionProvider url="ws://test/api/chat" createSocket={(url) => new FakeSocket(url)} random={() => 0}>
        {children}
      </ChatConnectionProvider>
    </StrictMode>
  );
}

function renderChat() {
  return renderHook(
    () => {
      renders += 1;
      return useChat();
    },
    { wrapper },
  );
}

const flush = () => act(async () => undefined);
const server = (fn: () => void) => act(async () => fn());
const texts = (r: { current: ReturnType<typeof useChat> }) => r.current.messages.map((m) => [m.text, m.status]);
/** Frames de envio (o 1º frame do socket é sempre o auth). */
const sentFrames = (socket: FakeSocket) => socket.sent.slice(1).map((s) => JSON.parse(s) as { type: string; text: string; nonce: string });

/** Sessão pronta + socket aberto com ready e histórico. */
async function startReady(history: unknown[] = [], instanceId = 'i-1', token = 'token-1') {
  fake.discord = sessionReady(instanceId);
  fake.token = token;
  const hook = renderChat();
  await flush();
  await server(() => acceptConnection(FakeSocket.last, history));
  return hook;
}

beforeEach(() => {
  FakeSocket.reset();
  vi.mocked(createMessageStore).mockClear();
  vi.mocked(createChatConnection).mockClear();
  fake.discord = { status: 'connecting', step: 'ready' };
  fake.token = null;
  renders = 0;
  seq = 0;
});

describe('useChat — antes e depois da conexão', () => {
  it('SDK/OAuth ainda não concluídos: sem store, sem socket, estado neutro', async () => {
    const { result } = renderChat();
    await flush();
    expect(result.current).toMatchObject({
      messages: [],
      self: null,
      connectionState: { status: 'idle' },
      isReady: false,
      isLoading: false,
      error: null,
    });
    expect(result.current.sendMessage('oi')).toEqual({ ok: false, reason: 'no_session' });
    expect(result.current.retryMessage('x')).toBe(false);
    expect(result.current.discardMessage('x')).toBe(false);
    expect(stores()).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('conexão em andamento: isLoading até o histórico; ready sozinho não basta', async () => {
    fake.discord = sessionReady('i-1');
    fake.token = 'token-1';
    const { result } = renderChat();
    await flush();
    expect(result.current).toMatchObject({ isLoading: true, isReady: false, connectionState: { status: 'connecting' } });
    await server(() => FakeSocket.last.serverOpen());
    expect(result.current.connectionState.status).toBe('authenticating');
    await server(() => FakeSocket.last.serverSend({ type: 'ready', self: SELF }));
    expect(result.current).toMatchObject({ isLoading: true, isReady: false, self: SELF });
    await server(() => FakeSocket.last.serverSend({ type: 'history', messages: [] }));
    expect(result.current).toMatchObject({ isLoading: false, isReady: true });
  });

  it('histórico recebido aparece em ordem, como mensagens confirmadas', async () => {
    const { result } = await startReady([serverMessage('a'), serverMessage('b')]);
    expect(texts(result)).toEqual([
      ['a', 'sent'],
      ['b', 'sent'],
    ]);
    expect(result.current.messages[0]).toMatchObject({ own: false, author: BRUNO });
  });

  it('mensagens em tempo real atualizam o hook pela assinatura da store', async () => {
    const { result } = await startReady();
    await server(() => FakeSocket.last.serverSend({ type: 'message', message: serverMessage('nova') }));
    expect(texts(result)).toEqual([['nova', 'sent']]);
  });
});

describe('useChat — envio, reconciliação, retry e discard', () => {
  it('envio otimista pela API do hook usa a conexão existente e reconcilia sem duplicar', async () => {
    const { result } = await startReady();
    let sendResult: ReturnType<typeof result.current.sendMessage> | undefined;
    await act(async () => {
      sendResult = result.current.sendMessage('olá');
    });
    expect(texts(result)).toEqual([['olá', 'pending']]);
    expect(FakeSocket.instances).toHaveLength(1); // nenhum socket novo
    const [frame] = sentFrames(FakeSocket.last);
    expect(sendResult).toEqual({ ok: true, key: `l:${frame!.nonce}`, nonce: frame!.nonce });

    await server(() => FakeSocket.last.serverSend({ type: 'message', message: serverMessage('olá', SELF), nonce: frame!.nonce }));
    expect(texts(result)).toEqual([['olá', 'sent']]);
    expect(result.current.messages[0]!.key).toBe(`l:${frame!.nonce}`);
  });

  it('rejeição do servidor mantém failed; discard remove', async () => {
    const { result } = await startReady();
    await act(async () => void result.current.sendMessage('x'));
    const { nonce } = sentFrames(FakeSocket.last)[0]!;
    await server(() => FakeSocket.last.serverSend({ type: 'error', code: 'message_too_long', nonce }));
    expect(result.current.messages[0]).toMatchObject({ status: 'failed', failure: { reason: 'rejected', code: 'message_too_long', retryable: false } });
    expect(result.current.retryMessage(`l:${nonce}`)).toBe(false);
    await act(async () => void result.current.discardMessage(`l:${nonce}`));
    expect(result.current.messages).toEqual([]);
  });

  it('retry reenvia com o mesmo nonce depois de uma parada definitiva', async () => {
    const { result } = await startReady();
    await act(async () => void result.current.sendMessage('oi'));
    const { nonce } = sentFrames(FakeSocket.last)[0]!;
    await server(() => FakeSocket.last.serverClose(4029, 'too_many_connections'));
    expect(result.current.messages[0]).toMatchObject({ status: 'failed', failure: { reason: 'connection_lost' } });
    expect(result.current.error).toEqual({ reason: 'limit', closeCode: 4029 });

    await act(async () => result.current.reconnect());
    await server(() => acceptConnection(FakeSocket.last));
    expect(result.current.error).toBeNull();
    await act(async () => void result.current.retryMessage(`l:${nonce}`));
    expect(sentFrames(FakeSocket.last)).toEqual([{ type: 'send', text: 'oi', nonce }]);
    expect(stores()).toHaveLength(1); // mesma sessão, mesma store
  });
});

describe('useChat — reconexão', () => {
  it('pendentes sobrevivem à reconexão automática e são confirmadas pelo histórico, sem duplicar', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { result } = await startReady([serverMessage('antiga')]);
      await act(async () => void result.current.sendMessage('durante a queda'));
      const first = FakeSocket.last;
      const { nonce } = sentFrames(first)[0]!;

      await server(() => first.networkFailure());
      expect(result.current.connectionState.status).toBe('reconnecting');
      expect(result.current.isLoading).toBe(true);
      expect(texts(result)).toEqual([
        ['antiga', 'sent'],
        ['durante a queda', 'pending'],
      ]);

      await act(async () => void vi.advanceTimersByTime(500));
      const second = FakeSocket.last;
      expect(second).not.toBe(first);
      const history = [serverMessage('antiga'), serverMessage('durante a queda', SELF, nonce)];
      history[0]!.id = result.current.messages[0]!.id!;

      // Sala reaberta, mas o histórico desta conexão ainda não chegou: ainda não está pronto.
      await server(() => {
        second.serverOpen();
        second.serverSend({ type: 'ready', self: SELF });
      });
      expect(result.current).toMatchObject({ connectionState: { status: 'ready' }, isReady: false, isLoading: true });
      await server(() => second.serverSend({ type: 'history', messages: history }));
      expect(result.current).toMatchObject({ isReady: true, isLoading: false });

      expect(texts(result)).toEqual([
        ['antiga', 'sent'],
        ['durante a queda', 'sent'],
      ]);
      expect(sentFrames(second)).toEqual([]); // o histórico provou a publicação: sem reenvio
      expect(stores()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('usuário saindo da instância (4003): erro left_instance e pendentes viram failed', async () => {
    const { result } = await startReady([serverMessage('a')]);
    await act(async () => void result.current.sendMessage('b'));
    await server(() => FakeSocket.last.serverClose(4003, 'not_in_instance'));
    expect(result.current).toMatchObject({ isReady: false, isLoading: false, error: { reason: 'left_instance', closeCode: 4003 } });
    expect(texts(result)).toEqual([
      ['a', 'sent'],
      ['b', 'failed'],
    ]);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('useChat — ciclo de vida e isolamento entre sessões', () => {
  it('StrictMode: uma store, um socket e nenhuma assinatura duplicada', async () => {
    const { result } = await startReady();
    expect(stores()).toHaveLength(1);
    expect(FakeSocket.instances).toHaveLength(1);
    const before = renders;
    await server(() => FakeSocket.last.serverSend({ type: 'message', message: serverMessage('x') }));
    // Um frame = uma mudança na store = um render (dobrado pelo StrictMode), não N.
    expect(renders - before).toBeLessThanOrEqual(2);
    expect(texts(result)).toEqual([['x', 'sent']]);
  });

  it('frames sem mudança não re-renderizam e o snapshot mantém a referência', async () => {
    const message = serverMessage('x');
    const { result } = await startReady([message]);
    const list = result.current.messages;
    const before = renders;
    await server(() => FakeSocket.last.serverSend({ type: 'message', message }));
    expect(renders).toBe(before);
    expect(result.current.messages).toBe(list);
  });

  it.each([
    ['instanceId', () => (fake.discord = sessionReady('i-2'))],
    ['token', () => (fake.token = 'token-2')],
  ])('mudança de %s: nova store vazia; mensagens e pendentes da anterior não aparecem', async (_label, change) => {
    const { result, rerender } = await startReady([serverMessage('da sessão 1')]);
    await act(async () => void result.current.sendMessage('pendente da sessão 1'));
    const [oldStore] = stores();
    const oldSocket = FakeSocket.last;

    change();
    rerender();
    expect(result.current.messages).toEqual([]); // nada da sessão anterior, nem por um render
    await flush();
    expect(stores()).toHaveLength(2);
    expect(oldStore!.send('depois')).toEqual({ ok: false, reason: 'disposed' });
    expect(oldSocket.closeCalls).toHaveLength(1);

    await server(() => acceptConnection(FakeSocket.last, [serverMessage('da sessão 2')]));
    expect(texts(result)).toEqual([['da sessão 2', 'sent']]);
    // Pendentes da sessão 1 não são enviadas com as credenciais novas.
    expect(sentFrames(FakeSocket.last)).toEqual([]);

    // Eventos atrasados da sessão antiga não atingem a nova.
    await server(() => {
      oldSocket.serverSend({ type: 'message', message: serverMessage('fantasma') });
      oldSocket.serverClose(4003, 'not_in_instance');
    });
    expect(texts(result)).toEqual([['da sessão 2', 'sent']]);
    expect(result.current.isReady).toBe(true);
  });

  it('sessão Discord deixando de estar pronta: descarta a store e volta ao estado neutro', async () => {
    const { result, rerender } = await startReady([serverMessage('a')]);
    fake.discord = { status: 'connecting', step: 'ready' };
    rerender();
    await flush();
    expect(result.current).toMatchObject({ messages: [], connectionState: { status: 'idle' }, isReady: false, isLoading: false });
    expect(stores()[0]!.send('x')).toEqual({ ok: false, reason: 'disposed' });
  });

  it('unmount: socket fechado, store descartada, timers e assinaturas limpos', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { result, unmount } = await startReady();
      await act(async () => void result.current.sendMessage('a')); // prazo de confirmação
      await server(() => FakeSocket.last.serverSend({ type: 'rate_limited', retryAfterMs: 5_000, nonce: sentFrames(FakeSocket.last)[0]!.nonce }));
      const socket = FakeSocket.last;
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
      expect(socket.listenerCount()).toBe(0);
      expect(socket.closeCalls).toEqual([{ code: 1000, reason: '' }]);
      const [store] = stores();
      const listener = vi.fn();
      store!.subscribe(listener);
      store!.handleFrame({ type: 'message', message: serverMessage('tarde') });
      expect(listener).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unmount antes da abertura: nenhuma store e nenhum socket são criados', async () => {
    fake.discord = sessionReady('i-1');
    fake.token = 'token-1';
    const { unmount } = renderChat();
    unmount();
    await flush();
    expect(stores()).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('a store não guarda o token', async () => {
    const { result } = await startReady();
    await act(async () => void result.current.sendMessage('oi'));
    expect(JSON.stringify(result.current)).not.toContain('token-1');
    expect(vi.mocked(createMessageStore).mock.calls[0]![0]).not.toHaveProperty('credentials');
    expect(JSON.stringify(Object.keys(vi.mocked(createMessageStore).mock.calls[0]![0]))).not.toContain('token');
  });
});

describe('useChat — defesa contra eventos tardios da sessão antiga', () => {
  it('callbacks e transport da sessão anterior, chamados após a troca, não atingem a nova', async () => {
    fake.discord = sessionReady('i-1');
    fake.token = 'token-1';
    const frames: string[] = [];
    const { result, rerender } = renderHook(
      () => {
        const chat = useChat();
        const connection = useChatConnection();
        return { chat, connection };
      },
      { wrapper },
    );
    await flush();
    await server(() => acceptConnection(FakeSocket.last, [serverMessage('sessão 1')]));
    const off = result.current.connection.subscribe((f) => frames.push(f.type));

    fake.discord = sessionReady('i-2');
    rerender();
    await flush();
    await server(() => acceptConnection(FakeSocket.last, [serverMessage('sessão 2')]));
    const newSocket = FakeSocket.last;
    const framesBefore = frames.length;

    // Simula uma conexão defeituosa que continua emitindo depois do dispose.
    const oldOptions = vi.mocked(createChatConnection).mock.calls[0]![0];
    const oldTransport = vi.mocked(createMessageStore).mock.calls[0]![0].transport;
    await act(async () => {
      oldOptions.onStateChange?.({ status: 'stopped', reason: 'left_instance', lastClose: null });
      oldOptions.onFrame?.({ type: 'message', message: serverMessage('fantasma') });
      expect(oldTransport.send('vazamento', 'nonce-velho')).toBe(false);
    });

    expect(result.current.chat.connectionState.status).toBe('ready');
    expect(result.current.chat.error).toBeNull();
    expect(texts({ current: result.current.chat })).toEqual([['sessão 2', 'sent']]);
    expect(frames).toHaveLength(framesBefore); // assinantes não recebem frames da sessão antiga
    expect(newSocket.sent).toHaveLength(1); // só o auth: nada enviado com as credenciais novas
    off();
  });
});

describe('useChat — perda de internet (provider liga rede e recycle)', () => {
  it('prazo da confirmação estourado: o provider recicla a conexão desta sessão', async () => {
    const { result } = await startReady();
    const options = vi.mocked(createMessageStore).mock.calls[0]![0];
    expect(options.onAckTimeout).toBeTypeOf('function');
    const socket = FakeSocket.last;
    let recycled = false;
    await act(async () => {
      recycled = options.onAckTimeout!();
    });
    expect(recycled).toBe(true);
    expect(socket.closeCalls).toEqual([{ code: 4902, reason: 'stalled' }]);
    expect(result.current.connectionState.status).toBe('reconnecting');
  });

  it('sem internet: estado offline no hook, pendente preservada, e reconexão quando a rede volta', async () => {
    const network = new FakeNetwork();
    fake.discord = sessionReady('i-1');
    fake.token = 'token-1';
    const { result } = renderHook(() => useChat(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <ChatConnectionProvider url="ws://test/api/chat" createSocket={(url) => new FakeSocket(url)} random={() => 0} network={network}>
            {children}
          </ChatConnectionProvider>
        </StrictMode>
      ),
    });
    await flush();
    await server(() => acceptConnection(FakeSocket.last));
    expect(network.listenerCount).toBe(1); // StrictMode: um ouvinte só

    await act(async () => network.set(false));
    expect(result.current.connectionState.status).toBe('ready'); // o evento sozinho não derruba
    await act(async () => FakeSocket.last.networkFailure()); // a queda real
    expect(result.current).toMatchObject({ connectionState: { status: 'offline' }, isReady: false, isLoading: true, error: null });
    await act(async () => void result.current.sendMessage('offline'));
    expect(texts(result)).toEqual([['offline', 'pending']]);

    await act(async () => network.set(true));
    await server(() => acceptConnection(FakeSocket.last));
    expect(result.current.isReady).toBe(true);
    expect(sentFrames(FakeSocket.last)).toEqual([{ type: 'send', text: 'offline', nonce: expect.any(String) }]);
  });
});

import { StrictMode } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordProvider } from '@/discord/DiscordProvider';
import { DiscordSessionError } from '@/discord/errors';
import type { DiscordParticipant, DiscordSession } from '@/discord/types';
import { ParticipantsView } from '@/features/participants/ParticipantsView';
import type { LaunchContext } from '@/lib/launch-context';
import { ChatConnectionProvider } from '@/realtime/ChatConnectionProvider';
import { useChatConnection } from '@/realtime/useChatConnection';
import { acceptConnection, FakeSocket } from './fake-socket';

/*
 * DiscordProvider, ParticipantsView e ChatConnectionProvider REAIS juntos.
 * Simulados: o fluxo de sessão (mesma memorização de session.ts), a API de
 * participantes do SDK e o WebSocket (FakeSocket).
 * Objetivo: o chat depende da sessão autenticada; os participantes não dependem do chat.
 */

const fake = vi.hoisted(() => {
  type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; promise: Promise<unknown> };
  return {
    session: { listener: null as null | ((step: string) => void), pending: null as Pending | null },
    token: null as string | null,
    participants: { list: [] as unknown[], handlers: new Set<(list: unknown[]) => void>(), subscribes: 0, unsubscribes: 0 },
  };
});

vi.mock('@/config/env', () => ({
  env: { discordClientId: '123456789012345678', isDiscordClientIdConfigured: true, isDev: true, mode: 'test' },
}));

vi.mock('@/discord/session', () => ({
  getAccessToken: () => fake.token,
  startDiscordSession(onStep: (step: string) => void) {
    fake.session.listener = onStep;
    if (fake.session.pending) return fake.session.pending.promise;
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending = { promise, resolve, reject };
    fake.session.pending = pending;
    promise.catch(() => {
      if (fake.session.pending === pending) fake.session.pending = null;
    });
    onStep('ready');
    return promise;
  },
}));

vi.mock('@/discord/participants', () => ({
  async fetchParticipants() {
    return fake.participants.list;
  },
  async subscribeParticipants(handler: (list: unknown[]) => void) {
    fake.participants.subscribes += 1;
    fake.participants.handlers.add(handler);
    return async () => {
      fake.participants.unsubscribes += 1;
      fake.participants.handlers.delete(handler);
    };
  },
}));

const person = (id: string, name: string): DiscordParticipant => ({
  id,
  username: name.toLowerCase(),
  displayName: name,
  globalName: name,
  avatarUrl: `https://cdn.discordapp.com/embed/avatars/${Number(id) % 6}.png`,
  bot: false,
});
const ANA = person('1', 'Ana');
const BRUNO = person('2', 'Bruno');

const session: DiscordSession = {
  user: { id: ANA.id, username: 'ana', globalName: 'Ana', avatarUrl: ANA.avatarUrl },
  scopes: ['identify', 'guilds'],
  expires: '2026-12-01T00:00:00.000Z',
  context: { instanceId: 'i-1-gc-2-3', platform: 'desktop', guildId: null, channelId: null, locationId: null },
  channel: null,
  guild: null,
};
const IN_DISCORD: LaunchContext = { isDiscord: true, platform: 'desktop', instanceId: 'i-1-gc-2-3', guildId: null, channelId: null };

function ChatStatus() {
  const { state } = useChatConnection();
  return <output aria-label="chat">{state.status === 'stopped' ? `stopped:${state.reason}` : state.status}</output>;
}

function renderApp() {
  return render(
    <StrictMode>
      <DiscordProvider launch={IN_DISCORD}>
        <ChatConnectionProvider url="ws://test/api/chat" createSocket={(url) => new FakeSocket(url)} random={() => 0}>
          <ParticipantsView />
          <ChatStatus />
        </ChatConnectionProvider>
      </DiscordProvider>
    </StrictMode>,
  );
}

const chatStatus = () => screen.getByLabelText('chat').textContent;
const participantsPanel = () => within(screen.getByRole('heading', { name: /participantes/i }).closest('section')!);
const flush = () => act(async () => undefined);

async function sdkReady() {
  await act(async () => fake.session.listener?.('authorize'));
}
async function sessionSucceeds() {
  fake.token = 'token-ana';
  await act(async () => fake.session.pending?.resolve(session));
}
async function pushParticipants(list: DiscordParticipant[]) {
  await act(async () => {
    for (const handler of fake.participants.handlers) handler(list);
  });
}

beforeEach(() => {
  FakeSocket.reset();
  fake.session.listener = null;
  fake.session.pending = null;
  fake.token = null;
  fake.participants.list = [ANA, BRUNO];
  fake.participants.handlers.clear();
  fake.participants.subscribes = 0;
  fake.participants.unsubscribes = 0;
});

describe('chat × sessão Discord × participantes', () => {
  it('participantes funcionam após o handshake enquanto o chat ainda espera a autenticação', async () => {
    renderApp();
    await sdkReady();
    expect(await participantsPanel().findByText('Bruno')).toBeInTheDocument();
    await flush();
    expect(chatStatus()).toBe('idle');
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('autenticação concluída: o chat conecta com o token da sessão, uma única vez', async () => {
    renderApp();
    await sdkReady();
    await sessionSucceeds();
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    await act(async () => acceptConnection(FakeSocket.last));
    expect(chatStatus()).toBe('ready');
    expect(JSON.parse(FakeSocket.last.sent[0]!)).toEqual({ type: 'auth', accessToken: 'token-ana', instanceId: 'i-1-gc-2-3' });
  });

  it('falha na autenticação Discord: participantes seguem ativos e o chat nem tenta conectar', async () => {
    renderApp();
    await sdkReady();
    await act(async () => fake.session.pending?.reject(new DiscordSessionError('backend_unreachable')));
    await pushParticipants([ANA, BRUNO, person('3', 'Carla')]);
    expect(participantsPanel().getByText('Carla')).toBeInTheDocument();
    await flush();
    expect(chatStatus()).toBe('idle');
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('chat reconectando não afeta a lista nem a inscrição de participantes', async () => {
    renderApp();
    await sdkReady();
    await sessionSucceeds();
    await participantsPanel().findByText('Bruno');
    await flush();
    const subscriptions = fake.participants.subscribes - fake.participants.unsubscribes;
    expect(subscriptions).toBe(1);

    await act(async () => FakeSocket.last.networkFailure());
    expect(chatStatus()).toBe('reconnecting');

    await pushParticipants([ANA, BRUNO, person('3', 'Carla')]);
    expect(participantsPanel().getByText('Carla')).toBeInTheDocument();
    expect(fake.participants.subscribes - fake.participants.unsubscribes).toBe(subscriptions);
  });

  it('fechamento definitivo do chat (4001 invalid_token): participantes continuam atualizando', async () => {
    renderApp();
    await sdkReady();
    await sessionSucceeds();
    await flush();
    await act(async () => {
      FakeSocket.last.serverOpen();
      FakeSocket.last.serverClose(4001, 'invalid_token');
    });
    expect(chatStatus()).toBe('stopped:session_expired');

    await pushParticipants([ANA, BRUNO, person('3', 'Carla')]);
    expect(participantsPanel().getByText('Carla')).toBeInTheDocument();
    expect(participantsPanel().getByText('Você')).toBeInTheDocument(); // sessão Discord intacta
  });
});

import { StrictMode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordState } from '@/discord/types';
import { ChatView } from '@/features/chat/ChatView';
import { HomeView } from '@/features/home/HomeView';
import { ChatConnectionProvider } from '@/realtime/ChatConnectionProvider';
import { acceptConnection, FakeSocket, SELF } from '../realtime/fake-socket';

/*
 * ChatView + useChat + ChatConnectionProvider + ChatConnection + message-store REAIS.
 * Simulados: a sessão Discord, o SDK (links e participantes) e o WebSocket (FakeSocket).
 */

const fake = vi.hoisted(() => ({
  discord: { status: 'connecting', step: 'ready' } as unknown,
  token: null as string | null,
  sdkReady: false,
  openExternalLink: null as null | ((args: { url: string }) => Promise<unknown>),
}));

vi.mock('@/discord/useDiscord', () => ({
  useDiscord: () => ({ state: fake.discord, sdkReady: fake.sdkReady, retry: () => undefined }),
}));
vi.mock('@/discord/session', () => ({ getAccessToken: () => fake.token }));
vi.mock('@/discord/sdk', () => ({
  getDiscordSdk: () => ({ commands: { openExternalLink: (args: { url: string }) => fake.openExternalLink!(args) } }),
}));
vi.mock('@/discord/participants', () => ({
  fetchParticipants: async () => [],
  subscribeParticipants: async () => async () => undefined,
}));

const ready = (instanceId = 'i-1'): DiscordState => ({
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

function renderView() {
  return render(
    <StrictMode>
      <ChatConnectionProvider url="ws://test/api/chat" createSocket={(url) => new FakeSocket(url)} random={() => 0}>
        <ChatView />
      </ChatConnectionProvider>
    </StrictMode>,
  );
}

const flush = () => act(async () => undefined);
const input = () => screen.getByRole('textbox', { name: 'Mensagem' });
const sendFrames = () => FakeSocket.instances.flatMap((s) => s.sent.map((raw) => JSON.parse(raw) as { type: string; text?: string; nonce?: string })).filter((f) => f.type === 'send');

beforeEach(() => {
  FakeSocket.reset();
  fake.discord = { status: 'connecting', step: 'ready' };
  fake.token = null;
  fake.sdkReady = false;
  fake.openExternalLink = null;
});

describe('ChatView integrado', () => {
  it('sem sessão: indisponível e nenhum socket', async () => {
    renderView();
    await flush();
    expect(screen.getByText('Indisponível')).toBeInTheDocument();
    expect(input()).toBeDisabled();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('fluxo completo pela interface: um socket, um frame de envio por mensagem, confirmação sem duplicar', async () => {
    fake.discord = ready();
    fake.token = 'token-1';
    renderView();
    await flush();
    await act(async () => acceptConnection(FakeSocket.last));
    expect(screen.getByText('Conectado')).toBeInTheDocument();

    fireEvent.change(input(), { target: { value: 'oi pessoal' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar mensagem' })); // clique no mesmo instante
    expect(sendFrames()).toEqual([{ type: 'send', text: 'oi pessoal', nonce: expect.any(String) }]);
    expect(FakeSocket.instances).toHaveLength(1);

    const { nonce } = sendFrames()[0]!;
    await act(async () =>
      FakeSocket.last.serverSend({
        type: 'message',
        message: { id: '00000000-0000-4000-8000-000000000001', author: SELF, text: 'oi pessoal', createdAt: '2026-11-20T15:00:00.000Z' },
        nonce,
      }),
    );
    const log = screen.getByRole('log');
    expect(within(log).getAllByText('oi pessoal')).toHaveLength(1);
    expect(log.querySelector('[data-status="sent"]')).not.toBeNull();
  });

  it('queda: mensagem fica pending; "Tentar agora" reconecta pela mesma conexão; o histórico confirma', async () => {
    fake.discord = ready();
    fake.token = 'token-1';
    renderView();
    await flush();
    await act(async () => acceptConnection(FakeSocket.last));
    await userEvent.type(input(), 'na queda{Enter}');
    const { nonce } = sendFrames()[0]!;

    await act(async () => FakeSocket.last.networkFailure());
    expect(screen.getByText('Reconectando')).toBeInTheDocument();
    expect(screen.getByRole('log').querySelector('[data-status="pending"]')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Tentar agora' }));
    expect(FakeSocket.instances).toHaveLength(2);
    await act(async () =>
      acceptConnection(FakeSocket.last, [
        { id: '00000000-0000-4000-8000-000000000002', author: SELF, text: 'na queda', createdAt: '2026-11-20T15:00:00.000Z', nonce },
      ]),
    );
    expect(within(screen.getByRole('log')).getAllByText('na queda')).toHaveLength(1);
    expect(sendFrames()).toHaveLength(1); // o histórico provou a publicação: sem reenvio
  });

  it('parada por limite: "Reconectar" abre nova tentativa na conexão existente', async () => {
    fake.discord = ready();
    fake.token = 'token-1';
    renderView();
    await flush();
    await act(async () => {
      FakeSocket.last.serverOpen();
      FakeSocket.last.serverClose(4029, 'too_many_connections');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Reconectar' }));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.live()).toHaveLength(1);
  });

  it('no Discord, links abrem pelo SDK (confirmação do próprio Discord)', async () => {
    fake.discord = ready();
    fake.token = 'token-1';
    fake.sdkReady = true;
    const opened: string[] = [];
    fake.openExternalLink = async ({ url }) => opened.push(url);
    renderView();
    await flush();
    await act(async () =>
      acceptConnection(FakeSocket.last, [
        { id: '00000000-0000-4000-8000-000000000003', author: SELF, text: 'https://discord.com/x', createdAt: '2026-11-20T15:00:00.000Z' },
      ]),
    );
    await userEvent.click(screen.getByRole('link', { name: 'https://discord.com/x' }));
    expect(opened).toEqual(['https://discord.com/x']);
  });
});

describe('HomeView com o chat', () => {
  it('chat vem antes dos participantes (empilhado no celular) e divide a grade no desktop', async () => {
    render(
      <ChatConnectionProvider url="ws://test/api/chat" createSocket={(url) => new FakeSocket(url)}>
        <HomeView launch={{ isDiscord: false, platform: 'unknown', instanceId: null, guildId: null, channelId: null }} />
      </ChatConnectionProvider>,
    );
    await flush();
    const chat = screen.getByRole('region', { name: 'Chat' });
    const participants = screen.getByRole('region', { name: 'Participantes' });
    expect(chat.compareDocumentPosition(participants) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const grid = chat.parentElement!;
    expect(grid.className).toContain('lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]');
    expect(participants.parentElement!.className).toContain('min-w-0');
    // Módulo Chat no roteiro agora aparece como disponível.
    const chatModule = screen.getByRole('heading', { name: 'Chat', level: 3 }).closest('li')!;
    expect(within(chatModule).getByText('Disponível')).toBeInTheDocument();
  });
});

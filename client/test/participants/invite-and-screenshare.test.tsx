import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordContext, type DiscordContextValue } from '@/discord/DiscordProvider';
import type { DiscordState } from '@/discord/types';
import { ParticipantsView } from '@/features/participants/ParticipantsView';
import { ScreenShareView } from '@/features/screenshare/ScreenShareView';

/*
 * Fase 3 — recursos do próprio Discord:
 * - convite pela tela oficial do Discord (commands.openInviteDialog);
 * - compartilhamento de tela: só orientação, porque o SDK não oferece captura de tela.
 */

const fake = vi.hoisted(() => ({ invite: vi.fn<() => Promise<unknown>>(), commands: [] as string[] }));

vi.mock('@/discord/sdk', () => ({
  getDiscordSdk: () =>
    new Proxy(
      { commands: { openInviteDialog: () => fake.invite() } },
      {
        get(target, prop) {
          fake.commands.push(String(prop));
          return target[prop as keyof typeof target];
        },
      },
    ),
}));

vi.mock('@/discord/participants', () => ({
  fetchParticipants: async () => [],
  subscribeParticipants: async () => async () => undefined,
}));

const READY = (platform: 'desktop' | 'mobile'): DiscordState => ({
  status: 'ready',
  session: {
    user: { id: '1', username: 'ana', globalName: 'Ana', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' },
    scopes: ['identify', 'guilds'],
    expires: '2026-12-01T00:00:00.000Z',
    context: { instanceId: 'i-1', platform, guildId: null, channelId: null, locationId: null },
    channel: null,
    guild: null,
  },
});

function renderWith(view: React.ReactNode, state: DiscordState, sdkReady = true) {
  const value: DiscordContextValue = { state, sdkReady, retry: () => {} };
  return render(<DiscordContext.Provider value={value}>{view}</DiscordContext.Provider>);
}

beforeEach(() => {
  fake.invite.mockReset();
  fake.commands.length = 0;
});

describe('Participantes — convidar pela tela do Discord', () => {
  it('com o SDK pronto: o botão abre o convite oficial do Discord', async () => {
    fake.invite.mockResolvedValue({});
    renderWith(<ParticipantsView />, READY('desktop'));
    await userEvent.click(await screen.findByRole('button', { name: 'Convidar para a Activity' }));
    expect(fake.invite).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('se o Discord recusar o comando: explica e não quebra a lista', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fake.invite.mockRejectedValue(Object.assign(new Error('nope'), { code: 4006 }));
    renderWith(<ParticipantsView />, READY('mobile'));
    await userEvent.click(await screen.findByRole('button', { name: 'Convidar para a Activity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/não abriu o convite/i);
    expect(warn).toHaveBeenCalledWith('[participants] openInviteDialog falhou (4006).');
  });

  it('antes de o SDK conectar (ou fora do Discord): sem o botão', () => {
    renderWith(<ParticipantsView />, { status: 'connecting', step: 'ready' }, false);
    expect(screen.queryByRole('button', { name: 'Convidar para a Activity' })).not.toBeInTheDocument();
    renderWith(<ParticipantsView />, { status: 'unavailable' }, false);
    expect(screen.queryAllByRole('button', { name: 'Convidar para a Activity' })).toHaveLength(0);
  });
});

describe('Compartilhar tela — orientação, sem captura', () => {
  it('no computador: mostra só o caminho do computador e deixa claro que é pelo Discord', () => {
    renderWith(<ScreenShareView />, READY('desktop'));
    expect(screen.getByRole('heading', { name: 'Compartilhar tela' })).toBeInTheDocument();
    expect(screen.getByText('Pelo Discord')).toBeInTheDocument();
    expect(screen.getByText(/Computador:/)).toBeInTheDocument();
    expect(screen.queryByText(/Celular:/)).not.toBeInTheDocument();
    expect(screen.getByText(/não captura nem recebe a sua tela/i)).toBeInTheDocument();
  });

  it('no celular: só o caminho do celular; sem sessão: os dois', () => {
    const { unmount } = renderWith(<ScreenShareView />, READY('mobile'));
    expect(screen.getByText(/Celular:/)).toBeInTheDocument();
    expect(screen.queryByText(/Computador:/)).not.toBeInTheDocument();
    unmount();
    renderWith(<ScreenShareView />, { status: 'unavailable' }, false);
    expect(screen.getByText(/Computador:/)).toBeInTheDocument();
    expect(screen.getByText(/Celular:/)).toBeInTheDocument();
  });

  it('não usa nenhuma API de captura do navegador nem comandos do SDK', () => {
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia }, configurable: true });
    renderWith(<ScreenShareView />, READY('desktop'));
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(fake.commands).toEqual([]);
  });
});

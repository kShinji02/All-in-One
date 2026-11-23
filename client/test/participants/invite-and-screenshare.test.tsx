import { act, fireEvent, render, screen } from '@testing-library/react';
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

const fake = vi.hoisted(() => ({ invite: vi.fn<() => Promise<unknown>>(), commands: [] as string[], hasInvite: true }));

vi.mock('@/discord/sdk', () => ({
  getDiscordSdk: () =>
    new Proxy(
      { get commands() { return fake.hasInvite ? { openInviteDialog: () => fake.invite() } : {}; } },
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
  fake.hasInvite = true;
});

const inviteButton = () => screen.findByRole('button', { name: 'Convidar participantes' });

describe('Participantes — convidar pela tela do Discord', () => {
  it('com o SDK pronto: "Convidar participantes" aparece no topo da seção, antes da lista, e abre o convite oficial', async () => {
    fake.invite.mockResolvedValue({});
    renderWith(<ParticipantsView />, READY('desktop'));
    const button = await inviteButton();
    const section = screen.getByRole('heading', { name: /participantes/i }).closest('section')!;
    expect(section).toContainElement(button);
    // Vem antes do conteúdo da lista (visível sem rolar).
    const notice = await screen.findByText('Ninguém conectado');
    expect(button.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button).toHaveAccessibleDescription(/tela de convite do próprio Discord/i);

    await userEvent.click(button);
    expect(fake.invite).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('enquanto o Discord abre o convite: "Abrindo convite…", desabilitado, e cliques repetidos não repetem o comando', async () => {
    let resolve!: () => void;
    fake.invite.mockImplementation(() => new Promise<void>((r) => (resolve = r)));
    renderWith(<ParticipantsView />, READY('desktop'));
    const button = await inviteButton();
    await userEvent.click(button);
    const busy = screen.getByRole('button', { name: 'Abrindo convite…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(busy);
    fireEvent.click(busy);
    expect(fake.invite).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    expect(await inviteButton()).toBeEnabled();
  });

  it('dois cliques no mesmo ciclo (antes de o botão desabilitar): um único comando', async () => {
    fake.invite.mockImplementation(() => new Promise(() => undefined));
    renderWith(<ParticipantsView />, READY('desktop'));
    const button = await inviteButton();
    act(() => {
      button.click();
      button.click();
    });
    expect(fake.invite).toHaveBeenCalledTimes(1);
  });

  it('Discord sem o comando (versão antiga): não chama nada e orienta a usar o convite do próprio Discord', async () => {
    fake.hasInvite = false;
    renderWith(<ParticipantsView />, READY('desktop'));
    await userEvent.click(await inviteButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/esta versão do discord não abre o convite pela activity/i);
    expect(fake.invite).not.toHaveBeenCalled();
  });

  it('se o Discord recusar o comando: orienta, registra só o código e permite tentar de novo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fake.invite.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 4006 })).mockResolvedValueOnce({});
    renderWith(<ParticipantsView />, READY('mobile'));
    await userEvent.click(await inviteButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/não abriu o convite agora/i);
    expect(warn).toHaveBeenCalledWith('[participants] openInviteDialog falhou (4006).');
    await userEvent.click(await inviteButton());
    expect(fake.invite).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('aparece mesmo com a autenticação em erro (o convite só depende do SDK conectado)', async () => {
    renderWith(<ParticipantsView />, { status: 'error', code: 'backend_unavailable', message: 'x', detail: null }, true);
    expect(await inviteButton()).toBeInTheDocument();
  });

  it('antes de o SDK conectar (ou fora do Discord): sem o botão', () => {
    renderWith(<ParticipantsView />, { status: 'connecting', step: 'ready' }, false);
    expect(screen.queryByRole('button', { name: 'Convidar participantes' })).not.toBeInTheDocument();
    renderWith(<ParticipantsView />, { status: 'unavailable' }, false);
    expect(screen.queryAllByRole('button', { name: 'Convidar participantes' })).toHaveLength(0);
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

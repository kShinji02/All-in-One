import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordState } from '@/discord/types';
import { MessageText } from '@/features/chat/components/MessageText';
import { ChatView } from '@/features/chat/ChatView';
import { ChatConnectionProvider } from '@/realtime/ChatConnectionProvider';
import { acceptConnection, FakeSocket, SELF } from '../realtime/fake-socket';

/*
 * Regressão: dentro do Discord, links de mensagens só podem abrir por
 * commands.openExternalLink (que mostra a confirmação do Discord). Nenhum gesto pode
 * cair na navegação nativa do iframe (window.open / target=_blank), que no Discord
 * Desktop pode abrir o navegador direto, sem confirmação.
 *
 * Simulados: a sessão Discord, o SDK (só openExternalLink) e o WebSocket.
 */

const fake = vi.hoisted(() => ({
  discord: { status: 'unavailable' } as unknown,
  sdkReady: false,
  token: null as string | null,
  calls: [] as { url: string }[],
  result: { opened: true } as { opened: boolean | null } | Error,
}));

vi.mock('@/discord/useDiscord', () => ({
  useDiscord: () => ({ state: fake.discord, sdkReady: fake.sdkReady, retry: () => undefined }),
}));
vi.mock('@/discord/session', () => ({ getAccessToken: () => fake.token }));
vi.mock('@/discord/sdk', () => ({
  getDiscordSdk: () => ({
    commands: {
      openExternalLink: async (args: { url: string }) => {
        fake.calls.push(args);
        if (fake.result instanceof Error) throw fake.result;
        return fake.result;
      },
    },
  }),
}));

const readyState = (): DiscordState => ({
  status: 'ready',
  session: {
    user: { id: SELF.id, username: 'ana', globalName: 'Ana', avatarUrl: SELF.avatarUrl },
    scopes: ['identify'],
    expires: '2026-12-01T00:00:00.000Z',
    context: { instanceId: 'i-1', platform: 'desktop', guildId: null, channelId: null, locationId: null },
    channel: null,
    guild: null,
  },
});

let windowOpen: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  FakeSocket.reset();
  fake.discord = { status: 'unavailable' };
  fake.sdkReady = false;
  fake.token = null;
  fake.calls = [];
  fake.result = { opened: true };
  windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
});
afterEach(() => {
  // Nenhum caminho pode usar window.open, em nenhum teste deste arquivo.
  expect(windowOpen).not.toHaveBeenCalled();
});

/** Renderiza o ChatView real com uma mensagem contendo `text` no histórico. */
async function renderWithMessage(text: string) {
  fake.token = 'token-1';
  render(
    <ChatConnectionProvider url="ws://test/api/chat" createSocket={(url) => new FakeSocket(url)} random={() => 0}>
      <ChatView />
    </ChatConnectionProvider>,
  );
  await act(async () => undefined);
  await act(async () =>
    acceptConnection(FakeSocket.last, [
      { id: '00000000-0000-4000-8000-000000000001', author: SELF, text, createdAt: '2026-11-20T15:00:00.000Z' },
    ]),
  );
}
const flushPromises = () => act(async () => undefined);

describe('MessageText — modo Discord (onOpenLink presente)', () => {
  const setup = () => {
    const onOpenLink = vi.fn();
    render(<MessageText text="veja https://example.com/a?b=1#c agora" onOpenLink={onOpenLink} />);
    return { onOpenLink, link: screen.getByRole('link', { name: 'https://example.com/a?b=1#c' }) };
  };

  it('o link não tem href nem target: não existe navegação nativa possível', () => {
    const { link } = setup();
    expect(link).not.toHaveAttribute('href');
    expect(link).not.toHaveAttribute('target');
    expect(link).toHaveAttribute('tabIndex', '0');
    expect(link).toHaveAttribute('title', 'https://example.com/a?b=1#c');
  });

  it.each([
    ['clique', {}],
    ['Ctrl+clique', { ctrlKey: true }],
    ['Cmd+clique', { metaKey: true }],
    ['Shift+clique', { shiftKey: true }],
  ])('%s: chama onOpenLink com a URL exata e cancela o padrão', (_label, init) => {
    const { onOpenLink, link } = setup();
    const notPrevented = fireEvent.click(link, init);
    expect(notPrevented).toBe(false);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith('https://example.com/a?b=1#c');
  });

  it('clique do meio (auxclick): também vai pelo onOpenLink', () => {
    const { onOpenLink, link } = setup();
    expect(fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(false);
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith('https://example.com/a?b=1#c');
  });

  it('mousedown do botão do meio: cancela o comportamento nativo sem abrir; abre uma vez no auxclick', () => {
    const { onOpenLink, link } = setup();
    expect(fireEvent.mouseDown(link, { button: 1 })).toBe(false); // padrão cancelado (rolagem automática etc.)
    expect(onOpenLink).not.toHaveBeenCalled();
    fireEvent.mouseUp(link, { button: 1 });
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith('https://example.com/a?b=1#c');
  });

  it('mousedown do botão esquerdo não é cancelado (foco e seleção continuam normais)', () => {
    const { onOpenLink, link } = setup();
    expect(fireEvent.mouseDown(link, { button: 0 })).toBe(true);
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it('botão direito (auxclick button 2) não abre nada', () => {
    const { onOpenLink, link } = setup();
    fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it('teclado: Enter no link focado abre pelo onOpenLink', async () => {
    const { onOpenLink, link } = setup();
    link.focus();
    await userEvent.keyboard('{Enter}');
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith('https://example.com/a?b=1#c');
  });
});

describe('MessageText — fora do Discord (sem onOpenLink)', () => {
  it('link comum em nova aba, com rel seguro', () => {
    render(<MessageText text="https://example.com/x" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com/x');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });
});

describe('ChatView → commands.openExternalLink', () => {
  it('dentro do Discord com o SDK pronto: o clique chama o SDK uma vez, com { url } exata', async () => {
    fake.discord = readyState();
    fake.sdkReady = true;
    await renderWithMessage('doc: https://example.com/caminho?q=a%20b&x=1#parte.');
    const link = screen.getByRole('link');
    expect(link).not.toHaveAttribute('href');
    await userEvent.click(link);
    expect(fake.calls).toEqual([{ url: 'https://example.com/caminho?q=a%20b&x=1#parte' }]);
  });

  it('URL internacional é passada normalizada (como o navegador a interpretaria)', async () => {
    fake.discord = readyState();
    fake.sdkReady = true;
    await renderWithMessage('https://exemplo.com.br/açaí');
    await userEvent.click(screen.getByRole('link'));
    expect(fake.calls).toEqual([{ url: 'https://exemplo.com.br/a%C3%A7a%C3%AD' }]);
  });

  it('clique do meio dentro do Discord também usa o SDK (não abre o navegador direto)', async () => {
    fake.discord = readyState();
    fake.sdkReady = true;
    await renderWithMessage('https://example.com/meio');
    fireEvent(screen.getByRole('link'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await flushPromises();
    expect(fake.calls).toEqual([{ url: 'https://example.com/meio' }]);
  });

  it('dentro do Discord com o SDK ainda não pronto: não abre nada (nem nativo, nem SDK)', async () => {
    fake.discord = readyState();
    fake.sdkReady = false;
    await renderWithMessage('https://example.com/cedo');
    const link = screen.getByRole('link');
    expect(link).not.toHaveAttribute('href'); // continua sem navegação nativa
    await userEvent.click(link);
    expect(fake.calls).toEqual([]);
  });

  it.each<[{ opened: boolean | null }, string]>([
    [{ opened: false }, 'declinado'],
    [{ opened: null }, 'cliente antigo'],
  ])('resposta %o (%s) é aceita sem erro e sem reabrir', async (result, _label) => {
    fake.discord = readyState();
    fake.sdkReady = true;
    fake.result = result;
    await renderWithMessage('https://example.com/r');
    await userEvent.click(screen.getByRole('link'));
    await flushPromises();
    expect(fake.calls).toHaveLength(1);
  });

  it('falha do SDK: sem alternativa nativa e o log não contém a URL', async () => {
    fake.discord = readyState();
    fake.sdkReady = true;
    fake.result = Object.assign(new Error('boom'), { code: 4006 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await renderWithMessage('https://example.com/segredo?token=abc');
    await userEvent.click(screen.getByRole('link'));
    await flushPromises();
    expect(fake.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith('[chat] openExternalLink falhou (4006).');
    expect(String(warn.mock.calls[0])).not.toContain('example.com');
  });

  it('fora do Discord: link nativo comum e o SDK nunca é chamado', async () => {
    fake.discord = { status: 'unavailable' };
    render(
      <ChatConnectionProvider url="ws://test/api/chat" createSocket={(url) => new FakeSocket(url)}>
        <MessageText text="https://example.com/fora" />
      </ChatConnectionProvider>,
    );
    expect(screen.getByRole('link')).toHaveAttribute('target', '_blank');
    expect(fake.calls).toEqual([]);
  });
});

describe('guarda estática do código-fonte', () => {
  async function sources(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : [])),
    );
    return nested.flat();
  }

  it('nenhum window.open/location.assign no app; openExternalLink e target="_blank" só nos lugares previstos', async () => {
    const root = path.resolve(process.cwd(), 'src');
    const files = await sources(root);
    const offenders: string[] = [];
    for (const file of files) {
      const code = await readFile(file, 'utf8');
      const rel = path.relative(root, file).replaceAll('\\', '/');
      if (/window\.open\s*\(|location\.(assign|replace)\s*\(|location\.href\s*=/.test(code)) offenders.push(`${rel}: navegação direta`);
      if (/commands\.openExternalLink/.test(code) && rel !== 'discord/external-link.ts') offenders.push(`${rel}: openExternalLink fora do módulo`);
      if (/target="_blank"/.test(code) && rel !== 'features/chat/components/MessageText.tsx') offenders.push(`${rel}: target=_blank`);
    }
    expect(offenders).toEqual([]);
  });
});

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageSquare, Radio, Users } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { HomeView } from '@/features/home/HomeView';
import type { FeatureModule } from '@/features/registry';
import type { LaunchContext } from '@/lib/launch-context';
import { ChatConnectionProvider } from '@/realtime/ChatConnectionProvider';
import { FakeSocket } from '../realtime/fake-socket';

/*
 * Home montada a partir do registro e isolamento de falhas por painel.
 * Simulados: a sessão Discord (fora do Discord), a API de participantes e o WebSocket.
 * O controle `fake.chatCrash` faz a ChatView REAL do registro lançar um erro de render.
 */

const fake = vi.hoisted(() => ({ chatCrash: false, sessionCrash: false }));

vi.mock('@/discord/useDiscord', () => ({
  useDiscord: () => ({ state: { status: 'unavailable' }, sdkReady: false, retry: () => undefined }),
}));
vi.mock('@/discord/session', () => ({ getAccessToken: () => null }));
vi.mock('@/discord/participants', () => ({
  fetchParticipants: async () => [],
  subscribeParticipants: async () => async () => undefined,
}));
vi.mock('@/features/chat/ChatView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/chat/ChatView')>();
  return {
    ChatView: () => {
      if (fake.chatCrash) throw new Error('dados privados da mensagem');
      return actual.ChatView();
    },
  };
});

vi.mock('@/features/session/ConnectionPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/session/ConnectionPanel')>();
  return {
    ConnectionPanel: () => {
      if (fake.sessionCrash) throw new TypeError('falha');
      return actual.ConnectionPanel();
    },
  };
});

const BROWSER: LaunchContext = { isDiscord: false, platform: 'unknown', instanceId: null, guildId: null, channelId: null };

function renderHome(modules?: readonly FeatureModule[]) {
  return render(
    <ChatConnectionProvider url="ws://test/api/chat" createSocket={(url) => new FakeSocket(url)}>
      <HomeView launch={BROWSER} modules={modules} />
    </ChatConnectionProvider>,
  );
}

let consoleError: MockInstance<typeof console.error>;
beforeEach(() => {
  FakeSocket.reset();
  fake.chatCrash = false;
  fake.sessionCrash = false;
  // O React registra no console os erros capturados por boundaries; aqui eles são esperados.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  consoleError.mockRestore();
});

describe('Home a partir do registro', () => {
  it('monta cada módulo disponível uma única vez, na área declarada, e a sessão na coluna lateral', async () => {
    renderHome();
    await act(async () => undefined);
    expect(screen.getAllByRole('region', { name: 'Chat' })).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: 'Participantes' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'Sessão Discord' })).toHaveLength(1);

    const chat = screen.getByRole('region', { name: 'Chat' });
    const aside = screen.getByRole('region', { name: 'Participantes' }).parentElement!;
    expect(chat.parentElement).toBe(aside.parentElement); // mesma grade: principal + lateral
    expect(within(aside).getByRole('heading', { name: 'Sessão Discord' })).toBeInTheDocument();
    // Ordem no DOM (empilhamento no celular): chat → participantes → sessão.
    const order = [chat, screen.getByRole('region', { name: 'Participantes' }), screen.getByRole('heading', { name: 'Sessão Discord' })];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('roteiro lista todos os módulos uma vez, com o status do registro', async () => {
    renderHome();
    await act(async () => undefined);
    const roadmap = screen.getByRole('heading', { name: 'Módulos' }).closest('section')!;
    const cards = within(roadmap).getAllByRole('listitem');
    expect(cards.map((c) => within(c).getByRole('heading', { level: 3 }).textContent)).toEqual([
      'Chat',
      'Participantes',
      'Comunicação',
      'Player de mídia',
    ]);
    expect(cards.map((c) => within(c).getByText(/Disponível|Planejado/).textContent)).toEqual([
      'Disponível',
      'Disponível',
      'Planejado',
      'Planejado',
    ]);
  });

  it('módulo planejado não monta view; módulo disponível novo aparece só por estar no registro', async () => {
    const Extra = () => <section aria-label="Extra">extra</section>;
    renderHome([
      { id: 'chat', name: 'Chat', description: 'd', icon: MessageSquare, accent: 'neon', status: 'available', slot: 'main', View: Extra },
      { id: 'participants', name: 'Participantes', description: 'd', icon: Users, accent: 'electric', status: 'planned' },
      { id: 'communication', name: 'Comunicação', description: 'd', icon: Radio, accent: 'neon', status: 'planned' },
    ]);
    await act(async () => undefined);
    expect(screen.getByRole('region', { name: 'Extra' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Participantes' })).toBeNull();
    expect(screen.queryByRole('log')).toBeNull(); // a ChatView real não foi montada
  });
});

describe('isolamento de falhas', () => {
  it('erro no chat: aviso no lugar do chat; participantes, sessão e ambiente continuam', async () => {
    fake.chatCrash = true;
    renderHome();
    await act(async () => undefined);

    const fallback = screen.getByRole('region', { name: 'Chat' });
    expect(within(fallback).getByRole('alert')).toHaveTextContent('Chat indisponível no momento');
    expect(screen.queryByRole('log')).toBeNull();
    expect(screen.getByRole('region', { name: 'Participantes' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sessão Discord' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ambiente' })).toBeInTheDocument();
  });

  it('o log do erro não contém a mensagem original (pode ter dados do usuário)', async () => {
    fake.chatCrash = true;
    renderHome();
    await act(async () => undefined);
    const ours = consoleError.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[home]'));
    expect(ours).toEqual(['[home] O painel "Chat" falhou (Error).']);
    expect(ours.join(' ')).not.toContain('dados privados');
  });

  it('"Tentar novamente" remonta só o painel que falhou', async () => {
    fake.chatCrash = true;
    renderHome();
    await act(async () => undefined);
    const participants = screen.getByRole('region', { name: 'Participantes' });

    fake.chatCrash = false;
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(screen.getByRole('log', { name: 'Mensagens do chat' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Participantes' })).toBe(participants); // não remontou
  });

  it('erro no painel de sessão: aviso no lugar dele; chat e participantes continuam', async () => {
    fake.sessionCrash = true;
    renderHome();
    await act(async () => undefined);
    expect(within(screen.getByRole('region', { name: 'Sessão Discord' })).getByRole('alert')).toHaveTextContent('Sessão Discord indisponível');
    expect(screen.getByRole('log', { name: 'Mensagens do chat' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Participantes' })).toBeInTheDocument();
  });

  it('erro num módulo da coluna lateral não derruba o chat', async () => {
    const Broken = () => {
      throw new Error('falha');
    };
    renderHome([
      { id: 'chat', name: 'Chat', description: 'd', icon: MessageSquare, accent: 'neon', status: 'available', slot: 'main', View: () => <section aria-label="Chat">ok</section> },
      { id: 'participants', name: 'Participantes', description: 'd', icon: Users, accent: 'electric', status: 'available', slot: 'aside', View: Broken },
    ]);
    await act(async () => undefined);
    expect(within(screen.getByRole('region', { name: 'Participantes' })).getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Chat' })).toHaveTextContent('ok');
    expect(screen.getByRole('heading', { name: 'Sessão Discord' })).toBeInTheDocument();
  });
});

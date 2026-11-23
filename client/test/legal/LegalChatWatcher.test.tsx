import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordContext, type DiscordContextValue } from '@/discord/DiscordProvider';
import type { DiscordState } from '@/discord/types';
import { LegalChatWatcher } from '@/legal/LegalChatWatcher';
import { LegalGate, useLegalGate } from '@/legal/LegalGate';
import { ChatConnectionContext, type ChatConnectionContextValue } from '@/realtime/ChatConnectionProvider';
import type { ChatConnectionState } from '@/realtime/chat-connection';

/*
 * Se o servidor fechar o chat com "legal_acceptance_required" (documentos atualizados
 * durante a sessão), a tela de aceite volta: o chat não continua liberado.
 */

vi.mock('@/discord/session', () => ({ getAccessToken: () => 'token-de-teste' }));

const DOCS = {
  terms: { version: 't-2', url: 'https://exemplo.test/terms.html' },
  privacy: { version: 'p-1', url: 'https://exemplo.test/privacy.html' },
};

afterEach(() => vi.unstubAllGlobals());

function Harness({ chatState }: { chatState: ChatConnectionState }) {
  const chat: ChatConnectionContextValue = { state: chatState, retry: () => {}, subscribe: () => () => {}, store: null, historyLoaded: false };
  return (
    <ChatConnectionContext.Provider value={chat}>
      <LegalChatWatcher />
      <p>CHAT</p>
    </ChatConnectionContext.Provider>
  );
}

/** Chat que o servidor fecha sempre com legal_acceptance_required (ex.: estados divergentes). */
const STOPPED: ChatConnectionState = {
  status: 'stopped',
  reason: 'legal_required',
  lastClose: { code: 4003, reason: 'legal_acceptance_required', category: 'legal_required' },
};

describe('LegalChatWatcher — proteção contra laço', () => {
  afterEach(() => vi.useRealTimers());

  it('status diz "aceito" mas o chat fecha sempre: verificações com backoff, uma por vez, chat desmontado na espera', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    let fetches = 0;
    vi.stubGlobal('fetch', async () => {
      fetches += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return new Response(JSON.stringify({ documents: DOCS, accepted: true, acceptedAt: '2026-11-01T00:00:00Z' }), { status: 200 });
    });
    const discord: DiscordContextValue = { state: { status: 'ready', session: {} as never } as DiscordState, sdkReady: true, retry: () => {} };
    render(
      <DiscordContext.Provider value={discord}>
        <LegalGate>
          <Harness chatState={STOPPED} />
        </LegalGate>
      </DiscordContext.Provider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const early = fetches;
    // 10 s de "laço": sem backoff seriam centenas de consultas.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(early).toBeLessThanOrEqual(3);
    expect(fetches).toBeLessThanOrEqual(7);
    expect(maxInFlight).toBe(1);

    // O intervalo cresce até o teto e não volta a zero enquanto o laço continuar.
    const before = fetches;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetches - before).toBeLessThanOrEqual(6);

    // Enquanto espera a próxima verificação, o chat não fica montado.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByRole('heading', { name: 'Antes de começar' })).not.toBeInTheDocument();
  });

  it('pedidos simultâneos de revalidação geram uma única consulta', async () => {
    let fetches = 0;
    vi.stubGlobal('fetch', async () => {
      fetches += 1;
      return new Response(JSON.stringify({ documents: DOCS, accepted: true, acceptedAt: '2026-11-01T00:00:00Z' }), { status: 200 });
    });
    function DoubleRecheck() {
      const { recheck } = useLegalGate();
      return (
        <button
          type="button"
          onClick={() => {
            recheck();
            recheck();
            recheck();
          }}
        >
          revalidar
        </button>
      );
    }
    const discord: DiscordContextValue = { state: { status: 'ready', session: {} as never } as DiscordState, sdkReady: true, retry: () => {} };
    render(
      <DiscordContext.Provider value={discord}>
        <LegalGate>
          <DoubleRecheck />
        </LegalGate>
      </DiscordContext.Provider>,
    );
    const button = await screen.findByRole('button', { name: 'revalidar' });
    expect(fetches).toBe(1);
    act(() => button.click());
    await screen.findByRole('button', { name: 'revalidar' });
    expect(fetches).toBe(2);
  });

  it('falha na revalidação pedida pelo chat não libera: mostra o erro', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ documents: DOCS, accepted: true, acceptedAt: '2026-11-01T00:00:00Z' }), { status: 200 })
        : new Response('{}', { status: 503 });
    });
    const discord: DiscordContextValue = { state: { status: 'ready', session: {} as never } as DiscordState, sdkReady: true, retry: () => {} };
    const view = (chatState: ChatConnectionState) => (
      <DiscordContext.Provider value={discord}>
        <LegalGate>
          <Harness chatState={chatState} />
        </LegalGate>
      </DiscordContext.Provider>
    );
    const { rerender } = render(view({ status: 'idle' }));
    expect(await screen.findByText('CHAT')).toBeInTheDocument();
    rerender(view(STOPPED));
    expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível falar com o servidor/i);
    expect(screen.queryByText('CHAT')).not.toBeInTheDocument();
  });
});

describe('LegalChatWatcher', () => {
  it('fora do Discord a Home renderiza com o watcher sem erro (regressão)', () => {
    const discord: DiscordContextValue = { state: { status: 'unavailable' }, sdkReady: false, retry: () => {} };
    render(
      <DiscordContext.Provider value={discord}>
        <LegalGate>
          <Harness chatState={{ status: 'idle' }} />
        </LegalGate>
      </DiscordContext.Provider>,
    );
    expect(screen.getByText('CHAT')).toBeInTheDocument();
  });

  it('fechamento legal_acceptance_required do servidor → volta para a tela de aceite', async () => {
    let accepted = true;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ documents: DOCS, accepted, acceptedAt: accepted ? '2026-11-01T00:00:00Z' : null }), { status: 200 }));
    const discord: DiscordContextValue = { state: { status: 'ready', session: {} as never } as DiscordState, sdkReady: true, retry: () => {} };

    const view = (chatState: ChatConnectionState) => (
      <DiscordContext.Provider value={discord}>
        <LegalGate>
          <Harness chatState={chatState} />
        </LegalGate>
      </DiscordContext.Provider>
    );
    const { rerender } = render(view({ status: 'idle' }));
    expect(await screen.findByText('CHAT')).toBeInTheDocument();

    accepted = false; // os documentos mudaram no servidor
    rerender(
      view({ status: 'stopped', reason: 'legal_required', lastClose: { code: 4003, reason: 'legal_acceptance_required', category: 'legal_required' } }),
    );
    expect(await screen.findByRole('heading', { name: 'Antes de começar' })).toBeInTheDocument();
    expect(screen.queryByText('CHAT')).not.toBeInTheDocument();
    expect(screen.getByText('versão t-2')).toBeInTheDocument();
  });
});

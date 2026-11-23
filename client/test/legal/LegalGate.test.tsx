import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordContext, type DiscordContextValue } from '@/discord/DiscordProvider';
import type { DiscordState } from '@/discord/types';
import { LegalGate } from '@/legal/LegalGate';

/*
 * Tela de aceite (LegalGate) com fetch simulado. O servidor é a única fonte da
 * confirmação: os testes verificam que nada é liberado sem a resposta dele.
 */

const fake = vi.hoisted(() => ({ token: 'token-de-teste' as string | null, exits: 0, links: [] as string[] }));

vi.mock('@/discord/session', () => ({ getAccessToken: () => fake.token }));
vi.mock('@/legal/exit-activity', () => ({
  exitActivity: () => {
    fake.exits += 1;
    return true;
  },
}));
vi.mock('@/discord/external-link', () => ({
  openExternalLink: async (url: string) => {
    fake.links.push(url);
    return 'opened';
  },
}));

const DOCS = {
  terms: { version: 't-1', url: 'https://exemplo.test/terms.html' },
  privacy: { version: 'p-1', url: 'https://exemplo.test/privacy.html' },
};
const DOCS_V2 = { ...DOCS, terms: { version: 't-2', url: DOCS.terms.url } };

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;
let handler: Handler;
const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(() => {
  fake.token = 'token-de-teste';
  fake.exits = 0;
  fake.links = [];
  calls.length = 0;
  handler = () => json(200, { documents: DOCS, accepted: false, acceptedAt: null });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, auth: headers.get('Authorization') });
    return handler(url, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

const READY: DiscordState = { status: 'ready', session: { user: { id: '205519959982473217' } } as never };

function renderGate(state: DiscordState = READY) {
  const value: DiscordContextValue = { state, sdkReady: state.status === 'ready', retry: () => {} };
  return render(
    <DiscordContext.Provider value={value}>
      <LegalGate>
        <p>RECURSOS DA ACTIVITY</p>
      </LegalGate>
    </DiscordContext.Provider>,
  );
}

const posts = () => calls.filter((c) => c.method === 'POST');
const acceptButton = () => screen.getByRole('button', { name: /aceitar e continuar/i });

describe('LegalGate — aceite dos documentos legais', () => {
  it('1. primeiro acesso sem aceite: mostra a tela e bloqueia os recursos', async () => {
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Antes de começar' })).toBeInTheDocument();
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();
    expect(screen.getByText('All-in-One · Discord Activity')).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ url: '/api/legal/status', method: 'GET', auth: 'Bearer token-de-teste' });

    const checkbox = screen.getByRole('checkbox', { name: /li e aceito os termos de uso e declaro ciência da política de privacidade/i });
    expect(checkbox).not.toBeChecked();
    expect(acceptButton()).toBeDisabled();
    expect(screen.getByText(/não é um consentimento para o tratamento de dados/i)).toBeInTheDocument();
  });

  it('links dos documentos abrem pelo Discord, com as URLs vindas do servidor', async () => {
    const user = userEvent.setup();
    renderGate();
    await user.click(await screen.findByRole('button', { name: /termos de uso/i }));
    await user.click(screen.getByRole('button', { name: /política de privacidade/i }));
    expect(fake.links).toEqual([DOCS.terms.url, DOCS.privacy.url]);
    expect(screen.getByText('versão t-1')).toBeInTheDocument();
  });

  it('2. aceite válido: registra no servidor e só libera depois da confirmação', async () => {
    const user = userEvent.setup();
    const response = deferred<Response>();
    handler = (url) => (url.endsWith('/acceptance') ? response.promise : json(200, { documents: DOCS, accepted: false, acceptedAt: null }));
    renderGate();

    await user.click(await screen.findByRole('checkbox'));
    expect(acceptButton()).toBeEnabled();
    await user.click(acceptButton());

    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({ url: '/api/legal/acceptance', body: { termsVersion: 't-1', privacyVersion: 'p-1' }, auth: 'Bearer token-de-teste' });
    expect(screen.getByRole('button', { name: /registrando/i })).toBeDisabled();
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();

    await act(async () => response.resolve(json(201, { accepted: true, acceptedAt: '2026-11-22T12:00:00.000Z', documents: DOCS })));
    expect(await screen.findByText('RECURSOS DA ACTIVITY')).toBeInTheDocument();
  });

  it('3. aceite anterior válido: libera direto, sem mostrar a tela nem registrar de novo', async () => {
    handler = () => json(200, { documents: DOCS, accepted: true, acceptedAt: '2026-11-01T00:00:00.000Z' });
    renderGate();
    expect(await screen.findByText('RECURSOS DA ACTIVITY')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Antes de começar' })).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('4/5. documentos atualizados durante o aceite (409): mostra as novas versões e exige marcar de novo', async () => {
    const user = userEvent.setup();
    handler = (url) =>
      url.endsWith('/acceptance')
        ? json(409, { error: 'version_mismatch', documents: DOCS_V2 })
        : json(200, { documents: DOCS, accepted: false, acceptedAt: null });
    renderGate();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(acceptButton());

    expect(await screen.findByText(/os documentos foram atualizados/i)).toBeInTheDocument();
    expect(screen.getByText('versão t-2')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(acceptButton()).toBeDisabled();
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();
  });

  it('6. recusa: nada é liberado, explica o motivo e permite sair ou rever', async () => {
    const user = userEvent.setup();
    renderGate();
    await user.click(await screen.findByRole('button', { name: 'Recusar' }));

    expect(screen.getByRole('heading', { name: 'O uso depende do aceite' })).toBeInTheDocument();
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /sair da activity/i }));
    expect(fake.exits).toBe(1);

    await user.click(screen.getByRole('button', { name: /rever documentos/i }));
    expect(screen.getByRole('heading', { name: 'Antes de começar' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('8. contornar pelo navegador: dados locais não liberam; só a resposta do servidor', async () => {
    localStorage.setItem('legal-accepted', 'true');
    sessionStorage.setItem('legal-accepted', 'true');
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Antes de começar' })).toBeInTheDocument();
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();
  });

  it('o aceite não grava nada no navegador', async () => {
    const user = userEvent.setup();
    handler = (url) =>
      url.endsWith('/acceptance') ? json(201, { accepted: true, acceptedAt: '2026-11-22T12:00:00.000Z', documents: DOCS }) : json(200, { documents: DOCS, accepted: false, acceptedAt: null });
    renderGate();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(acceptButton());
    await screen.findByText('RECURSOS DA ACTIVITY');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('10. clique duplicado: um único registro', async () => {
    const user = userEvent.setup();
    const response = deferred<Response>();
    handler = (url) => (url.endsWith('/acceptance') ? response.promise : json(200, { documents: DOCS, accepted: false, acceptedAt: null }));
    renderGate();
    await user.click(await screen.findByRole('checkbox'));
    const button = acceptButton();
    await user.dblClick(button);
    await user.click(button);
    expect(posts()).toHaveLength(1);
    await act(async () => response.resolve(json(201, { accepted: true, acceptedAt: '2026-11-22T12:00:00.000Z', documents: DOCS })));
    await screen.findByText('RECURSOS DA ACTIVITY');
    expect(posts()).toHaveLength(1);
  });

  it('10. dois cliques no mesmo ciclo de renderização (antes de o botão desabilitar): um único registro', async () => {
    const user = userEvent.setup();
    const response = deferred<Response>();
    handler = (url) => (url.endsWith('/acceptance') ? response.promise : json(200, { documents: DOCS, accepted: false, acceptedAt: null }));
    renderGate();
    await user.click(await screen.findByRole('checkbox'));
    const button = acceptButton();
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(posts()).toHaveLength(1);
    await act(async () => response.resolve(json(201, { accepted: true, acceptedAt: '2026-11-22T12:00:00.000Z', documents: DOCS })));
    await screen.findByText('RECURSOS DA ACTIVITY');
  });

  it('11. falha de comunicação ao verificar: bloqueia e oferece nova tentativa', async () => {
    const user = userEvent.setup();
    handler = () => {
      throw new TypeError('Failed to fetch');
    };
    renderGate();
    expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível falar com o servidor/i);
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();

    handler = () => json(200, { documents: DOCS, accepted: true, acceptedAt: '2026-11-01T00:00:00.000Z' });
    await user.click(screen.getByRole('button', { name: /tentar novamente/i }));
    expect(await screen.findByText('RECURSOS DA ACTIVITY')).toBeInTheDocument();
  });

  it('11. falha do servidor ao registrar (503): mostra o erro, mantém o bloqueio e permite tentar de novo', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    handler = (url) => {
      if (!url.endsWith('/acceptance')) return json(200, { documents: DOCS, accepted: false, acceptedAt: null });
      attempts += 1;
      return attempts === 1 ? json(503, { error: 'acceptance_unavailable' }) : json(201, { accepted: true, acceptedAt: '2026-11-22T12:00:00.000Z', documents: DOCS });
    };
    renderGate();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(acceptButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível falar com o servidor/i);
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeChecked();

    await user.click(acceptButton());
    expect(await screen.findByText('RECURSOS DA ACTIVITY')).toBeInTheDocument();
  });

  it('9. sem sessão válida (401 ou sem token): não libera e pede para recarregar', async () => {
    handler = () => json(401, { error: 'invalid_token' });
    renderGate();
    expect(await screen.findByRole('alert')).toHaveTextContent(/sessão do discord expirou/i);
    expect(screen.getByRole('button', { name: /recarregar activity/i })).toBeInTheDocument();
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();

    fake.token = null;
    calls.length = 0;
    renderGate();
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(1));
    expect(calls).toHaveLength(0);
  });

  it('respostas inválidas do servidor não liberam (ex.: accepted ausente)', async () => {
    handler = () => json(200, { documents: DOCS });
    renderGate();
    expect(await screen.findByRole('alert')).toHaveTextContent(/inesperada/i);
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();
  });

  it('enquanto o Discord conecta, nenhum recurso aparece e o servidor não é consultado', () => {
    renderGate({ status: 'connecting', step: 'authorize' });
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('fora do Discord (sem sessão possível) a Home aparece como antes', () => {
    renderGate({ status: 'unavailable' });
    expect(screen.getByText('RECURSOS DA ACTIVITY')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

/*
 * M2: prazo e cancelamento das chamadas /api/legal. A chamada "trava" até ser abortada,
 * como um backend que acorda devagar (Render Free) ou um proxy que não responde.
 */
describe('LegalGate — prazo e cancelamento das chamadas', () => {
  const signals: AbortSignal[] = [];
  /** Nunca responde; rejeita como o fetch real quando o sinal é abortado. */
  const hang = (init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      const signal = init.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });

  beforeEach(() => {
    signals.length = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('verificação sem resposta em 20 s: mostra a demora (servidor iniciando) e "Tentar novamente" funciona', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    handler = (_url, init) => hang(init);
    renderGate();
    expect(await screen.findByRole('status')).toHaveTextContent(/verificando/i);

    await act(async () => vi.advanceTimersByTime(19_000));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(1_500));

    expect(await screen.findByRole('alert')).toHaveTextContent(/demorou para responder; ele pode estar sendo iniciado/i);
    expect(signals[0]!.aborted).toBe(true);
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();

    handler = () => json(200, { documents: DOCS, accepted: true, acceptedAt: '2026-11-01T00:00:00.000Z' });
    await user.click(screen.getByRole('button', { name: /tentar novamente/i }));
    expect(await screen.findByText('RECURSOS DA ACTIVITY')).toBeInTheDocument();
  });

  it('desmontar a tela durante a verificação cancela a requisição', async () => {
    handler = (_url, init) => hang(init);
    const { unmount } = renderGate();
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]!.aborted).toBe(false);
    unmount();
    expect(signals[0]!.aborted).toBe(true);
  });

  it('registro sem resposta em 20 s: mantém o bloqueio e a caixa marcada; repetir é seguro', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let attempts = 0;
    handler = (url, init) => {
      if (!url.endsWith('/acceptance')) return json(200, { documents: DOCS, accepted: false, acceptedAt: null });
      attempts += 1;
      return attempts === 1 ? hang(init) : json(200, { accepted: true, acceptedAt: '2026-11-22T12:00:00.000Z', documents: DOCS });
    };
    renderGate();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(acceptButton());
    expect(screen.getByRole('button', { name: /registrando/i })).toBeDisabled();

    await act(async () => vi.advanceTimersByTime(20_500));
    expect(await screen.findByRole('alert')).toHaveTextContent(/demorou para responder/i);
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.queryByText('RECURSOS DA ACTIVITY')).not.toBeInTheDocument();

    await user.click(acceptButton());
    expect(await screen.findByText('RECURSOS DA ACTIVITY')).toBeInTheDocument();
    expect(posts()).toHaveLength(2);
    expect(posts()[1]!.body).toEqual(posts()[0]!.body);
  });

  it('desmontar durante o registro cancela o envio sem erro', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    handler = (url, init) => (url.endsWith('/acceptance') ? hang(init) : json(200, { documents: DOCS, accepted: false, acceptedAt: null }));
    const { unmount } = renderGate();
    await user.click(await screen.findByRole('checkbox'));
    await user.click(acceptButton());
    await waitFor(() => expect(signals).toHaveLength(1));
    unmount();
    expect(signals[0]!.aborted).toBe(true);
  });
});

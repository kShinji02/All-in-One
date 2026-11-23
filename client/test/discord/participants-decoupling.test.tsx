import { StrictMode } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordProvider } from '@/discord/DiscordProvider';
import { DiscordSessionError } from '@/discord/errors';
import type { DiscordParticipant, DiscordSession } from '@/discord/types';
import { ParticipantsView } from '@/features/participants/ParticipantsView';
import { ConnectionPanel } from '@/features/session/ConnectionPanel';
import type { LaunchContext } from '@/lib/launch-context';

/*
 * C1/C2/C3 — testes com DiscordProvider, ConnectionPanel e ParticipantsView REAIS.
 * São simulados apenas: a sessão (mesma semântica de memorização de session.ts),
 * a API de participantes do SDK e o recarregamento da página.
 */

const fake = vi.hoisted(() => {
  type Pending = { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const session = {
    calls: 0,
    listener: null as null | ((step: string) => void),
    current: 'ready',
    pending: null as Pending | null,
  };
  const participants = {
    list: [] as unknown[],
    fetchImpl: null as null | (() => Promise<unknown[]>),
    handlers: new Set<(list: unknown[]) => void>(),
    subscribes: 0,
    unsubscribes: 0,
    fetches: 0,
  };
  const reload = { calls: 0 };
  return { session, participants, reload };
});

vi.mock('@/config/env', () => ({
  env: { discordClientId: '123456789012345678', isDiscordClientIdConfigured: true, isDev: true, mode: 'test' },
}));

vi.mock('@/discord/session', () => ({
  getAccessToken: () => null,
  // Mesma semântica de startDiscordSession: memoriza a tentativa em andamento,
  // troca o ouvinte e libera nova tentativa quando a anterior falha.
  startDiscordSession(onStep: (step: string) => void) {
    const s = fake.session;
    s.calls += 1;
    s.listener = onStep;
    if (s.pending) {
      onStep(s.current);
      return s.pending.promise;
    }
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending = { promise, resolve, reject };
    s.pending = pending;
    promise.catch(() => {
      if (s.pending === pending) s.pending = null;
    });
    s.current = 'ready';
    onStep('ready');
    return promise;
  },
}));

vi.mock('@/discord/participants', () => ({
  async fetchParticipants() {
    fake.participants.fetches += 1;
    return fake.participants.fetchImpl ? fake.participants.fetchImpl() : fake.participants.list;
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

vi.mock('@/lib/reload-page', () => ({
  reloadPage: () => {
    fake.reload.calls += 1;
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

const sessionFor = (userId: string): DiscordSession => ({
  user: { id: userId, username: 'ana', globalName: 'Ana', avatarUrl: ANA.avatarUrl },
  scopes: ['identify', 'guilds'],
  expires: '2026-12-01T00:00:00.000Z',
  context: { instanceId: 'i-1-gc-2-3', platform: 'desktop', guildId: null, channelId: null, locationId: null },
  channel: null,
  guild: null,
});

const IN_DISCORD: LaunchContext = { isDiscord: true, platform: 'desktop', instanceId: 'i-1-gc-2-3', guildId: null, channelId: null };
const IN_BROWSER: LaunchContext = { isDiscord: false, platform: 'unknown', instanceId: null, guildId: null, channelId: null };

function renderApp(launch: LaunchContext = IN_DISCORD, random?: () => number) {
  return render(
    <StrictMode>
      <DiscordProvider launch={launch} random={random}>
        <ConnectionPanel />
        <ParticipantsView />
      </DiscordProvider>
    </StrictMode>,
  );
}

const sessionPanel = () => within(screen.getByRole('heading', { name: 'Sessão Discord' }).closest('section')!);
const participantsPanel = () => within(screen.getByRole('heading', { name: /participantes/i }).closest('section')!);
const activeSubscriptions = () => fake.participants.subscribes - fake.participants.unsubscribes;

/** Simula o SDK concluindo ready(): a sessão passa para a etapa seguinte. */
async function sdkBecomesReady() {
  await act(async () => fake.session.listener?.((fake.session.current = 'authorize')));
}
async function sessionFails(error: unknown) {
  await act(async () => {
    fake.session.pending?.reject(error);
  });
}
async function sessionSucceeds(userId = ANA.id) {
  await act(async () => {
    fake.session.pending?.resolve(sessionFor(userId));
  });
}
async function pushParticipants(list: DiscordParticipant[]) {
  await act(async () => {
    for (const handler of fake.participants.handlers) handler(list);
  });
}

beforeEach(() => {
  fake.session.calls = 0;
  fake.session.listener = null;
  fake.session.current = 'ready';
  fake.session.pending = null;
  fake.participants.list = [ANA, BRUNO];
  fake.participants.fetchImpl = null;
  fake.participants.handlers.clear();
  fake.participants.subscribes = 0;
  fake.participants.unsubscribes = 0;
  fake.participants.fetches = 0;
  fake.reload.calls = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('C1 — participantes desacoplados do OAuth', () => {
  it('antes do ready() do SDK: não assina participantes e mostra "Conectando ao Discord"', async () => {
    renderApp();
    expect(participantsPanel().getByText('Conectando ao Discord')).toBeInTheDocument();
    expect(fake.participants.subscribes).toBe(0);
    expect(fake.participants.fetches).toBe(0);
  });

  it('SDK pronto + sessão em erro (troca do código recusada): a lista carrega mesmo assim', async () => {
    renderApp();
    await sdkBecomesReady();
    await sessionFails(new DiscordSessionError('token_exchange_failed', 'HTTP 400 · invalid_grant'));

    const panel = participantsPanel();
    expect(await panel.findByText('Ana')).toBeInTheDocument();
    expect(panel.getByText('Bruno')).toBeInTheDocument();
    expect(panel.getByText('2 na Activity')).toBeInTheDocument();
    expect(panel.queryByText('Você')).toBeNull();
    expect(panel.getByText(/autenticação incompleta/i)).toBeInTheDocument();
    expect(panel.queryByText(/aguardando a sessão/i)).toBeNull();
    expect(sessionPanel().getByRole('button', { name: /tentar novamente/i })).toBeInTheDocument();
  });

  it('SDK pronto + OAuth falhando (autorização recusada): a lista também carrega', async () => {
    renderApp();
    await sdkBecomesReady();
    await sessionFails(new DiscordSessionError('authorize_failed', 'user cancelled'));
    expect(await participantsPanel().findByText('Bruno')).toBeInTheDocument();
    expect(participantsPanel().queryByText('Você')).toBeNull();
  });

  it('a lista começa antes do fim do OAuth (sem esperar troca de token)', async () => {
    renderApp();
    await sdkBecomesReady();
    // A sessão continua em andamento (token ainda não trocado).
    expect(await participantsPanel().findByText('Ana')).toBeInTheDocument();
    expect(sessionPanel().getByText(/em andamento/i)).toBeInTheDocument();
  });

  it('autenticação normal: o selo "Você" aparece no usuário autenticado, listado primeiro', async () => {
    renderApp();
    await sdkBecomesReady();
    await participantsPanel().findByText('Ana');
    expect(participantsPanel().queryByText('Você')).toBeNull();

    await sessionSucceeds(BRUNO.id);
    const items = participantsPanel().getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Bruno');
    expect(within(items[0]!).getByText('Você')).toBeInTheDocument();
    expect(participantsPanel().queryByText(/autenticação incompleta/i)).toBeNull();
  });

  it('StrictMode: uma única assinatura ativa; desmontar remove o ouvinte', async () => {
    const { unmount } = renderApp();
    await sdkBecomesReady();
    await participantsPanel().findByText('Ana');
    expect(activeSubscriptions()).toBe(1);
    unmount();
    await act(async () => undefined);
    expect(activeSubscriptions()).toBe(0);
  });

  it('o fim (sucesso ou erro) do OAuth não reinicia a assinatura dos participantes', async () => {
    renderApp();
    await sdkBecomesReady();
    await participantsPanel().findByText('Ana');
    const before = { subscribes: fake.participants.subscribes, fetches: fake.participants.fetches };
    await sessionSucceeds();
    expect(fake.participants.subscribes).toBe(before.subscribes);
    expect(fake.participants.fetches).toBe(before.fetches);
  });

  it('presença (regressão): entrada e saída por evento continuam funcionando', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp();
    await sdkBecomesReady();
    await participantsPanel().findByText('Ana');

    await pushParticipants([ANA, BRUNO, person('3', 'Carla')]);
    expect(participantsPanel().getByText('Carla')).toBeInTheDocument();
    expect(participantsPanel().getByText('3 na Activity')).toBeInTheDocument();

    await pushParticipants([ANA]);
    expect(participantsPanel().getByText('1 na Activity')).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(300));
    expect(participantsPanel().queryByText('Bruno')).toBeNull();
    expect(participantsPanel().queryByText('Carla')).toBeNull();
  });

  it('fora do Discord: não inicia a sessão nem os participantes', () => {
    renderApp(IN_BROWSER);
    expect(fake.session.calls).toBe(0);
    expect(fake.participants.subscribes).toBe(0);
    expect(participantsPanel().getByText('Fora do Discord')).toBeInTheDocument();
  });
});

describe('C2 — estados distintos: carregando, erro e lista vazia', () => {
  it('handshake falhou: Participantes mostra o erro real, não "Aguardando"', async () => {
    renderApp();
    await sessionFails(new DiscordSessionError('ready_timeout'));
    const panel = participantsPanel();
    expect(panel.getByText('Não foi possível conectar ao Discord')).toBeInTheDocument();
    expect(panel.getByText('ready_timeout')).toBeInTheDocument();
    expect(panel.getByText('Erro')).toBeInTheDocument();
    expect(panel.queryByText(/aguardando/i)).toBeNull();
    expect(fake.participants.subscribes).toBe(0);
  });

  it('carregando: esqueleto e "Carregando" enquanto a consulta não responde', async () => {
    fake.participants.fetchImpl = () => new Promise(() => undefined);
    renderApp();
    await sdkBecomesReady();
    const panel = participantsPanel();
    expect(await panel.findByText('Carregando')).toBeInTheDocument();
    expect(panel.queryByText('Ninguém conectado')).toBeNull();
    expect(panel.queryByRole('button', { name: /tentar novamente/i })).toBeNull();
  });

  it('erro da API de participantes: mensagem própria e "Tentar novamente" refaz a consulta', async () => {
    fake.participants.fetchImpl = () => Promise.reject(new Error('getActivityInstanceConnectedParticipants não respondeu em 10 s.'));
    renderApp();
    await sdkBecomesReady();
    const panel = participantsPanel();
    expect(await panel.findByText('Não foi possível obter os participantes da Activity.')).toBeInTheDocument();
    expect(panel.getByText(/não respondeu em 10 s/)).toBeInTheDocument();

    fake.participants.fetchImpl = null;
    const before = fake.participants.fetches;
    await userEvent.click(panel.getByRole('button', { name: /tentar novamente/i }));
    expect(await panel.findByText('Ana')).toBeInTheDocument();
    expect(fake.participants.fetches).toBeGreaterThan(before);
  });

  it('lista vazia: "Ninguém conectado", distinto de erro e de carregando', async () => {
    fake.participants.list = [];
    renderApp();
    await sdkBecomesReady();
    const panel = participantsPanel();
    expect(await panel.findByText('Ninguém conectado')).toBeInTheDocument();
    expect(panel.getByText('0 na Activity')).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /tentar novamente/i })).toBeNull();
  });
});

describe('C3 — handshake e nova tentativa', () => {
  it('timeout do handshake: o botão recarrega a Activity e não repete o fluxo na mesma instância', async () => {
    renderApp();
    await sessionFails(new DiscordSessionError('ready_timeout'));
    const panel = sessionPanel();
    expect(panel.getByText(/não respondeu a tempo/i)).toBeInTheDocument();
    expect(panel.queryByText(/recus/i)).toBeNull();
    expect(panel.queryByRole('button', { name: /tentar novamente/i })).toBeNull();

    const callsBefore = fake.session.calls;
    await userEvent.click(panel.getByRole('button', { name: /recarregar activity/i }));
    expect(fake.reload.calls).toBe(1);
    expect(fake.session.calls).toBe(callsBefore);
  });

  it('falha ao iniciar o SDK: também orienta a recarregar', async () => {
    renderApp();
    await sessionFails(new DiscordSessionError('sdk_init_failed', 'frame_id query param is not defined'));
    expect(sessionPanel().getByRole('button', { name: /recarregar activity/i })).toBeInTheDocument();
  });

  it('erro depois do handshake: "Tentar novamente" refaz o fluxo sem recarregar a página', async () => {
    renderApp();
    await sdkBecomesReady();
    await sessionFails(new DiscordSessionError('token_exchange_failed', 'HTTP 400 · invalid_grant'));
    const callsBefore = fake.session.calls;

    await userEvent.click(sessionPanel().getByRole('button', { name: /tentar novamente/i }));
    expect(fake.session.calls).toBeGreaterThan(callsBefore);
    expect(fake.reload.calls).toBe(0);
    expect(sessionPanel().queryByRole('button', { name: /recarregar activity/i })).toBeNull();

    // A nova tentativa conclui e a lista segue funcionando, agora com o selo "Você".
    await sessionSucceeds();
    expect(await participantsPanel().findByText('Você')).toBeInTheDocument();
  });
});

/*
 * Fase 2 — falhas passageiras do servidor (Render acordando, 502/503/504 do proxy, prazo,
 * rede instável): a sessão tenta de novo sozinha, com backoff e jitter, até 3 vezes.
 */
describe('Fase 2 — servidor iniciando: novas tentativas automáticas', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  async function failTransient(code: 'backend_unavailable' | 'backend_timeout' | 'backend_unreachable' = 'backend_unavailable') {
    await sessionFails(new DiscordSessionError(code, 'HTTP 502'));
  }

  it('502 do proxy: mostra "tentando de novo (1 de 3)", espera o backoff e refaz a sessão sozinha', async () => {
    renderApp(IN_DISCORD, () => 0); // jitter mínimo: 1ª espera = 1,5 s
    await sdkBecomesReady();
    const callsBefore = fake.session.calls;
    await failTransient();

    const panel = sessionPanel();
    expect(panel.getByRole('status')).toHaveTextContent(/servidor está iniciando ou instável.*\(1 de 3\)/i);
    expect(panel.queryByRole('button', { name: /tentar novamente/i })).toBeNull();
    expect(panel.queryByText('backend_unavailable')).toBeNull();

    await act(async () => vi.advanceTimersByTime(1_400));
    expect(fake.session.calls).toBe(callsBefore);
    await act(async () => vi.advanceTimersByTime(200));
    expect(fake.session.calls).toBeGreaterThan(callsBefore);

    await sessionSucceeds();
    expect(await panel.findByText('Conectado')).toBeInTheDocument();
    expect(panel.queryByRole('status')).toBeNull();
  });

  it('backoff cresce (1,5 s, 3 s, 6 s com jitter mínimo) e para depois de 3 tentativas, mostrando o erro', async () => {
    renderApp(IN_DISCORD, () => 0);
    await sdkBecomesReady();
    const waits = [1_500, 3_000, 6_000];
    for (const [index, wait] of waits.entries()) {
      await failTransient('backend_timeout');
      expect(sessionPanel().getByRole('status')).toHaveTextContent(`(${index + 1} de 3)`);
      const calls = fake.session.calls;
      await act(async () => vi.advanceTimersByTime(wait - 100));
      expect(fake.session.calls, `espera ${index + 1}`).toBe(calls);
      await act(async () => vi.advanceTimersByTime(100));
      expect(fake.session.calls).toBeGreaterThan(calls);
    }
    await failTransient('backend_timeout');
    const panel = sessionPanel();
    expect(panel.getByText('Erro')).toBeInTheDocument();
    expect(panel.getByText(/demorou para responder/i)).toBeInTheDocument();
    const calls = fake.session.calls;
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(fake.session.calls, 'sem novas tentativas sozinho (sem laço)').toBe(calls);

    // "Tentar novamente" zera a contagem: uma nova falha volta a tentar sozinha.
    await userEvent.click(panel.getByRole('button', { name: /tentar novamente/i }));
    await failTransient();
    expect(sessionPanel().getByRole('status')).toHaveTextContent('(1 de 3)');
  });

  it('jitter: com o máximo aleatório, a primeira espera é de 3 s', async () => {
    renderApp(IN_DISCORD, () => 1);
    await sdkBecomesReady();
    await failTransient('backend_unreachable');
    const calls = fake.session.calls;
    await act(async () => vi.advanceTimersByTime(2_900));
    expect(fake.session.calls).toBe(calls);
    await act(async () => vi.advanceTimersByTime(100));
    expect(fake.session.calls).toBeGreaterThan(calls);
  });

  it('sair da Activity durante a espera cancela a nova tentativa', async () => {
    const { unmount } = renderApp(IN_DISCORD, () => 0);
    await sdkBecomesReady();
    await failTransient();
    const calls = fake.session.calls;
    expect(vi.getTimerCount(), 'há uma espera agendada').toBeGreaterThan(0);
    unmount();
    // Nada fica agendado depois de sair (a espera da nova tentativa é cancelada, não só ignorada).
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(fake.session.calls).toBe(calls);
  });

  it('erros que não são passageiros (autorização recusada) não tentam de novo sozinhos', async () => {
    renderApp(IN_DISCORD, () => 0);
    await sdkBecomesReady();
    await sessionFails(new DiscordSessionError('authorize_failed', 'user cancelled'));
    const calls = fake.session.calls;
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(fake.session.calls).toBe(calls);
    expect(sessionPanel().getByRole('button', { name: /tentar novamente/i })).toBeInTheDocument();
  });
});

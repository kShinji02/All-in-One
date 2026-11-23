import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { env } from '@/config/env';
import { DiscordSessionError, describeUnknownError, isTransientSessionError } from '@/discord/errors';
import { startDiscordSession } from '@/discord/session';
import type { DiscordState } from '@/discord/types';
import { backoffDelay } from '@/lib/backoff';
import type { LaunchContext } from '@/lib/launch-context';

export interface DiscordContextValue {
  state: DiscordState;
  /**
   * true depois que o SDK concluiu ready() (handshake com o Discord).
   * Independe do OAuth: continua true mesmo se authorize/token/authenticate falharem.
   * Recursos que não exigem escopos (ex.: participantes) devem depender só disto.
   */
  sdkReady: boolean;
  /** Reinicia o fluxo após um erro. */
  retry: () => void;
}

export const DiscordContext = createContext<DiscordContextValue | null>(null);

/**
 * Novas tentativas automáticas da sessão quando o servidor falha de forma passageira
 * (backend acordando, 502/503/504 do proxy, prazo esgotado, rede instável). Depois delas,
 * o erro aparece com "Tentar novamente". Cada tentativa refaz o fluxo com um código OAuth novo.
 */
export const SESSION_AUTO_RETRY = Object.freeze({ maxAttempts: 3, baseMs: 3_000, maxMs: 15_000 });

function initialState(launch: LaunchContext): DiscordState {
  if (!launch.isDiscord) return { status: 'unavailable' };
  if (!env.isDiscordClientIdConfigured) return { status: 'misconfigured' };
  return { status: 'connecting', step: 'ready' };
}

interface DiscordProviderProps {
  launch: LaunchContext;
  children: ReactNode;
  /** Fonte do jitter do backoff (injetável nos testes). */
  random?: () => number;
}

export function DiscordProvider({ launch, children, random = Math.random }: DiscordProviderProps) {
  const [state, setState] = useState<DiscordState>(() => initialState(launch));
  const [sdkReady, setSdkReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** Tentativas automáticas já feitas desde a última ação do usuário ou sucesso. */
  const autoRetries = useRef(0);
  const jitter = useRef(random);
  jitter.current = random;

  const canConnect = launch.isDiscord && env.isDiscordClientIdConfigured;

  useEffect(() => {
    if (!canConnect) return;
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    startDiscordSession((step) => {
      if (!active) return;
      // As etapas seguintes a 'ready' só começam depois que sdk.ready() terminou.
      if (step !== 'ready') setSdkReady(true);
      setState((previous) =>
        previous.status === 'connecting' && previous.retry ? { status: 'connecting', step, retry: previous.retry } : { status: 'connecting', step },
      );
    })
      .then((session) => {
        if (!active) return;
        autoRetries.current = 0;
        setSdkReady(true);
        setState({ status: 'ready', session });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof DiscordSessionError && isTransientSessionError(error.code) && autoRetries.current < SESSION_AUTO_RETRY.maxAttempts) {
          // Falha passageira: mostra "tentando de novo" e repete sozinho, com backoff e jitter.
          autoRetries.current += 1;
          const retry = { attempt: autoRetries.current, maxAttempts: SESSION_AUTO_RETRY.maxAttempts };
          setState({ status: 'connecting', step: 'token', retry });
          retryTimer = setTimeout(() => setAttempt((n) => n + 1), backoffDelay(retry.attempt, SESSION_AUTO_RETRY, jitter.current));
          return;
        }
        if (error instanceof DiscordSessionError) {
          setState({ status: 'error', code: error.code, message: error.message, detail: error.detail });
        } else {
          setState({
            status: 'error',
            code: 'unexpected',
            message: 'Erro inesperado durante a conexão com o Discord.',
            detail: describeUnknownError(error),
          });
        }
      });

    return () => {
      // Saiu da Activity (ou nova tentativa): cancela a espera pendente.
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [canConnect, attempt]);

  const retry = useCallback(() => {
    autoRetries.current = 0;
    setState({ status: 'connecting', step: 'ready' });
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo(() => ({ state, sdkReady, retry }), [state, sdkReady, retry]);
  return <DiscordContext.Provider value={value}>{children}</DiscordContext.Provider>;
}

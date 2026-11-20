import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { env } from '@/config/env';
import { DiscordSessionError, describeUnknownError } from '@/discord/errors';
import { startDiscordSession } from '@/discord/session';
import type { DiscordState } from '@/discord/types';
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

function initialState(launch: LaunchContext): DiscordState {
  if (!launch.isDiscord) return { status: 'unavailable' };
  if (!env.isDiscordClientIdConfigured) return { status: 'misconfigured' };
  return { status: 'connecting', step: 'ready' };
}

interface DiscordProviderProps {
  launch: LaunchContext;
  children: ReactNode;
}

export function DiscordProvider({ launch, children }: DiscordProviderProps) {
  const [state, setState] = useState<DiscordState>(() => initialState(launch));
  const [sdkReady, setSdkReady] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const canConnect = launch.isDiscord && env.isDiscordClientIdConfigured;

  useEffect(() => {
    if (!canConnect) return;
    let active = true;

    startDiscordSession((step) => {
      if (!active) return;
      // As etapas seguintes a 'ready' só começam depois que sdk.ready() terminou.
      if (step !== 'ready') setSdkReady(true);
      setState({ status: 'connecting', step });
    })
      .then((session) => {
        if (!active) return;
        setSdkReady(true);
        setState({ status: 'ready', session });
      })
      .catch((error: unknown) => {
        if (!active) return;
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
      active = false;
    };
  }, [canConnect, attempt]);

  const retry = useCallback(() => {
    setState({ status: 'connecting', step: 'ready' });
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo(() => ({ state, sdkReady, retry }), [state, sdkReady, retry]);
  return <DiscordContext.Provider value={value}>{children}</DiscordContext.Provider>;
}

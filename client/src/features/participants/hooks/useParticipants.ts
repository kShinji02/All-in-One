import { useCallback, useEffect, useState } from 'react';
import { describeUnknownError } from '@/discord/errors';
import { fetchParticipants, subscribeParticipants } from '@/discord/participants';
import type { DiscordParticipant } from '@/discord/types';
import { useDiscord } from '@/discord/useDiscord';
import type { ParticipantsState } from '@/features/participants/types';

/**
 * Lista ao vivo dos participantes da instância da Activity.
 *
 * - Assina o evento ANTES da busca inicial para não perder mudanças no intervalo.
 *   Se um evento chegar antes da resposta inicial, a resposta (mais antiga) é descartada.
 * - Sem polling: atualizações chegam por ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE.
 *   Ao voltar a ficar visível (ex.: app móvel retomado), a lista é reconsultada uma vez.
 * - O listener é removido ao desmontar ou ao tentar novamente.
 */
export function useParticipants(): { state: ParticipantsState; retry: () => void } {
  // A API de participantes não exige escopos OAuth: basta o handshake (ready) do SDK.
  // Assim a lista funciona mesmo se o OAuth, a troca de token ou o Express falharem.
  const { sdkReady: enabled } = useDiscord();

  const [state, setState] = useState<ParticipantsState>({ status: enabled ? 'loading' : 'inactive' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'inactive' });
      return;
    }

    let disposed = false;
    // Incrementado a cada evento. Uma consulta só é aplicada se nenhum evento
    // chegou depois que ela começou; caso contrário, seu resultado está defasado.
    let eventVersion = 0;
    let unsubscribe: (() => Promise<void>) | null = null;

    const apply = (participants: DiscordParticipant[]) => {
      if (!disposed) setState({ status: 'ready', participants });
    };
    const fail = (error: unknown) => {
      if (!disposed) {
        setState({
          status: 'error',
          message: 'Não foi possível obter os participantes da Activity.',
          detail: describeUnknownError(error),
        });
      }
    };

    /** Consulta a lista e a aplica apenas se continuar sendo a informação mais recente. */
    const fetchLatest = async () => {
      const versionAtStart = eventVersion;
      const participants = await fetchParticipants();
      if (eventVersion === versionAtStart) apply(participants);
    };

    setState({ status: 'loading' });

    void (async () => {
      try {
        const unsub = await subscribeParticipants((participants) => {
          eventVersion += 1;
          apply(participants);
        });
        if (disposed) {
          await unsub();
          return;
        }
        unsubscribe = unsub;

        await fetchLatest();
      } catch (error) {
        fail(error);
      }
    })();

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchLatest().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void unsubscribe?.().catch(() => undefined);
    };
  }, [enabled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { state, retry };
}

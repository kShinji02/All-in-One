import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getAccessToken } from '@/discord/session';
import { useDiscord } from '@/discord/useDiscord';
import { ConnectionPanel } from '@/features/session/ConnectionPanel';
import { fetchLegalStatus, LegalApiError, submitLegalAcceptance, type LegalDocuments, type LegalErrorCode } from '@/legal/api';
import { AcceptanceScreen, DeclinedScreen, LegalCheckFailed, LegalChecking } from '@/legal/components/LegalScreens';
import { exitActivity } from '@/legal/exit-activity';

export type LegalGateState =
  | { status: 'checking' }
  | { status: 'required'; documents: LegalDocuments; submitting: boolean; error: LegalErrorCode | null; updated: boolean }
  | { status: 'declined'; documents: LegalDocuments; exitFailed: boolean }
  | { status: 'failed'; error: LegalErrorCode }
  | { status: 'accepted' };

/** Backoff das revalidações pedidas pelo chat. */
export const LEGAL_RECHECK_MAX_DELAY_MS = 30_000;
export const LEGAL_RECHECK_STABLE_MS = 60_000;

interface LegalGateContextValue {
  /**
   * Volta a consultar o servidor (ex.: o chat informou que o aceite deixou de valer).
   * Uma verificação por vez, com backoff em repetições seguidas; nunca libera sem o servidor.
   */
  recheck: () => void;
}

const LegalGateContext = createContext<LegalGateContextValue | null>(null);

export function useLegalGate(): LegalGateContextValue {
  const context = useContext(LegalGateContext);
  if (!context) throw new Error('useLegalGate deve ser usado dentro de <LegalGate>.');
  return context;
}

/**
 * Bloqueia a Activity até o aceite dos Termos de Uso e a ciência da Política de Privacidade.
 *
 * - Só libera `children` depois que o SERVIDOR confirma o aceite das versões atuais
 *   (GET /api/legal/status ou POST /api/legal/acceptance). Nada é guardado no navegador.
 * - Enquanto isso, chat e participantes não são montados: o ChatConnectionProvider fica
 *   dentro de `children`, então nenhum WebSocket é aberto antes do aceite.
 * - Fora do Discord (sem SDK) não há sessão nem recursos; a Home aparece como antes.
 * - O servidor também exige o aceite no chat: contornar esta tela não abre a sala.
 */
export function LegalGate({ children }: { children: ReactNode }) {
  const { state: discord } = useDiscord();
  const [state, setState] = useState<LegalGateState>({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const submitting = useRef(false);
  /** Envio do aceite em andamento: cancelado se o LegalGate for desmontado. */
  const submitController = useRef<AbortController | null>(null);
  useEffect(() => () => submitController.current?.abort(), []);
  const sessionReady = discord.status === 'ready';

  // Revalidações pedidas pelo chat (LegalChatWatcher): uma por vez e com backoff.
  const stateRef = useRef(state);
  stateRef.current = state;
  const nextDelay = useRef(0);
  const streak = useRef(0);
  const acceptedSince = useRef<number | null>(null);

  useEffect(() => {
    if (!sessionReady) return;
    let active = true;
    // Cancela a consulta em andamento se a verificação for refeita ou a tela desmontada.
    const controller = new AbortController();
    const delay = nextDelay.current;
    nextDelay.current = 0;
    setState({ status: 'checking' });

    const run = () => {
      const token = getAccessToken();
      if (!token) {
        setState({ status: 'failed', error: 'session_expired' });
        return;
      }
      fetchLegalStatus(token, { signal: controller.signal }).then(
        (status) => {
          if (!active) return;
          setState(
            status.accepted
              ? { status: 'accepted' }
              : { status: 'required', documents: status.documents, submitting: false, error: null, updated: false },
          );
        },
        (error: unknown) => {
          if (!active || (error instanceof LegalApiError && error.code === 'aborted')) return;
          setState({ status: 'failed', error: error instanceof LegalApiError ? error.code : 'unexpected' });
        },
      );
    };
    const timer = delay > 0 ? setTimeout(run, delay) : null;
    if (!timer) run();
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [sessionReady, attempt]);

  // Marca desde quando a Activity está liberada (zera o backoff depois de um período estável).
  useEffect(() => {
    if (state.status === 'accepted') acceptedSince.current = Date.now();
  }, [state.status]);

  /** Nova consulta imediata, pedida pelo usuário (botão "Tentar novamente"). */
  const recheckNow = useCallback(() => {
    nextDelay.current = 0;
    setAttempt((n) => n + 1);
  }, []);

  /**
   * Revalidação pedida pelo chat. Ignorada se já houver uma verificação em andamento ou a
   * Activity não estiver liberada. Repetições seguidas esperam cada vez mais (1 s, 2 s, 4 s…
   * até 30 s); o contador zera depois de 60 s liberada. Durante a espera o chat fica desmontado.
   */
  const recheckFromChat = useCallback(() => {
    if (stateRef.current.status !== 'accepted') return;
    const now = Date.now();
    if (acceptedSince.current !== null && now - acceptedSince.current >= LEGAL_RECHECK_STABLE_MS) streak.current = 0;
    nextDelay.current = streak.current === 0 ? 0 : Math.min(LEGAL_RECHECK_MAX_DELAY_MS, 1_000 * 2 ** (streak.current - 1));
    streak.current += 1;
    // Marca na hora (antes da próxima renderização): chamadas no mesmo ciclo são ignoradas.
    stateRef.current = { status: 'checking' };
    setState({ status: 'checking' });
    setAttempt((n) => n + 1);
  }, []);

  const accept = useCallback(async () => {
    if (state.status !== 'required' || submitting.current) return; // clique duplicado
    const token = getAccessToken();
    if (!token) return setState({ status: 'failed', error: 'session_expired' });
    submitting.current = true;
    const controller = new AbortController();
    submitController.current = controller;
    const { documents } = state;
    setState({ ...state, submitting: true, error: null });
    try {
      await submitLegalAcceptance(token, documents, { signal: controller.signal });
      setState({ status: 'accepted' });
    } catch (error) {
      // Desmontado durante o envio: não há tela para atualizar.
      if (controller.signal.aborted) return;
      if (error instanceof LegalApiError && error.code === 'version_mismatch' && error.documents) {
        // Os documentos mudaram: mostra as versões novas e exige marcar de novo.
        setState({ status: 'required', documents: error.documents, submitting: false, error: null, updated: true });
      } else {
        setState({ status: 'required', documents, submitting: false, error: error instanceof LegalApiError ? error.code : 'unexpected', updated: false });
      }
    } finally {
      submitting.current = false;
      if (submitController.current === controller) submitController.current = null;
    }
  }, [state]);

  const decline = useCallback(() => {
    if (state.status === 'required' && !state.submitting) setState({ status: 'declined', documents: state.documents, exitFailed: false });
  }, [state]);

  const review = useCallback(() => {
    if (state.status === 'declined') setState({ status: 'required', documents: state.documents, submitting: false, error: null, updated: false });
  }, [state]);

  const leave = useCallback(() => {
    if (state.status === 'declined' && !exitActivity()) setState({ ...state, exitFailed: true });
  }, [state]);

  const value = useMemo(() => ({ recheck: recheckFromChat }), [recheckFromChat]);

  // Fora do Discord não existe sessão nem recursos para bloquear.
  if (discord.status === 'unavailable' || discord.status === 'misconfigured') {
    return <LegalGateContext.Provider value={value}>{children}</LegalGateContext.Provider>;
  }

  // Conectando ou erro do Discord: mostra o progresso/erro (com "Tentar novamente"), sem os recursos.
  if (!sessionReady) {
    return (
      <LegalChecking>
        <ConnectionPanel />
      </LegalChecking>
    );
  }

  switch (state.status) {
    case 'checking':
      return <LegalChecking />;
    case 'failed':
      return <LegalCheckFailed error={state.error} onRetry={recheckNow} />;
    case 'required':
      return (
        <AcceptanceScreen
          key={`${state.documents.terms.version}|${state.documents.privacy.version}`}
          documents={state.documents}
          submitting={state.submitting}
          error={state.error}
          updated={state.updated}
          onAccept={accept}
          onDecline={decline}
        />
      );
    case 'declined':
      return <DeclinedScreen onReview={review} onLeave={leave} exitFailed={state.exitFailed} />;
    case 'accepted':
      return <LegalGateContext.Provider value={value}>{children}</LegalGateContext.Provider>;
  }
}

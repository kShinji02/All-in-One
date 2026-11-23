import { useEffect } from 'react';
import { useLegalGate } from '@/legal/LegalGate';
import { useChatConnection } from '@/realtime/useChatConnection';

/**
 * Se o servidor fechar o chat com "legal_acceptance_required" (ex.: os documentos foram
 * atualizados durante a sessão), volta a consultar o aceite: a tela de aceite reaparece.
 */
export function LegalChatWatcher() {
  const { state } = useChatConnection();
  const { recheck } = useLegalGate();
  const legalRequired = state.status === 'stopped' && state.reason === 'legal_required';

  useEffect(() => {
    if (legalRequired) recheck();
  }, [legalRequired, recheck]);

  return null;
}

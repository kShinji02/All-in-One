import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ChatConnectionState, ChatStopReason } from '@/realtime/chat-connection';
import type { ChatAuthor } from '@/realtime/chat-protocol';
import type { ChatEntry, MessageStoreSnapshot, SendResult } from '@/realtime/message-store';
import { useChatConnection } from '@/realtime/useChatConnection';

/** Erro relevante para a interface. Nunca contém token, texto de mensagem ou dados do usuário. */
export interface ChatError {
  /** Motivo da parada definitiva da conexão (ver chat-close-codes.ts). */
  reason: ChatStopReason;
  /** Código de fechamento WebSocket, quando houve um. */
  closeCode: number | null;
}

export type ChatSendResult = SendResult | { ok: false; reason: 'no_session' };

export interface UseChatResult {
  /** Mensagens confirmadas (ordem cronológica) seguidas das locais (pending/failed). */
  messages: readonly ChatEntry[];
  /** Usuário autenticado no chat (do frame "ready"); null antes dele. */
  self: ChatAuthor | null;
  connectionState: ChatConnectionState;
  /** Sala aberta e histórico aplicado: pronto para ler e enviar. */
  isReady: boolean;
  /** Há sessão, mas o histórico desta conexão ainda não chegou (e não parou de vez). */
  isLoading: boolean;
  /** Preenchido só quando a conexão parou e não vai tentar sozinha. */
  error: ChatError | null;
  /** Envio otimista. Funciona também desconectado: a mensagem espera a reconexão. */
  sendMessage: (text: string) => ChatSendResult;
  /** Nova tentativa de uma mensagem "failed" reenviável (mesmo nonce). */
  retryMessage: (key: string) => boolean;
  /** Remove da lista uma mensagem "failed" (só localmente). */
  discardMessage: (key: string) => boolean;
  /** Tenta reconectar depois de uma parada definitiva (ex.: limite de conexões). */
  reconnect: () => void;
}

const EMPTY: MessageStoreSnapshot = Object.freeze({ messages: Object.freeze([]), self: null });
const noopUnsubscribe = () => undefined;
const emptySnapshot = () => EMPTY;

/**
 * Chat da sessão atual. A store da sessão (criada pelo ChatConnectionProvider) é a
 * única fonte das mensagens; o hook só a assina com useSyncExternalStore, que lida
 * com StrictMode, troca de store e desmontagem sem estado duplicado.
 */
export function useChat(): UseChatResult {
  const { state: connectionState, store, historyLoaded, retry } = useChatConnection();

  // Funções estáveis por store: trocar de sessão troca a assinatura; re-render não.
  const subscribe = useMemo(() => (store ? store.subscribe : () => noopUnsubscribe), [store]);
  const getSnapshot = useMemo(() => (store ? store.getSnapshot : emptySnapshot), [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const sendMessage = useCallback(
    (text: string): ChatSendResult => (store ? store.send(text) : { ok: false, reason: 'no_session' }),
    [store],
  );
  const retryMessage = useCallback((key: string) => store?.retry(key) ?? false, [store]);
  const discardMessage = useCallback((key: string) => store?.discard(key) ?? false, [store]);

  const isReady = store !== null && connectionState.status === 'ready' && historyLoaded;
  const stopped = connectionState.status === 'stopped' ? connectionState : null;
  const error = useMemo<ChatError | null>(
    () => (stopped ? { reason: stopped.reason, closeCode: stopped.lastClose?.code ?? null } : null),
    [stopped],
  );

  return {
    messages: snapshot.messages,
    self: snapshot.self,
    connectionState,
    isReady,
    isLoading: store !== null && !isReady && stopped === null,
    error,
    sendMessage,
    retryMessage,
    discardMessage,
    reconnect: retry,
  };
}

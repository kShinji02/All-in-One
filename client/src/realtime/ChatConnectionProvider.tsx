import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getAccessToken } from '@/discord/session';
import { useDiscord } from '@/discord/useDiscord';
import {
  chatUrl,
  createChatConnection,
  type ChatConnection,
  type ChatConnectionState,
  type ChatCredentials,
  type NetworkMonitor,
  type Timers,
  type WebSocketLike,
} from '@/realtime/chat-connection';
import type { ServerFrame } from '@/realtime/chat-protocol';
import { createMessageStore, type MessageStore } from '@/realtime/message-store';

export type ChatFrameListener = (frame: ServerFrame) => void;

export interface ChatConnectionContextValue {
  state: ChatConnectionState;
  /** Nova tentativa manual após uma parada definitiva (ou antecipa a espera do backoff). */
  retry: () => void;
  /** Recebe os frames válidos da conexão atual. Devolve a função que cancela a inscrição. */
  subscribe: (listener: ChatFrameListener) => () => void;
  /**
   * Store de mensagens da sessão atual (null sem sessão). Nasce e morre junto com a
   * conexão: uma store por par token + instância. Use pelo hook useChat.
   */
  store: MessageStore | null;
  /** O histórico da conexão atual já foi aplicado à store. */
  historyLoaded: boolean;
}

/** Estado React de uma sessão do chat. `store` identifica a sessão dona do estado. */
interface ChatSessionState {
  store: MessageStore | null;
  connection: ChatConnectionState;
  historyLoaded: boolean;
}

const NO_SESSION: ChatSessionState = { store: null, connection: { status: 'idle' }, historyLoaded: false };

export const ChatConnectionContext = createContext<ChatConnectionContextValue | null>(null);

interface ChatConnectionProviderProps {
  children: ReactNode;
  /** Injeções para testes. Em produção, os padrões usam window.location e o WebSocket do navegador. */
  url?: string;
  createSocket?: (url: string) => WebSocketLike;
  timers?: Timers;
  random?: () => number;
  network?: NetworkMonitor;
}

/**
 * Mantém a conexão do chat enquanto houver uma sessão Discord autenticada.
 *
 * - Só conecta com token E instanceId; sem eles, o estado é "idle".
 * - Trocar o token ou a instância encerra a conexão anterior antes de abrir outra.
 * - Callbacks de uma conexão descartada nunca alteram o estado da atual.
 * - Cada conexão tem a SUA store de mensagens: frames e estados vão só para ela, e a
 *   store envia só por ela. Trocar de sessão descarta as duas juntas.
 * - É independente da lista de participantes: não altera nem lê o estado dela.
 */
export function ChatConnectionProvider({ children, url, createSocket, timers, random, network }: ChatConnectionProviderProps) {
  const { state: discord } = useDiscord();
  const accessToken = discord.status === 'ready' ? getAccessToken() : null;
  const instanceId = discord.status === 'ready' ? discord.session.context.instanceId : null;

  // Identidade estável por valor: re-renderizações não reabrem a conexão.
  const credentials = useMemo<ChatCredentials | null>(
    () => (accessToken && instanceId ? { accessToken, instanceId } : null),
    [accessToken, instanceId],
  );

  const [chat, setChat] = useState<ChatSessionState>(NO_SESSION);
  const connectionRef = useRef<ChatConnection | null>(null);
  const listenersRef = useRef(new Set<ChatFrameListener>());

  // As injeções são lidas uma vez por conexão; mudá-las não deve reconectar.
  const injected = useRef({ url, createSocket, timers, random, network });
  injected.current = { url, createSocket, timers, random, network };

  useEffect(() => {
    setChat(NO_SESSION);
    if (!credentials) return;

    let active = true;
    let connection: ChatConnection | null = null;
    let store: MessageStore | null = null;

    // Adia a criação: no StrictMode, o efeito é montado, desmontado e montado de novo
    // em sequência; assim a primeira montagem não cria conexão, store nem socket.
    queueMicrotask(() => {
      if (!active) return;
      const deps = injected.current;
      // A store só envia pela conexão desta sessão (nunca com credenciais de outra).
      const sessionStore = createMessageStore({
        transport: { send: (text, nonce) => connection?.send(text, nonce) ?? false },
        // Sem confirmação no prazo com a sala "aberta": a conexão está morta; recicla.
        onAckTimeout: () => connection?.recycle() ?? false,
        timers: deps.timers,
      });
      /** Atualiza o estado React só se ele ainda for desta sessão. */
      const update = (patch: (prev: ChatSessionState) => ChatSessionState) =>
        setChat((prev) => (prev.store === sessionStore ? patch(prev) : prev));

      const sessionConnection = createChatConnection({
        url: deps.url ?? chatUrl(),
        credentials,
        createSocket: deps.createSocket,
        timers: deps.timers,
        random: deps.random,
        network: deps.network,
        onStateChange: (next) => {
          if (!active) return;
          sessionStore.handleConnectionState(next);
          // Toda mudança de estado precede um novo histórico (ou encerra o atual).
          update((prev) => ({ ...prev, connection: next, historyLoaded: false }));
        },
        onFrame: (frame) => {
          if (!active) return;
          sessionStore.handleFrame(frame);
          if (frame.type === 'history') update((prev) => ({ ...prev, historyLoaded: true }));
          for (const listener of [...listenersRef.current]) listener(frame);
        },
      });

      store = sessionStore;
      connection = sessionConnection;
      connectionRef.current = sessionConnection;
      setChat({ store: sessionStore, connection: sessionConnection.getState(), historyLoaded: false });
      sessionConnection.start();
    });

    return () => {
      active = false;
      // Conexão primeiro (não chegam mais frames), depois a store (timers e assinaturas).
      connection?.dispose();
      store?.dispose();
      if (connectionRef.current === connection) connectionRef.current = null;
    };
  }, [credentials]);

  const retry = useCallback(() => connectionRef.current?.retry(), []);

  const subscribe = useCallback((listener: ChatFrameListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value = useMemo<ChatConnectionContextValue>(
    () => ({ state: chat.connection, retry, subscribe, store: chat.store, historyLoaded: chat.historyLoaded }),
    [chat, retry, subscribe],
  );
  return <ChatConnectionContext.Provider value={value}>{children}</ChatConnectionContext.Provider>;
}

import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getAccessToken } from '@/discord/session';
import { useDiscord } from '@/discord/useDiscord';
import {
  chatUrl,
  createChatConnection,
  type ChatConnection,
  type ChatConnectionState,
  type ChatCredentials,
  type Timers,
  type WebSocketLike,
} from '@/realtime/chat-connection';
import type { ServerFrame } from '@/realtime/chat-protocol';

export type ChatFrameListener = (frame: ServerFrame) => void;

export interface ChatConnectionContextValue {
  state: ChatConnectionState;
  /** Nova tentativa manual após uma parada definitiva (ou antecipa a espera do backoff). */
  retry: () => void;
  /** Recebe os frames válidos da conexão atual. Devolve a função que cancela a inscrição. */
  subscribe: (listener: ChatFrameListener) => () => void;
}

export const ChatConnectionContext = createContext<ChatConnectionContextValue | null>(null);

interface ChatConnectionProviderProps {
  children: ReactNode;
  /** Injeções para testes. Em produção, os padrões usam window.location e o WebSocket do navegador. */
  url?: string;
  createSocket?: (url: string) => WebSocketLike;
  timers?: Timers;
  random?: () => number;
}

/**
 * Mantém a conexão do chat enquanto houver uma sessão Discord autenticada.
 *
 * - Só conecta com token E instanceId; sem eles, o estado é "idle".
 * - Trocar o token ou a instância encerra a conexão anterior antes de abrir outra.
 * - Callbacks de uma conexão descartada nunca alteram o estado da atual.
 * - É independente da lista de participantes: não altera nem lê o estado dela.
 */
export function ChatConnectionProvider({ children, url, createSocket, timers, random }: ChatConnectionProviderProps) {
  const { state: discord } = useDiscord();
  const accessToken = discord.status === 'ready' ? getAccessToken() : null;
  const instanceId = discord.status === 'ready' ? discord.session.context.instanceId : null;

  // Identidade estável por valor: re-renderizações não reabrem a conexão.
  const credentials = useMemo<ChatCredentials | null>(
    () => (accessToken && instanceId ? { accessToken, instanceId } : null),
    [accessToken, instanceId],
  );

  const [state, setState] = useState<ChatConnectionState>({ status: 'idle' });
  const connectionRef = useRef<ChatConnection | null>(null);
  const listenersRef = useRef(new Set<ChatFrameListener>());

  // As injeções são lidas uma vez por conexão; mudá-las não deve reconectar.
  const injected = useRef({ url, createSocket, timers, random });
  injected.current = { url, createSocket, timers, random };

  useEffect(() => {
    setState({ status: 'idle' });
    if (!credentials) return;

    let active = true;
    const deps = injected.current;
    const connection = createChatConnection({
      url: deps.url ?? chatUrl(),
      credentials,
      createSocket: deps.createSocket,
      timers: deps.timers,
      random: deps.random,
      onStateChange: (next) => {
        if (active) setState(next);
      },
      onFrame: (frame) => {
        if (!active) return;
        for (const listener of [...listenersRef.current]) listener(frame);
      },
    });
    connectionRef.current = connection;

    // Adia a abertura: no StrictMode, o efeito é montado, desmontado e montado de novo
    // em sequência; assim a primeira montagem não chega a criar um socket.
    queueMicrotask(() => {
      if (active) connection.start();
    });

    return () => {
      active = false;
      connection.dispose();
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

  const value = useMemo(() => ({ state, retry, subscribe }), [state, retry, subscribe]);
  return <ChatConnectionContext.Provider value={value}>{children}</ChatConnectionContext.Provider>;
}

import { act, render } from '@testing-library/react';
import { useState, useSyncExternalStore } from 'react';
import { vi } from 'vitest';
import { ChatPanel } from '@/features/chat/components/ChatPanel';
import type { ChatConnectionState } from '@/realtime/chat-connection';
import type { ChatAuthor, ChatMessage } from '@/realtime/chat-protocol';
import { createMessageStore, type MessageStore } from '@/realtime/message-store';
import type { UseChatResult } from '@/realtime/useChat';

/*
 * Monta o ChatPanel com uma message-store REAL e um estado de conexão controlado
 * pelo teste. O UseChatResult é derivado como o useChat faz (mesmos campos), e as
 * ações do painel chamam a store de verdade: a interface é testada sem reimplementar
 * reconciliação.
 */

export const ANA: ChatAuthor = { id: '205519959982473217', username: 'ana', displayName: 'Ana', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' };
export const BRUNO: ChatAuthor = { id: '175928847299117063', username: 'bruno', displayName: 'Bruno', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png' };

let seq = 0;
export function resetMessages() {
  seq = 0;
}
export const BASE_TIME = Date.UTC(2026, 10, 20, 15, 0, 0);
export function message(text: string, author: ChatAuthor = BRUNO, { minute, nonce }: { minute?: number; nonce?: string } = {}): ChatMessage {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    author,
    text,
    createdAt: new Date(BASE_TIME + (minute ?? seq) * 60_000).toISOString(),
    ...(nonce ? { nonce } : {}),
  };
}

const READY: ChatConnectionState = { status: 'ready', self: ANA };

export function renderChat() {
  const sent: { text: string; nonce: string }[] = [];
  const store: MessageStore = createMessageStore({
    transport: { send: (text, nonce) => (sent.push({ text, nonce }), true) },
    generateNonce: () => `nonce-${sent.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
    now: () => BASE_TIME + 30 * 60_000,
  });
  const reconnect = vi.fn();
  const reload = vi.fn();
  const openLink = vi.fn();
  const sendSpy = vi.fn((text: string) => store.send(text));
  let setState: (s: { connection: ChatConnectionState; historyLoaded: boolean }) => void = () => undefined;

  function Harness() {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const [state, set] = useState<{ connection: ChatConnectionState; historyLoaded: boolean }>({
      connection: { status: 'connecting', attempt: 1 },
      historyLoaded: false,
    });
    setState = set;
    const { connection, historyLoaded } = state;
    const isReady = connection.status === 'ready' && historyLoaded;
    const chat: UseChatResult = {
      messages: snapshot.messages,
      self: snapshot.self,
      connectionState: connection,
      isReady,
      isLoading: !isReady && connection.status !== 'stopped' && connection.status !== 'idle',
      error: connection.status === 'stopped' ? { reason: connection.reason, closeCode: connection.lastClose?.code ?? null } : null,
      sendMessage: sendSpy,
      retryMessage: (key) => store.retry(key),
      discardMessage: (key) => store.discard(key),
      reconnect,
    };
    return <ChatPanel chat={chat} onReload={reload} onOpenLink={openLink} now={new Date(BASE_TIME + 60 * 60_000)} />;
  }

  const view = render(<Harness />);

  const setConnection = (connection: ChatConnectionState, historyLoaded = false) =>
    act(() => {
      store.handleConnectionState(connection);
      setState({ connection, historyLoaded });
    });

  /** Abre a sala como a conexão faz: estado ready → frame ready → history. */
  const openRoom = (history: ChatMessage[] = []) =>
    act(() => {
      store.handleConnectionState(READY);
      store.handleFrame({ type: 'ready', self: ANA });
      store.handleFrame({ type: 'history', messages: history });
      setState({ connection: READY, historyLoaded: true });
    });

  const receive = (m: ChatMessage, nonce?: string) =>
    act(() => store.handleFrame(nonce ? { type: 'message', message: m, nonce } : { type: 'message', message: m }));

  /** Confirmação do servidor para o envio de índice `index`. */
  const confirm = (index: number) => {
    const s = sent[index]!;
    return receive(message(s.text.trim(), ANA), s.nonce);
  };
  const reject = (index: number, code = 'message_too_long') =>
    act(() => store.handleFrame({ type: 'error', code, known: true, nonce: sent[index]!.nonce }));

  return { ...view, store, sent, reconnect, reload, openLink, sendSpy, setConnection, openRoom, receive, confirm, reject };
}

/*
 * Geometria de rolagem: o jsdom não faz layout. Para o elemento role="log",
 * scrollHeight = 100px por mensagem, clientHeight = 300px (200px com o banner) e
 * scrollTop é guardado.
 */
export const ROW_PX = 100;
export const VIEW_PX = 300;
export const BANNER_PX = 100;
const scrollTops = new WeakMap<Element, number>();
const saved: [string, PropertyDescriptor | undefined][] = [];

export function installScrollGeometry() {
  const proto = HTMLElement.prototype;
  for (const name of ['scrollHeight', 'clientHeight', 'scrollTop']) saved.push([name, Object.getOwnPropertyDescriptor(Element.prototype, name)]);
  const isLog = (el: Element) => el.getAttribute('role') === 'log';
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isLog(this) ? this.querySelectorAll('[data-key]').length * ROW_PX : 0;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      // O banner (role="alert") fica entre o histórico e o campo e reduz a área visível.
      return isLog(this) ? VIEW_PX - (document.querySelector('[role="alert"]') ? BANNER_PX : 0) : 0;
    },
  });
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      scrollTops.set(this, Math.min(Math.max(0, value), max));
    },
  });
}

export function uninstallScrollGeometry() {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  for (const name of ['scrollHeight', 'clientHeight', 'scrollTop']) delete proto[name];
  saved.length = 0;
}

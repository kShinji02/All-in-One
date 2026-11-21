import type { SocketEventMap, WebSocketLike } from '@/realtime/chat-connection';

type EventName = keyof SocketEventMap;
type Listener = (event: never) => void;

/**
 * WebSocket controlado pelo teste. O "servidor" é o próprio teste: ele abre,
 * envia frames e fecha a conexão. Registra o que o cliente enviou e fechou.
 */
export class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: { code?: number; reason?: string }[] = [];
  private readonly listeners = new Map<EventName, Set<Listener>>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static reset() {
    FakeSocket.instances = [];
  }

  static get last(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) throw new Error('nenhum socket criado');
    return socket;
  }

  /** Sockets que o cliente ainda não fechou e que o servidor não encerrou. */
  static live(): FakeSocket[] {
    return FakeSocket.instances.filter((s) => s.readyState === 0 || s.readyState === 1);
  }

  addEventListener<K extends EventName>(type: K, listener: (event: SocketEventMap[K]) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener<K extends EventName>(type: K, listener: (event: SocketEventMap[K]) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('send com o socket fechado');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  // ---- lado do servidor ----
  private emit<K extends EventName>(type: K, event: SocketEventMap[K]) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) (listener as (event: SocketEventMap[K]) => void)(event);
  }

  serverOpen() {
    this.readyState = 1;
    this.emit('open', undefined);
  }

  serverSend(frame: unknown) {
    this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  serverSendRaw(data: unknown) {
    this.emit('message', { data });
  }

  serverClose(code: number, reason = '') {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  /** Falha de rede: o navegador emite "error" e em seguida "close" 1006. */
  networkFailure() {
    this.readyState = 3;
    this.emit('error', undefined);
    this.emit('close', { code: 1006, reason: '' });
  }
}

export const SELF = {
  id: '205519959982473217',
  username: 'ana',
  displayName: 'Ana',
  avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
};

export const readyFrame = (self = SELF) => ({ type: 'ready', self });

export const message = (text: string, id = '11111111-2222-4333-8444-555555555555') => ({
  id,
  author: SELF,
  text,
  createdAt: '2026-11-20T12:00:00.000Z',
});

/** Abre o socket, responde ao auth com ready + history. */
export function acceptConnection(socket: FakeSocket, history: unknown[] = []) {
  socket.serverOpen();
  socket.serverSend(readyFrame());
  socket.serverSend({ type: 'history', messages: history });
}

/** Rede do aparelho controlada pelo teste (navigator.onLine + online/offline). */
export class FakeNetwork {
  online = true;
  private readonly listeners = new Set<(online: boolean) => void>();

  isOnline = () => this.online;

  subscribe = (listener: (online: boolean) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get listenerCount() {
    return this.listeners.size;
  }

  /** O navegador detecta a mudança e dispara o evento. */
  set(online: boolean) {
    this.online = online;
    for (const listener of [...this.listeners]) listener(online);
  }
}

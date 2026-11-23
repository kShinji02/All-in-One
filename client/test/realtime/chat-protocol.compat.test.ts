// @vitest-environment node
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyClose, SERVER_CLOSE_REASONS } from '@/realtime/chat-close-codes';
import {
  HISTORY_LIMIT,
  KNOWN_ERROR_CODES,
  MAX_MESSAGE_LENGTH,
  MAX_NONCE_LENGTH,
  MAX_RETRY_AFTER_MS,
  parseServerFrame,
  SERVER_FRAME_TYPES,
} from '@/realtime/chat-protocol';

/*
 * Compatibilidade client ↔ server.
 * 1) Estática: lê o código do servidor e compara contratos e limites.
 * 2) Ao vivo: sobe o attachChat REAL do servidor, provoca todos os tipos de
 *    frame e confere que cada frame recebido é aceito pelo parser do client
 *    sem perder nenhum campo.
 */

const SERVER_CHAT = new URL('../../../server/chat/', import.meta.url);
const source = (file: string) => readFile(new URL(file, SERVER_CHAT), 'utf8');

type ServerConfig = {
  CloseCode: Record<string, number>;
  MAX_MESSAGE_LENGTH: number;
  MAX_NONCE_LENGTH: number;
  HISTORY_LIMIT: number;
  MESSAGE_RATE_LIMIT: { limit: number; windowMs: number };
};
// Import dinâmico por URL: o servidor é JavaScript (sem tipos) e roda com o código real.
const importServer = <T>(file: string) => import(/* @vite-ignore */ new URL(file, SERVER_CHAT).href) as Promise<T>;

describe('compatibilidade estática com o código do servidor', () => {
  let config: ServerConfig;
  let serverSources: string;

  beforeAll(async () => {
    config = await importServer<ServerConfig>('config.js');
    serverSources = (
      await Promise.all(['index.js', 'protocol.js', 'auth.js', 'instances.js', 'authenticator.js', 'errors.js', '../legal/gate.js'].map(source))
    ).join('\n');
  });

  it('limites iguais aos de server/chat/config.js', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(config.MAX_MESSAGE_LENGTH);
    expect(MAX_NONCE_LENGTH).toBe(config.MAX_NONCE_LENGTH);
    expect(HISTORY_LIMIT).toBe(config.HISTORY_LIMIT);
    expect(MAX_RETRY_AFTER_MS).toBeGreaterThanOrEqual(config.MESSAGE_RATE_LIMIT.windowMs);
  });

  it('tipos de frame enviados pelo servidor = tipos aceitos pelo client', async () => {
    const index = await source('index.js');
    const sent = new Set([...index.matchAll(/send\([^)]*?\{\s*type: "([a-z_]+)"|withNonce\(\{ type: "([a-z_]+)"|\{ type: "([a-z_]+)", message/g)].map((m) => m[1] ?? m[2] ?? m[3]));
    expect([...sent].sort()).toEqual([...SERVER_FRAME_TYPES].sort());
  });

  it('códigos de {type:"error"} do servidor = KNOWN_ERROR_CODES', async () => {
    const files = (await source('protocol.js')) + (await source('index.js'));
    const codes = new Set([...files.matchAll(/code: "([a-z_]+)"/g)].map((m) => m[1]));
    expect([...codes].sort()).toEqual([...KNOWN_ERROR_CODES].sort());
  });

  it('pares (código, motivo) de fechamento do servidor = tabela do client', () => {
    const pairs = new Map<string, number>();
    for (const [, name, reason] of serverSources.matchAll(/CloseCode\.([A-Z_]+), "([a-z_]+)"/g)) {
      const code = config.CloseCode[name!];
      expect(code, `CloseCode.${name}`).toBeTypeOf('number');
      pairs.set(reason!, code!);
    }
    const clientPairs = Object.fromEntries(Object.entries(SERVER_CLOSE_REASONS).map(([reason, { code }]) => [reason, code]));
    expect(Object.fromEntries(pairs)).toEqual(clientPairs);
    expect(pairs.size).toBe(21);
  });
});

/* ------------------------------------------------------------------ *
 * Ao vivo, com o servidor real
 * ------------------------------------------------------------------ */
type WsLike = {
  on(event: 'message', cb: (data: { toString(): string }) => void): void;
  once(event: 'open' | 'close', cb: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
  terminate(): void;
};
type WsCtor = new (url: string, opts: { origin: string }) => WsLike;

const USERS: Record<string, { id: string; username: string; displayName: string; avatarUrl: string }> = {
  'tok-ana': { id: '205519959982473217', username: 'ana', displayName: 'Ana', avatarUrl: 'https://cdn.discordapp.com/avatars/205519959982473217/a1b2c3.png?size=128' },
  'tok-bruno': { id: '175928847299117063', username: 'bruno', displayName: 'Bruno', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png' },
};
const INSTANCE = 'i-1276580072400224306-gc-912952092627435520-912954213460484116';

describe('compatibilidade ao vivo com o servidor real (attachChat)', () => {
  let server: http.Server;
  let chat: { close(): void };
  let url: string;
  let WebSocket: WsCtor;
  const rawFrames: { conn: string; raw: string }[] = [];
  const closes: { conn: string; code: number; reason: string }[] = [];

  async function connect(conn: string, token: string) {
    const ws = new WebSocket(url, { origin: 'http://localhost:5173' });
    const inbox: unknown[] = [];
    ws.on('message', (data) => {
      const raw = data.toString();
      rawFrames.push({ conn, raw });
      inbox.push(JSON.parse(raw));
    });
    ws.once('close', (code, reason) => closes.push({ conn, code: code as number, reason: String(reason) }));
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'auth', accessToken: token, instanceId: INSTANCE }));
    await delay(80);
    return { ws, inbox, send: (frame: unknown) => ws.send(JSON.stringify(frame)) };
  }

  beforeAll(async () => {
    const { attachChat } = await importServer<{ attachChat: (s: http.Server, o: unknown) => { close(): void } }>('index.js');
    const { ChatCloseError } = await importServer<{ ChatCloseError: new (code: number, reason: string) => Error }>('errors.js');
    const wsModule = (await import(/* @vite-ignore */ new URL('../../../server/node_modules/ws/index.js', import.meta.url).href)) as {
      default: WsCtor & { WebSocket?: WsCtor };
    };
    WebSocket = wsModule.default;

    server = http.createServer();
    chat = attachChat(server, {
      authenticate: async ({ accessToken, instanceId }: { accessToken: string; instanceId: string }) => {
        const user = USERS[accessToken];
        if (!user) throw new ChatCloseError(4001, 'invalid_token');
        return { user, instanceId };
      },
      messageRateLimit: { limit: 3, windowMs: 10_000 },
      repeatedMessageLimit: { limit: 1, windowMs: 10_000 },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/chat`;

    // Roteiro que provoca todos os tipos de frame do protocolo.
    const ana = await connect('ana', 'tok-ana'); // ready + history vazio
    const bruno = await connect('bruno', 'tok-bruno');
    ana.send({ type: 'send', text: 'Olá, Bruno! <b>html</b> 😀', nonce: 'n-1' }); // message com nonce (Ana) e sem (Bruno)
    await delay(40);
    ana.send({ type: 'send', text: 'Olá, Bruno!', nonce: 'n-1' }); // reenvio idempotente (4.1)
    ana.send({ type: 'send', text: 'sem nonce' }); // message sem nonce
    ana.send({ type: 'send', text: 'a'.repeat(501), nonce: 'n-long' }); // error message_too_long
    ana.send({ type: 'send', text: '   ' }); // error empty_message
    ana.send({ type: 'send', text: 42 }); // error invalid_message
    ana.send({ type: 'send', text: 'x', nonce: '<x>' }); // error invalid_nonce
    ana.send({ type: 'desconhecido' }); // error unsupported_message
    ana.send({ type: 'send', text: 'SEM   nonce', nonce: 'n-rep' }); // error repeated_message (mesmo texto de "sem nonce")
    ana.send({ type: 'send', text: 'terceira', nonce: 'n-3' });
    ana.send({ type: 'send', text: 'quarta', nonce: 'n-4' }); // rate_limited (limite 3)
    await delay(80);
    await connect('bruno-2', 'tok-bruno'); // history sem nonce de terceiros
    await connect('ana-2', 'tok-ana'); // history com o próprio nonce
    await connect('intruso', 'tok-invalido'); // fechamento 4001 invalid_token
    await delay(80);
    for (const c of [ana, bruno]) c.ws.close();
  });

  afterAll(async () => {
    chat?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('o roteiro produziu todos os tipos de frame do protocolo', () => {
    const types = new Set(rawFrames.map(({ raw }) => (JSON.parse(raw) as { type: string }).type));
    expect([...types].sort()).toEqual([...SERVER_FRAME_TYPES].sort());
  });

  it('todos os códigos de erro conhecidos foram produzidos', () => {
    const codes = new Set(rawFrames.map(({ raw }) => JSON.parse(raw) as { type: string; code?: string }).filter((f) => f.type === 'error').map((f) => f.code));
    expect([...codes].sort()).toEqual([...KNOWN_ERROR_CODES].sort());
  });

  it('cada frame real é aceito pelo parser do client sem perder nenhum campo', () => {
    expect(rawFrames.length).toBeGreaterThan(15);
    for (const { conn, raw } of rawFrames) {
      const result = parseServerFrame(raw);
      expect(result.ok, `${conn}: ${raw}`).toBe(true);
      if (!result.ok) continue;
      const { known, ...frame } = result.frame as typeof result.frame & { known?: boolean };
      expect(frame, `${conn}: ${raw}`).toEqual(JSON.parse(raw));
      if (result.frame.type === 'error') expect(known).toBe(true);
    }
  });

  it('4.1: o histórico da Ana traz o próprio nonce; o do Bruno não traz nonce nenhum', () => {
    const historyOf = (conn: string) => {
      const entry = rawFrames.find((f) => f.conn === conn && f.raw.includes('"type":"history"'))!;
      const parsed = parseServerFrame(entry.raw);
      if (!parsed.ok || parsed.frame.type !== 'history') throw new Error('histórico inválido');
      return parsed.frame.messages;
    };
    const ana = historyOf('ana-2');
    expect(ana.find((m) => m.text.startsWith('Olá'))?.nonce).toBe('n-1');
    const bruno = historyOf('bruno-2');
    expect(bruno.length).toBe(ana.length);
    expect(bruno.every((m) => m.nonce === undefined)).toBe(true);
  });

  it('4.1: o reenvio idempotente chega como "message" com o mesmo id e o nonce', () => {
    const anaMessages = rawFrames
      .filter((f) => f.conn === 'ana')
      .map((f) => parseServerFrame(f.raw))
      .flatMap((r) => (r.ok && r.frame.type === 'message' && r.frame.nonce === 'n-1' ? [r.frame] : []));
    expect(anaMessages).toHaveLength(2);
    expect(anaMessages[0]!.message.id).toBe(anaMessages[1]!.message.id);
  });

  it('o fechamento real do servidor é classificado pela tabela do client', async () => {
    await delay(50);
    const intruso = closes.find((c) => c.conn === 'intruso');
    expect(intruso).toEqual({ conn: 'intruso', code: 4001, reason: 'invalid_token' });
    expect(classifyClose(intruso!.code, intruso!.reason)).toEqual({ category: 'session_expired', reconnect: false });
  });
});

// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Regressão do ciclo "Reconectando…" no Discord Mobile.
 *
 * Causa: a versão anterior do `npm run dev:discord` rodava o servidor de desenvolvimento
 * com `server.ws: false`. O cliente do Vite continuava na página e abria um WebSocket de
 * HMR no próprio host da página, que ficava preso em "connecting" (ninguém respondia ao
 * upgrade). Pelo RFC 6455 §4.1 o navegador só abre um WebSocket por vez por host:porta,
 * então o WebSocket do chat esperava atrás dele, estourava o prazo do handshake e voltava
 * a "Reconectando…". (Verificado no Chromium: o mesmo /api/chat abria de outra página e
 * ficava pendente na página do dev:discord.)
 *
 * Correção: dev:discord = build de produção (watch) + `vite preview`. Este teste roda o
 * script real e confere que a página servida não tem o cliente do Vite.
 */

const clientDir = process.cwd();
let outDir: string;
let child: ChildProcess;
let baseUrl: string;

beforeAll(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'dev-discord-'));
  child = spawn(process.execPath, ['scripts/dev-discord.mjs', '--once', '--port', '0', '--out-dir', outDir], {
    cwd: clientDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  baseUrl = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`dev:discord não ficou pronto:\n${output}`)), 90_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/pronto em (http:\/\/localhost:\d+)\//);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', (code) => reject(new Error(`dev:discord saiu (${code}):\n${output}`)));
  });
}, 120_000);

afterAll(async () => {
  child?.kill();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe('npm run dev:discord', () => {
  it('serve a página SEM o cliente do Vite (nenhum WebSocket de HMR no host da página)', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    expect(html).toContain('<div id="root">');
    expect(html).not.toContain('/@vite/client');
    expect(html).not.toContain('@react-refresh');
    // O preview responde caminhos desconhecidos com o index.html (fallback de SPA):
    // o que importa é que o conteúdo não seja o cliente do Vite.
    const client = await (await fetch(`${baseUrl}/@vite/client`)).text();
    expect(client).not.toContain('createHotContext');
    expect(client).not.toContain('vite:ws:disconnect');
  });

  it('o JavaScript servido não contém o código de reload ao reconectar do HMR', async () => {
    const assets = path.join(outDir, 'assets');
    const files = (await readdir(assets)).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const code = await readFile(path.join(assets, file), 'utf8');
      expect(code).not.toContain('vite:ws:disconnect');
      expect(code).not.toContain('vite-hmr');
    }
  });

  it('o proxy /api do preview responde (mesma origem da página, como o WebSocket do chat)', async () => {
    // Sem backend, o proxy devolve erro; com backend, a resposta do Express. Em ambos os
    // casos a requisição é tratada pelo proxy, não pelo fallback de SPA (index.html).
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.text();
    expect(body).not.toContain('<div id="root">');
  });
});

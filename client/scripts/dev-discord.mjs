/**
 * `npm run dev:discord` — servidor para testar DENTRO do Discord (celular e quedas de rede).
 *
 * Build de produção em modo watch + `vite preview` na porta 5173 (a do túnel). A página
 * não tem o cliente do Vite, por isso:
 *  - nada recarrega a Activity quando a rede volta (o cliente HMR chama location.reload()
 *    ao reconectar);
 *  - nenhum WebSocket do Vite fica preso em "connecting" no host da página. Pelo RFC 6455
 *    (§4.1) o navegador só abre um WebSocket por vez por host:porta; um socket do HMR
 *    preso bloqueava o WebSocket do chat, que nunca abria ("Reconectando…" sem fim).
 *
 * O preview herda do vite.config.ts o proxy /api (inclusive WebSocket do chat) e os
 * allowedHosts do túnel. Após editar o código, espere o "build concluído" e reabra a Activity.
 *
 * Opções (para os testes): --port <n> (padrão 5173, 0 = livre), --out-dir <pasta>, --once (sem watch).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const port = Number(option('--port', '5173'));
const outDir = path.resolve(root, option('--out-dir', 'dist'));
const once = args.includes('--once');
const configFile = path.join(root, 'vite.config.ts');

// 1º build completo e síncrono: o preview só sobe com a pasta pronta.
await build({ root, configFile, logLevel: 'warn', build: { outDir, emptyOutDir: true, sourcemap: true } });
console.log('[dev:discord] build concluído.');

const server = await preview({
  root,
  configFile,
  build: { outDir },
  preview: { port, strictPort: port !== 0 },
});
const address = server.httpServer.address();
console.log(`[dev:discord] pronto em http://localhost:${typeof address === 'object' && address ? address.port : port}/`);

// Depois, rebuild a cada alteração (o preview lê os arquivos do disco a cada requisição).
if (!once) {
  const watcher = await build({
    root,
    configFile,
    logLevel: 'warn',
    build: { outDir, emptyOutDir: false, sourcemap: true, watch: {} },
  });
  let first = true;
  watcher.on('event', (event) => {
    if (event.type === 'END') {
      if (!first) console.log(`[dev:discord] rebuild concluído (${new Date().toLocaleTimeString()}). Reabra a Activity.`);
      first = false;
    }
    if (event.type === 'ERROR') console.error('[dev:discord] erro no build:', event.error?.message ?? event.error);
  });
}

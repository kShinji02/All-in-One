/**
 * `npm run build:cloudflare` — confere o dist/ antes de publicar na Cloudflare.
 *
 * - index.html e os arquivos que ele referencia existem e usam caminhos absolutos da raiz
 *   ("/assets/..."), que o URL Mapping "/" do Discord repassa para a hospedagem;
 * - o bundle chama o backend só por caminhos relativos (/api/token, /api/legal, /api/chat)
 *   e não contém endereços de desenvolvimento (localhost, trycloudflare, onrender);
 * - o Client ID (público) entrou no bundle;
 * - há _headers e nenhum source map;
 * - NENHUM valor secreto do .env (variáveis sem o prefixo VITE_) aparece nos arquivos.
 *   Os valores são lidos só para comparação: nunca são exibidos.
 *
 * Uso: node scripts/verify-dist.mjs [--dir <pasta>]   (padrão: dist)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Caminhos do backend que o bundle precisa citar (mesma origem; ver chat-connection.ts e api.ts). */
export const REQUIRED_API_PATHS = ['/api/token', '/api/legal', '/api/chat'];
/** Endereços do NOSSO ambiente que não podem ir para o bundle (o SDK do Discord cita localhost:3333, que é dele). */
export const FORBIDDEN_HOSTS = [/(localhost|127\.0\.0\.1):(3001|5173)\b/, /trycloudflare\.com/, /onrender\.com/];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Pares [nome, valor] do .env (comentários e linhas vazias ignorados). */
function readEnvEntries(envFile) {
  if (!existsSync(envFile)) return [];
  return readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => [match[1], match[2].trim().replace(/^(['"])(.*)\1$/, '$2')]);
}

/** Valores de variáveis NÃO públicas do .env (sem prefixo VITE_), com pelo menos 8 caracteres. */
export function readSecretValues(envFile) {
  return readEnvEntries(envFile)
    .filter(([name, value]) => !name.startsWith('VITE_') && value.length >= 8)
    .map(([, value]) => value);
}

/** Valor de uma variável do .env (ou null). */
export function readEnvValue(envFile, name) {
  return readEnvEntries(envFile).find(([key]) => key === name)?.[1] ?? null;
}

/** Devolve a lista de problemas (vazia = pronto para publicar). Nunca inclui valores secretos. */
export function verifyDist(dir, { secretValues = [], clientId = null } = {}) {
  const problems = [];
  const index = path.join(dir, 'index.html');
  if (!existsSync(index)) return [`${path.relative(ROOT, index)} não existe: rode o build.`];

  const html = readFileSync(index, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^https?:\/\//.test(ref)) problems.push(`index.html referencia um endereço externo: ${ref}`);
    else if (!ref.startsWith('/')) problems.push(`index.html usa caminho relativo (quebra fora da raiz): ${ref}`);
    else if (!existsSync(path.join(dir, ref))) problems.push(`index.html referencia um arquivo ausente: ${ref}`);
  }
  if (!refs.some((ref) => /^\/assets\/.+\.js$/.test(ref))) problems.push('index.html não carrega o bundle /assets/*.js.');

  const files = walk(dir);
  if (!existsSync(path.join(dir, '_headers'))) problems.push('_headers ausente (vem de client/public/).');
  const maps = files.filter((file) => file.endsWith('.map'));
  if (maps.length > 0) problems.push(`${maps.length} source map(s) em dist/: rode o build:cloudflare (limpa a pasta).`);

  const js = files.filter((file) => file.endsWith('.js')).map((file) => readFileSync(file, 'utf8')).join('\n');
  for (const apiPath of REQUIRED_API_PATHS) {
    if (![`"${apiPath}`, `'${apiPath}`, `\`${apiPath}`].some((quoted) => js.includes(quoted))) {
      problems.push(`o bundle não cita o caminho relativo ${apiPath}.`);
    }
  }
  // O Client ID (público) entra no bundle no build: sem ele, a Activity publicada fica "não configurada".
  if (!clientId || !/^\d{17,20}$/.test(clientId)) {
    problems.push('VITE_DISCORD_CLIENT_ID ausente ou inválido no build (.env da raiz ou variável de ambiente).');
  } else if (!js.includes(clientId)) {
    problems.push('o bundle não contém o VITE_DISCORD_CLIENT_ID: o build foi feito sem ele.');
  }
  for (const pattern of FORBIDDEN_HOSTS) {
    if (pattern.test(js) || pattern.test(html)) problems.push(`o bundle contém um endereço de desenvolvimento/backend (${pattern}).`);
  }

  for (const file of files) {
    const content = readFileSync(file, 'latin1');
    if (secretValues.some((value) => content.includes(value))) {
      problems.push(`${path.relative(dir, file)} contém o valor de uma variável secreta do .env.`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const dir = path.resolve(ROOT, args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'dist');
  const envFile = path.resolve(ROOT, '..', '.env');
  const secretValues = [
    ...readSecretValues(envFile),
    ...['DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DATABASE_URL'].map((name) => process.env[name]?.trim() ?? '').filter((v) => v.length >= 8),
  ];
  // Mesma prioridade do Vite: variável de ambiente antes do .env.
  const clientId = process.env.VITE_DISCORD_CLIENT_ID?.trim() || readEnvValue(envFile, 'VITE_DISCORD_CLIENT_ID');
  const problems = verifyDist(dir, { secretValues, clientId });
  if (problems.length > 0) {
    console.error('[verify-dist] dist/ NÃO está pronto para publicar:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`[verify-dist] ok: ${path.relative(ROOT, dir)}/ pronto (caminhos /api relativos, Client ID presente, sem endereços de desenvolvimento, sem segredos, sem source maps).`);
}

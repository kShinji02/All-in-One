// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatUrl } from '@/realtime/chat-connection';
// @ts-expect-error script .mjs sem tipos
import { FORBIDDEN_HOSTS, readEnvValue, readSecretValues, REQUIRED_API_PATHS, verifyDist } from '../../scripts/verify-dist.mjs';

/*
 * Hospedagem do frontend na Cloudflare (Workers Static Assets), sem publicar nada:
 * configuração, cabeçalhos, build de produção real e caminhos que o Discord repassa
 * (/ → Cloudflare, /api → Render). Guia: docs/DEPLOY-CLOUDFLARE.md.
 */

const clientDir = process.cwd();
const read = (file: string) => readFileSync(path.join(clientDir, file), 'utf8');
/** JSONC → objeto (comentários de linha fora de strings). */
const parseJsonc = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as Record<string, any>;

const FAKE_CLIENT_ID = '123456789012345678';
const FAKE_SECRET = 'segredo-falso-de-teste-0123456789';

describe('wrangler.jsonc', () => {
  const config = parseJsonc(read('wrangler.jsonc'));

  it('é um Worker só de arquivos estáticos: sem script, sem bindings', () => {
    expect(config.main).toBeUndefined();
    expect(Object.keys(config).sort()).toEqual(['$schema', 'assets', 'compatibility_date', 'name', 'preview_urls', 'workers_dev']);
    expect(config.assets).toEqual({ directory: './dist', not_found_handling: 'single-page-application', html_handling: 'auto-trailing-slash' });
  });

  it('nome válido como subdomínio do workers.dev e data de compatibilidade fixa', () => {
    expect(config.name).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
    expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
  });

  it('a pasta publicada é a saída do build do Vite (outDir padrão)', async () => {
    const viteConfig = (await import('../../vite.config')).default as { build?: { outDir?: string } };
    expect(viteConfig.build?.outDir ?? 'dist').toBe('dist');
  });
});

describe('client/public/_headers e .assetsignore', () => {
  const headers = read('public/_headers');
  const rules = headers.split(/\r?\n/).filter((line) => /^\//.test(line));

  it('não impede a Activity de rodar no iframe do Discord', () => {
    const active = headers.split(/\r?\n/).filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(active).not.toMatch(/x-frame-options/i);
    expect(active).not.toMatch(/frame-ancestors/i);
    expect(active).not.toMatch(/content-security-policy/i);
  });

  it('cache: /assets/* imutável (hash no nome); a página sempre revalida', () => {
    expect(headers).toMatch(/^\/assets\/\*\r?\n\s+Cache-Control: public, max-age=31536000, immutable$/m);
    expect(headers).toMatch(/^\/\r?\n\s+Cache-Control: no-cache$/m);
    expect(headers).toMatch(/^\/index\.html\r?\n\s+Cache-Control: no-cache$/m);
    expect(rules.length).toBeLessThanOrEqual(100); // limite da Cloudflare
  });

  it('source maps nunca são enviados', () => {
    expect(read('public/.assetsignore')).toMatch(/^\*\.map$/m);
  });
});

describe('scripts do package.json', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

  it('mantém os scripts de desenvolvimento e o Quick Tunnel', () => {
    expect(scripts).toMatchObject({
      dev: 'vite',
      'dev:discord': 'node scripts/dev-discord.mjs',
      build: 'tsc -b && vite build',
      preview: 'vite preview',
    });
    const viteConfig = read('vite.config.ts');
    expect(viteConfig).toContain("allowedHosts: ['.trycloudflare.com']");
    expect(viteConfig).toContain("target: 'http://localhost:3001'");
  });

  it('scripts da Cloudflare: build verificado e Wrangler com versão exata', () => {
    expect(scripts['build:cloudflare']).toBe('npm run build && node scripts/verify-dist.mjs');
    for (const name of ['cf:dev', 'cf:dry-run', 'cf:deploy']) {
      expect(scripts[name], name).toMatch(/^npm run build:cloudflare && npx --yes wrangler@\d+\.\d+\.\d+ /);
    }
    expect(scripts['cf:dry-run']).toContain('deploy --dry-run');
  });

  it('o guia usa a mesma versão do Wrangler e o mesmo nome do Worker', () => {
    const version = /wrangler@(\d+\.\d+\.\d+)/.exec(scripts['cf:deploy']!)![1]!;
    const guide = readFileSync(path.join(clientDir, '..', 'docs', 'DEPLOY-CLOUDFLARE.md'), 'utf8');
    const cited = new Set([...guide.matchAll(/wrangler@(\d+\.\d+\.\d+)/g)].map((m) => m[1]));
    expect([...cited]).toEqual([version]);
    expect(read('wrangler.jsonc')).toContain(`wrangler@${version}/config-schema.json`);
    expect(guide).toContain(`${parseJsonc(read('wrangler.jsonc')).name}.<subdomínio>.workers.dev`);
    // O guia não declara a migração concluída antes do teste no Discord.
    expect(guide).toMatch(/Ainda não publicada nem\s+> testada no Discord/);
  });
});

describe('build de produção para a Cloudflare', () => {
  let outDir: string;
  const previous = process.env.VITE_DISCORD_CLIENT_ID;

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(os.tmpdir(), 'cf-dist-'));
    // Variável de ambiente tem prioridade sobre o .env no Vite: o teste não depende do .env local.
    process.env.VITE_DISCORD_CLIENT_ID = FAKE_CLIENT_ID;
    await build({ root: clientDir, configFile: path.join(clientDir, 'vite.config.ts'), logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  }, 120_000);

  afterAll(async () => {
    if (previous === undefined) delete process.env.VITE_DISCORD_CLIENT_ID;
    else process.env.VITE_DISCORD_CLIENT_ID = previous;
    await rm(outDir, { recursive: true, force: true });
  });

  it('gera um dist/ pronto: caminhos absolutos da raiz, /api relativo, Client ID, _headers, sem source maps', () => {
    expect(verifyDist(outDir, { clientId: FAKE_CLIENT_ID, secretValues: [FAKE_SECRET] })).toEqual([]);
  });

  it('rotas da SPA: index.html só usa caminhos da raiz, então funciona em qualquer caminho servido pelo fallback', async () => {
    const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    // /qualquer/rota → index.html: "./assets/x.js" viraria /qualquer/assets/x.js (quebrado); "/assets/x.js" não.
    for (const ref of refs) expect(ref, ref).toMatch(/^\/(?!\/)/);
    for (const route of ['/', '/qualquer/rota', '/a/b/c?instance_id=1']) {
      for (const ref of refs) expect(new URL(ref, `https://app.test${route}`).pathname).toBe(ref);
    }
  });

  it('caminhos de API: chamadas relativas à origem (o URL Mapping /api do Discord leva ao Render)', async () => {
    const files = await import('node:fs').then((fs) => fs.readdirSync(path.join(outDir, 'assets')));
    const js = (await Promise.all(files.filter((f) => f.endsWith('.js')).map((f) => readFile(path.join(outDir, 'assets', f), 'utf8')))).join('\n');
    for (const apiPath of REQUIRED_API_PATHS) expect(js).toContain(apiPath);
    expect(js).not.toMatch(/https?:\/\/[^"'`\s]*\/api\/(token|legal|chat)/); // nenhuma URL absoluta para o backend
    for (const pattern of FORBIDDEN_HOSTS as RegExp[]) expect(js).not.toMatch(pattern);
    expect(js).toContain(FAKE_CLIENT_ID);
  });
});

describe('endereço do WebSocket do chat', () => {
  it('sempre na mesma origem da página: dentro do Discord, o discordsays.com (URL Mapping /api)', () => {
    expect(chatUrl({ protocol: 'https:', host: `${FAKE_CLIENT_ID}.discordsays.com` })).toBe(`wss://${FAKE_CLIENT_ID}.discordsays.com/api/chat`);
    // Aberto direto na Cloudflare (fora do Discord), iria para a própria Cloudflare, que não tem /api: falha fechada.
    expect(chatUrl({ protocol: 'https:', host: 'all-in-one-frontend.conta.workers.dev' })).toBe('wss://all-in-one-frontend.conta.workers.dev/api/chat');
    // Quick Tunnel local: continua igual.
    expect(chatUrl({ protocol: 'https:', host: 'abc.trycloudflare.com' })).toBe('wss://abc.trycloudflare.com/api/chat');
  });
});

describe('verify-dist recusa um dist/ inseguro (sem revelar valores)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'cf-bad-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fixture(html: string, js: string, extra: Record<string, string> = {}) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), html);
    await writeFile(path.join(dir, 'assets', 'index-abc.js'), js);
    for (const [name, content] of Object.entries(extra)) await writeFile(path.join(dir, name), content);
  }
  const OK_JS = `fetch("/api/token");fetch(\`/api/legal\${p}\`);const c="/api/chat";const id="${FAKE_CLIENT_ID}";`;
  const OK_HTML = '<script type="module" src="/assets/index-abc.js"></script>';

  it('aceita o caso correto', async () => {
    await fixture(OK_HTML, OK_JS, { _headers: '/*\n  X: y\n' });
    expect(verifyDist(dir, { clientId: FAKE_CLIENT_ID })).toEqual([]);
  });

  it('segredo no bundle: aponta o arquivo, nunca o valor', async () => {
    await fixture(OK_HTML, `${OK_JS}const s="${FAKE_SECRET}";`, { _headers: '' });
    const problems = verifyDist(dir, { clientId: FAKE_CLIENT_ID, secretValues: [FAKE_SECRET] }) as string[];
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/contém o valor de uma variável secreta/);
    expect(problems.join('\n')).not.toContain(FAKE_SECRET);
  });

  it('source map, caminho relativo, URL de túnel/Render, Client ID ausente e _headers ausente', async () => {
    await fixture('<script type="module" src="./assets/index-abc.js"></script>', `${OK_JS}x="https://abc.trycloudflare.com";y="https://x.onrender.com"`, { 'index.js.map': '{}' });
    const problems = (verifyDist(dir, { clientId: null }) as string[]).join('\n');
    expect(problems).toMatch(/caminho relativo/);
    expect(problems).toMatch(/source map/);
    expect(problems).toMatch(/trycloudflare/);
    expect(problems).toMatch(/onrender/);
    expect(problems).toMatch(/VITE_DISCORD_CLIENT_ID ausente/);
    expect(problems).toMatch(/_headers ausente/);
  });

  it('bundle sem os caminhos /api ou sem o Client ID', async () => {
    await fixture(OK_HTML, 'console.log(1)', { _headers: '' });
    const problems = (verifyDist(dir, { clientId: FAKE_CLIENT_ID }) as string[]).join('\n');
    for (const apiPath of REQUIRED_API_PATHS) expect(problems).toContain(apiPath);
    expect(problems).toMatch(/não contém o VITE_DISCORD_CLIENT_ID/);
  });

  it('lê do .env só variáveis não públicas como segredos e o Client ID como público', async () => {
    const envFile = path.join(dir, '.env');
    await writeFile(envFile, `# comentário\nVITE_DISCORD_CLIENT_ID=${FAKE_CLIENT_ID}\nDISCORD_CLIENT_SECRET="${FAKE_SECRET}"\nCURTO=abc\nVAZIO=\n`);
    expect(readSecretValues(envFile)).toEqual([FAKE_SECRET]);
    expect(readEnvValue(envFile, 'VITE_DISCORD_CLIENT_ID')).toBe(FAKE_CLIENT_ID);
    expect(readEnvValue(envFile, 'INEXISTENTE')).toBeNull();
    expect(readSecretValues(path.join(dir, 'nao-existe'))).toEqual([]);
  });
});

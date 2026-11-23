// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Mantém a documentação alinhada ao código: scripts citados existem, caminhos citados
 * existem e os links internos (âncoras) apontam para títulos reais.
 */

const root = path.resolve(process.cwd(), '..');
const DOCS = ['README.md', 'docs/TESTE-NO-DISCORD.md', 'docs/ARQUITETURA.md', 'docs/CHAT-PROTOCOL.md', 'docs/SEGURANCA.md', 'docs/DEPLOY-RENDER.md', 'docs/ACEITE-LEGAL.md', 'docs/DEPLOY-CLOUDFLARE.md'];
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const scripts = (pkg: string) => Object.keys((JSON.parse(read(pkg)) as { scripts: Record<string, string> }).scripts);

/** Âncora no estilo do GitHub: minúsculas, sem pontuação (mantém letras acentuadas), espaços → "-". */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

describe('documentação', () => {
  it('todos os documentos existem e não contêm credenciais reais', () => {
    for (const doc of DOCS) {
      const text = read(doc);
      // Formatos de segredo do Discord: token de bot (3 partes base64) e secret de 32 caracteres.
      expect(text, doc).not.toMatch(/[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}/);
      expect(text, doc).not.toMatch(/DISCORD_CLIENT_SECRET=[A-Za-z0-9_-]{20,}/);
      expect(text, doc).not.toMatch(/DISCORD_BOT_TOKEN=[A-Za-z0-9._-]{20,}/);
    }
  });

  it('cada `npm run <script>` citado existe no package.json correspondente', () => {
    const available = new Set([...scripts('client/package.json'), ...scripts('server/package.json')]);
    const missing: string[] = [];
    for (const doc of DOCS) {
      for (const [, name] of read(doc).matchAll(/npm run ([a-z][\w:-]*)/g)) {
        if (!available.has(name!)) missing.push(`${doc}: npm run ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('caminhos de arquivos e pastas citados existem', () => {
    // Saídas de build (geradas, fora do Git): não existem num clone novo.
    const GENERATED = ['client/dist'];
    const missing: string[] = [];
    for (const doc of DOCS) {
      for (const [, ref] of read(doc).matchAll(/`((?:client|server|docs)\/[\w./-]+)`/g)) {
        if (ref!.includes('*') || ref!.includes('<')) continue;
        if (GENERATED.some((dir) => ref === dir || ref!.startsWith(`${dir}/`))) continue;
        if (!existsSync(path.join(root, ref!))) missing.push(`${doc}: ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('links relativos entre documentos e âncoras apontam para arquivos e títulos reais', () => {
    const broken: string[] = [];
    for (const doc of DOCS) {
      for (const [, target] of read(doc).matchAll(/\]\(((?!https?:)[^)\s]+)\)/g)) {
        const [file, anchor] = target!.split('#');
        const targetFile = file ? path.join(path.dirname(doc), file) : doc;
        if (!existsSync(path.join(root, targetFile))) {
          broken.push(`${doc}: ${target}`);
          continue;
        }
        if (anchor) {
          const headings = [...read(targetFile).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!));
          if (!headings.includes(decodeURIComponent(anchor))) broken.push(`${doc}: ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('os limites citados no protocolo batem com o código do servidor', async () => {
    const config = (await import(/* @vite-ignore */ new URL('../../../server/chat/config.js', import.meta.url).href)) as Record<string, unknown>;
    const protocol = read('docs/CHAT-PROTOCOL.md');
    expect(config.MAX_PAYLOAD_BYTES).toBe(4 * 1024);
    expect(protocol).toContain('até 4 KiB');
    expect(config.MAX_MESSAGE_LENGTH).toBe(500);
    expect(protocol).toContain('até 500 code points');
    expect(config.MESSAGE_RATE_LIMIT).toEqual({ limit: 5, windowMs: 10_000 });
    expect(protocol).toContain('5 mensagens por usuário a cada 10 s');
    expect(config.FRAME_RATE_LIMIT).toEqual({ limit: 30, windowMs: 10_000 });
    expect(protocol).toContain('30 por conexão a cada 10 s');
    expect([config.MAX_CONNECTIONS_PER_USER, config.MAX_CONNECTIONS_PER_ROOM]).toEqual([3, 50]);
    expect(protocol).toContain('3 por usuário, 50 por sala');
    expect(config.AUTH_TIMEOUT_MS).toBe(5_000);
    expect(config.HISTORY_LIMIT).toBe(100);
  });

  it('M3: o guia de teste explica o armazenamento dos aceites e lista todos os erros da sessão', async () => {
    const guide = read('docs/TESTE-NO-DISCORD.md');
    for (const term of ['DATABASE_URL', 'LEGAL_STORE=memory', 'acceptance_unavailable', '"legalStore":"memory"', '"legalStore":"postgres"', '"legalStore":"unavailable"']) {
      expect(guide, term).toContain(term);
    }
    // Opções aceitas pelo servidor e recusa em produção, como em server/db/config.js.
    const db = (await import(/* @vite-ignore */ new URL('../../../server/db/config.js', import.meta.url).href)) as {
      resolveAcceptanceStoreKind: (env: Record<string, string>, config: unknown) => string;
    };
    expect(db.resolveAcceptanceStoreKind({ LEGAL_STORE: 'memory' }, null)).toBe('memory');
    expect(db.resolveAcceptanceStoreKind({}, null)).toBe('unavailable');
    expect(db.resolveAcceptanceStoreKind({ LEGAL_STORE: 'postgres' }, null)).toBe('unavailable');
    expect(() => db.resolveAcceptanceStoreKind({ LEGAL_STORE: 'memory', NODE_ENV: 'production' }, null)).toThrow();
    expect(guide).toMatch(/LEGAL_STORE=postgres` sem `DATABASE_URL`/);
    expect(guide).toMatch(/Recusado\*\* com `NODE_ENV=production`/);

    // Cada código de DiscordErrorCode aparece na tabela de diagnóstico.
    const errors = read('client/src/discord/errors.ts');
    const union = /export type DiscordErrorCode =([^;]+);/.exec(errors)![1]!;
    const codes = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(codes).toContain('backend_timeout');
    for (const code of codes) expect(guide, code).toMatch(new RegExp(`\| \`${code}`));

    // Prazos citados batem com o código.
    const { HTTP_TIMEOUTS } = await import('@/lib/http');
    expect(guide).toContain(`${HTTP_TIMEOUTS.tokenExchange / 1000} s para a troca do código`);
    expect(guide).toContain(`${HTTP_TIMEOUTS.legal / 1000} s para a verificação e o registro do aceite`);
    expect(guide).toContain(`${HTTP_TIMEOUTS.optional / 1000} s para o nome do`);
  });

  it('B1: protocolo e segurança citam o motivo próprio do limite por conta', () => {
    expect(read('docs/CHAT-PROTOCOL.md')).toContain('`too_many_auth_attempts`');
    expect(read('docs/SEGURANCA.md')).toContain('30/min → `4029 too_many_auth_attempts`');
  });
});

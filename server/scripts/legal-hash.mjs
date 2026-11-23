/**
 * `npm run legal:hash` — calcula o SHA-256 dos documentos legais (somente leitura).
 *
 *   npm run legal:hash                         → hashes de ../legal-site/terms.html e privacy.html
 *   npm run legal:hash -- <arquivo> [...]      → hashes dos arquivos informados
 *   npm run legal:hash -- --url <URL> [...]    → hash do conteúdo PUBLICADO (os bytes que o usuário abre)
 *
 * Fluxo de publicação (docs/ACEITE-LEGAL.md): publique o documento final, confira que o hash
 * do arquivo e o da URL são iguais e só então registre a versão nova com esse hash em
 * server/legal/config.js (LEGAL_DOCUMENT_HASHES). O script não altera nenhum arquivo.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../legal/integrity.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);

const targets = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--url") targets.push({ url: args[(i += 1)] });
  else targets.push({ file: args[i] });
}
if (targets.length === 0) {
  targets.push({ file: path.join(root, "legal-site", "terms.html") }, { file: path.join(root, "legal-site", "privacy.html") });
}

let failed = false;
for (const target of targets) {
  try {
    let bytes;
    if (target.url) {
      const url = new URL(target.url);
      if (url.protocol !== "https:") throw new Error("use uma URL HTTPS");
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } else {
      bytes = await readFile(target.file);
    }
    console.log(`${sha256Hex(bytes)}  ${target.url ?? path.relative(process.cwd(), target.file)}  (${bytes.length} bytes)`);
  } catch (error) {
    failed = true;
    console.error(`[legal:hash] falha em ${target.url ?? target.file}: ${error?.message ?? error}`);
  }
}
process.exit(failed ? 1 : 0);

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(new URL("../server.js", import.meta.url)));
const PROJECT_ROOT = path.dirname(SERVER_DIR);
const EXPECTED = path.join(PROJECT_ROOT, ".env");

/** Importa env-path.js num processo novo, a partir de `cwd`, e devolve o ENV_PATH calculado. */
function envPathFrom(cwd) {
  const moduleUrl = new URL("../env-path.js", import.meta.url).href;
  return execFileSync(process.execPath, ["--input-type=module", "-e", `import { ENV_PATH } from ${JSON.stringify(moduleUrl)}; process.stdout.write(ENV_PATH);`], {
    cwd,
    encoding: "utf8",
  });
}

test("ENV_PATH aponta para o .env da raiz do projeto", async () => {
  const { ENV_PATH } = await import("../env-path.js");
  assert.equal(ENV_PATH, EXPECTED);
});

test("ENV_PATH é o mesmo iniciando de server/, da raiz ou de outra pasta", () => {
  // "Outra pasta" = diretório temporário do sistema: existe em qualquer ambiente,
  // inclusive quando o server é testado isolado do restante do projeto.
  for (const cwd of [SERVER_DIR, PROJECT_ROOT, os.tmpdir()]) {
    assert.equal(envPathFrom(cwd), EXPECTED, `cwd=${cwd}`);
  }
});

test("server.js carrega o .env pelo ENV_PATH, não por um caminho relativo ao cwd", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(path.join(SERVER_DIR, "server.js"), "utf8");
  assert.match(source, /dotenv\.config\(\{ path: ENV_PATH \}\)/);
  assert.doesNotMatch(source, /dotenv\.config\(\{ path: "\.\.\/\.env" \}\)/);
});

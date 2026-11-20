import { fileURLToPath } from "node:url";

/**
 * Caminho absoluto do .env da raiz do projeto, resolvido a partir DESTE arquivo
 * (server/env-path.js → ../.env), e não do diretório de onde o processo foi iniciado.
 * Assim `npm run dev` em server/ e `node server/server.js` na raiz carregam o mesmo .env.
 */
export const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

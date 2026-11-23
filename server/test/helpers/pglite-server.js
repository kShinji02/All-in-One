import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import net from "node:net";
import { once } from "node:events";

/**
 * PostgreSQL real (PGlite, Postgres compilado para WASM) atrás de um servidor TCP que fala
 * o protocolo do Postgres: o backend se conecta pelo driver `pg`, como faria com o Neon.
 * Só para testes. `dataDir` em disco permite simular reinícios do próprio banco.
 */
export async function freePort() {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

export async function startPgServer({ dataDir, port } = {}) {
  const db = dataDir ? await PGlite.create(dataDir) : await PGlite.create();
  const listenPort = port ?? (await freePort());
  const server = new PGLiteSocketServer({ db, port: listenPort, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  const url = `postgresql://postgres:postgres@127.0.0.1:${listenPort}/postgres?sslmode=disable`;
  return {
    db,
    port: listenPort,
    url,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

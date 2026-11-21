import http from "node:http";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { createApp, parsePerMinute, parseTrustProxy, TOKEN_GLOBAL_RATE_LIMIT, TOKEN_RATE_LIMIT } from "./app.js";
import { attachChat } from "./chat/index.js";
import { createDiscordAuthenticator } from "./chat/authenticator.js";
import { parseExtraOrigins, resolveOriginProfile } from "./chat/origin.js";
import { ENV_PATH } from "./env-path.js";
dotenv.config({ path: ENV_PATH });

const port = 3001;

// Valores de exemplo do example.env que não são credenciais reais.
const PLACEHOLDERS = new Set([
  "YOUR_DISCORD_CLIENT_ID_HERE",
  "YOUR_DISCORD_CLIENT_SECRET",
  "YOUR_DISCORD_BOT_TOKEN",
]);

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value && !PLACEHOLDERS.has(value) ? value : null;
}

const clientId = readEnv("VITE_DISCORD_CLIENT_ID");
const clientSecret = readEnv("DISCORD_CLIENT_SECRET");
const missingEnv = [
  !clientId && "VITE_DISCORD_CLIENT_ID",
  !clientSecret && "DISCORD_CLIENT_SECRET",
].filter(Boolean);

if (missingEnv.length > 0) {
  // O servidor continua no ar para que o cliente receba um erro claro,
  // mas a troca de token fica indisponível até o .env ser preenchido.
  console.warn(
    `[config] Variáveis ausentes no .env: ${missingEnv.join(", ")}. ` +
      "A rota /api/token responderá 500 até que sejam configuradas.",
  );
}

// Token de bot da aplicação: usado SOMENTE no servidor para validar instâncias
// (GET /applications/{id}/activity-instances/{instance_id}).
const botToken = readEnv("DISCORD_BOT_TOKEN");
const chatConfigured = Boolean(clientId && botToken);
if (!chatConfigured) {
  console.warn(
    "[config] Chat indisponível: defina VITE_DISCORD_CLIENT_ID e DISCORD_BOT_TOKEN no .env. " +
      "As conexões em /api/chat serão recusadas (4001 auth_unavailable).",
  );
}

// Opções de implantação (opcionais; ver docs/SEGURANCA.md):
// - TRUST_PROXY: proxies confiáveis para o IP do cliente no rate limit (padrão: nenhum).
// - TOKEN_RATE_LIMIT / TOKEN_GLOBAL_RATE_LIMIT: trocas de código por minuto (por cliente / total).
// - ORIGIN_PROFILE: "production" | "local" | "tunnel" (padrão: production se NODE_ENV=production).
// - CHAT_EXTRA_ORIGINS: origens HTTPS exatas adicionais para o WebSocket do chat.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
const tokenRateLimit = parsePerMinute(process.env.TOKEN_RATE_LIMIT, TOKEN_RATE_LIMIT, "TOKEN_RATE_LIMIT");
const tokenGlobalRateLimit = parsePerMinute(process.env.TOKEN_GLOBAL_RATE_LIMIT, TOKEN_GLOBAL_RATE_LIMIT, "TOKEN_GLOBAL_RATE_LIMIT");
const originProfile = resolveOriginProfile(process.env);
const extraOrigins = parseExtraOrigins(process.env.CHAT_EXTRA_ORIGINS);
console.log(`[config] Origens do chat: perfil "${originProfile}"${extraOrigins.length ? ` + ${extraOrigins.length} extra(s)` : ""}.`);

const app = createApp({ clientId, clientSecret, chatConfigured, fetchImpl: fetch, trustProxy, tokenRateLimit, tokenGlobalRateLimit });

// Servidor HTTP explícito para que o WebSocket do chat compartilhe a mesma porta.
const server = http.createServer(app);
const chatAuthenticator = chatConfigured ? createDiscordAuthenticator({ applicationId: clientId, botToken }) : null;
attachChat(server, {
  discordClientId: clientId,
  originProfile,
  extraOrigins,
  // Sem configuração completa, mantém o autenticador padrão, que recusa todas as conexões.
  ...(chatAuthenticator && {
    authenticate: chatAuthenticator,
    // Revalidação periódica dos membros de cada sala, sempre com consulta nova ao Discord.
    getMembers: async (instanceId) =>
      (await chatAuthenticator.instances.getSnapshot(instanceId, { fresh: true })).users,
  }),
});

server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});

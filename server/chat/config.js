/**
 * Configuração da camada de chat em tempo real (WebSocket).
 *
 * Etapa 1: apenas o ciclo de vida da conexão. Autenticação real (Etapa 2),
 * salas, validação de mensagens e limite de envio (Etapa 3) virão depois.
 */

/** Caminho do WebSocket. Fica sob /api para passar pelo proxy do Vite e pelo URL Mapping do Discord. */
export const CHAT_PATH = "/api/chat";

/** Tamanho máximo de um frame recebido. Frames maiores encerram a conexão (1009). */
export const MAX_PAYLOAD_BYTES = 4 * 1024;

/** Tempo para o cliente se autenticar depois de conectar. */
export const AUTH_TIMEOUT_MS = 5_000;

/** Intervalo do heartbeat (ping/pong). Conexões sem resposta no ciclo seguinte são encerradas. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Limites dos campos da mensagem de autenticação. */
export const MAX_ACCESS_TOKEN_LENGTH = 512;
export const MAX_INSTANCE_ID_LENGTH = 200;

/** Etapa 2 — validação com a API do Discord. */
export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const DISCORD_CDN_BASE = "https://cdn.discordapp.com";

/** Tempo máximo de cada chamada à API do Discord (as duas correm em paralelo, dentro do AUTH_TIMEOUT_MS). */
export const DISCORD_REQUEST_TIMEOUT_MS = 4_000;

/** Cache do /users/@me, indexado pelo SHA-256 do token (o token em si nunca é guardado). */
export const TOKEN_CACHE_TTL_MS = 5 * 60_000;
export const TOKEN_CACHE_MAX_ENTRIES = 1_000;

/** Cache do activity-instances (lista de usuários conectados à instância). */
export const INSTANCE_CACHE_TTL_MS = 20_000;
export const INSTANCE_CACHE_MAX_ENTRIES = 500;

/** Caracteres aceitos no instanceId antes de consultá-lo (impede injeção no caminho da URL). */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/**
 * Códigos de fechamento. 4000–4999 são da aplicação (RFC 6455); 1011 e 1013
 * são códigos padrão. Serão documentados em docs/CHAT-PROTOCOL.md (Etapa 6).
 */
export const CloseCode = Object.freeze({
  BAD_REQUEST: 4000,
  UNAUTHORIZED: 4001,
  FORBIDDEN: 4003,
  AUTH_TIMEOUT: 4008,
  /** Falha de configuração do servidor (ex.: DISCORD_BOT_TOKEN recusado). */
  INTERNAL_ERROR: 1011,
  /** Discord indisponível, lento ou limitando requisições; o cliente pode tentar de novo. */
  TRY_AGAIN_LATER: 1013,
});

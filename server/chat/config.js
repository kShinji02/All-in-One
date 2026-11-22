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

/**
 * Cache do /users/@me, indexado pelo SHA-256 do token (o token em si nunca é guardado).
 *
 * Um token revogado continua aceito para NOVAS conexões enquanto estiver em cache. O TTL é
 * igual à revalidação dos membros (MEMBERSHIP_REVALIDATE_MS): a janela de revogação fica no
 * mesmo patamar da janela de saída da instância. Custo: no máximo uma chamada extra a
 * /users/@me por usuário e minuto em reconexões (limite por token, não da aplicação).
 * Respostas 401/403 nunca entram no cache.
 */
export const TOKEN_CACHE_TTL_MS = 60_000;
export const TOKEN_CACHE_MAX_ENTRIES = 1_000;

/** Cache do activity-instances (lista de usuários conectados à instância). */
export const INSTANCE_CACHE_TTL_MS = 20_000;
export const INSTANCE_CACHE_MAX_ENTRIES = 500;

/** Caracteres aceitos no instanceId antes de consultá-lo (impede injeção no caminho da URL). */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/** Etapa 3 — salas e mensagens. */
export const MAX_MESSAGE_LENGTH = 500; // em code points, após normalização
export const MAX_NONCE_LENGTH = 64;
export const HISTORY_LIMIT = 100; // mensagens por sala (buffer circular)
export const EMPTY_ROOM_TTL_MS = 10 * 60_000; // sala vazia é removida após 10 min

/** Envio: 5 mensagens por usuário a cada 10 s (todas as conexões do usuário somadas). */
export const MESSAGE_RATE_LIMIT = Object.freeze({ limit: 5, windowMs: 10_000 });

/** Proteção contra inundação: qualquer frame conta, por conexão. Acima disso, a conexão é encerrada. */
export const FRAME_RATE_LIMIT = Object.freeze({ limit: 30, windowMs: 10_000 });

export const MAX_CONNECTIONS_PER_USER = 3;

/**
 * Fase 5.1 — proteção da autenticação contra abuso.
 *
 * A garantia principal não depende de IP: no máximo TOKEN_VALIDATION_RATE_LIMIT consultas
 * NOVAS a /users/@me (10/s), ou 6.000 em 10 min, abaixo do limite de 10.000 requisições
 * inválidas (401/403/429) em 10 min que leva o Discord a bloquear o IP do backend,
 * mesmo que todas sejam inválidas. Tokens em cache (válidos ou não) não contam.
 */
export const TOKEN_VALIDATION_RATE_LIMIT = Object.freeze({ limit: 100, windowMs: 10_000 });
/** Token recusado pelo Discord: novas tentativas com ele falham sem chamar o Discord. */
export const INVALID_TOKEN_CACHE_TTL_MS = 60_000;
export const INVALID_TOKEN_CACHE_MAX_ENTRIES = 5_000;
/** Teto para o Retry-After de um 429 do Discord (protege contra valores absurdos). */
export const DISCORD_MAX_RETRY_AFTER_MS = 5 * 60_000;
/**
 * Por IP do cliente (resolvido com TRUST_PROXY, como em /api/token):
 * - falhas de autenticação (só falhas contam: usuários legítimos que autenticam com
 *   sucesso atrás do mesmo IP não somam nada);
 * - upgrades por minuto (folga para uma sala cheia reconectar de um mesmo IP);
 * - sockets ainda não autenticados (cada um vive no máximo AUTH_TIMEOUT_MS).
 */
export const AUTH_FAILURE_LIMIT = Object.freeze({ limit: 20, windowMs: 5 * 60_000 });
export const UPGRADE_RATE_LIMIT = Object.freeze({ limit: 60, windowMs: 60_000 });
export const MAX_PENDING_AUTH_PER_IP = 50;
export const MAX_PENDING_AUTH_TOTAL = 500;
export const MAX_CONNECTIONS_PER_ROOM = 50;

/** Revalidação periódica dos membros de cada sala (quem saiu da Activity perde o acesso). */
export const MEMBERSHIP_REVALIDATE_MS = 60_000;

/**
 * Códigos de fechamento. 4000–4999 são da aplicação (RFC 6455); 1011 e 1013
 * são códigos padrão. Serão documentados em docs/CHAT-PROTOCOL.md (Etapa 6).
 */
export const CloseCode = Object.freeze({
  BAD_REQUEST: 4000,
  UNAUTHORIZED: 4001,
  FORBIDDEN: 4003,
  AUTH_TIMEOUT: 4008,
  /** Abuso: frames demais, conexões demais por usuário ou sala cheia. */
  RATE_LIMITED: 4029,
  /** Falha de configuração do servidor (ex.: DISCORD_BOT_TOKEN recusado). */
  INTERNAL_ERROR: 1011,
  /** Discord indisponível, lento ou limitando requisições; o cliente pode tentar de novo. */
  TRY_AGAIN_LATER: 1013,
});

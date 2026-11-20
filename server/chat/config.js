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

/**
 * Códigos de fechamento da aplicação (faixa 4000–4999, reservada a aplicações
 * pela RFC 6455). Serão documentados em docs/CHAT-PROTOCOL.md (Etapa 6).
 */
export const CloseCode = Object.freeze({
  BAD_REQUEST: 4000,
  UNAUTHORIZED: 4001,
  FORBIDDEN: 4003,
  AUTH_TIMEOUT: 4008,
});

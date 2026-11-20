import { CloseCode } from "./config.js";

/**
 * Erro que encerra a conexão com um código e um motivo públicos.
 * O motivo é curto (o protocolo limita a 123 bytes) e nunca contém dados sensíveis.
 */
export class ChatCloseError extends Error {
  constructor(closeCode, reason) {
    super(reason);
    this.name = "ChatCloseError";
    this.closeCode = closeCode;
    this.reason = reason;
  }
}

/**
 * Autenticador padrão da Etapa 1: recusa todas as tentativas.
 * A validação real (/users/@me + activity-instances) entra na Etapa 2.
 */
export async function authenticationUnavailable() {
  throw new ChatCloseError(CloseCode.UNAUTHORIZED, "auth_unavailable");
}

export type DiscordErrorCode =
  | 'ready_timeout'
  | 'sdk_init_failed'
  | 'authorize_failed'
  | 'server_misconfigured'
  | 'token_exchange_failed'
  | 'backend_unreachable'
  | 'authenticate_failed';

const messages: Record<DiscordErrorCode, string> = {
  ready_timeout: 'O cliente do Discord não respondeu ao handshake a tempo.',
  sdk_init_failed: 'Não foi possível inicializar o Embedded App SDK.',
  authorize_failed: 'A autorização foi recusada ou cancelada no Discord.',
  server_misconfigured: 'O servidor não tem as credenciais OAuth2 configuradas no .env.',
  token_exchange_failed: 'O servidor não conseguiu trocar o código de autorização por um token.',
  backend_unreachable: 'O servidor da aplicação (/api) não está respondendo.',
  authenticate_failed: 'O Discord recusou a autenticação com o token obtido.',
};

/** Erro de sessão com código estável e mensagem segura para exibir na interface. */
export class DiscordSessionError extends Error {
  readonly code: DiscordErrorCode;
  /** Detalhe técnico opcional (nunca contém tokens). */
  readonly detail: string | null;

  constructor(code: DiscordErrorCode, detail: string | null = null) {
    super(messages[code]);
    this.name = 'DiscordSessionError';
    this.code = code;
    this.detail = detail;
  }
}

export function describeUnknownError(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message: unknown };
    if (typeof message === 'string') return message;
  }
  return null;
}

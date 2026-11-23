export type DiscordErrorCode =
  | 'ready_timeout'
  | 'sdk_init_failed'
  | 'authorize_failed'
  | 'server_misconfigured'
  | 'token_exchange_failed'
  | 'backend_unreachable'
  | 'backend_timeout'
  | 'authenticate_failed';

const messages: Record<DiscordErrorCode, string> = {
  // Timeout não significa recusa: só afirmamos que não houve resposta no prazo.
  ready_timeout:
    'O cliente do Discord não respondeu ao handshake a tempo. Recarregue a Activity; se persistir, confira se o Client ID do .env é o da aplicação aberta no Discord.',
  sdk_init_failed: 'Não foi possível inicializar o Embedded App SDK. Recarregue a Activity pelo Discord.',
  authorize_failed: 'A autorização foi recusada ou cancelada no Discord.',
  server_misconfigured:
    'O servidor não tem as credenciais OAuth2 configuradas. Preencha o .env da raiz do projeto e reinicie o backend.',
  token_exchange_failed: 'O servidor não conseguiu trocar o código de autorização por um token.',
  backend_unreachable:
    'O servidor da aplicação (/api) não está respondendo. Inicie o backend com "npm run dev" na pasta server/ e tente novamente.',
  backend_timeout:
    'O servidor da aplicação demorou para responder; ele pode estar sendo iniciado, o que leva até um minuto. Aguarde alguns segundos e tente novamente.',
  authenticate_failed: 'O Discord recusou a autenticação com o token obtido.',
};

/**
 * Erros que acontecem antes ou durante o handshake. O SDK envia o handshake uma
 * única vez, no construtor, e a instância é reaproveitada; repetir o fluxo não
 * reenvia o handshake. Nesses casos a recuperação é recarregar a Activity.
 */
const RELOAD_REQUIRED: ReadonlySet<string> = new Set<DiscordErrorCode>(['ready_timeout', 'sdk_init_failed']);

export function requiresReload(code: string): boolean {
  return RELOAD_REQUIRED.has(code);
}

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

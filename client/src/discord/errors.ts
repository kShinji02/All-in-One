import { env } from '@/config/env';

export type DiscordErrorCode =
  | 'ready_timeout'
  | 'sdk_init_failed'
  | 'authorize_failed'
  | 'server_misconfigured'
  | 'token_exchange_failed'
  | 'backend_unreachable'
  | 'backend_timeout'
  | 'backend_unavailable'
  | 'authenticate_failed';

/** Mensagens para o usuário final: nada de comandos, arquivos ou detalhes internos. */
const messages: Record<DiscordErrorCode, string> = {
  // Timeout não significa recusa: só afirmamos que não houve resposta no prazo.
  ready_timeout: 'O Discord não respondeu a tempo ao abrir a Activity. Recarregue a Activity para tentar de novo.',
  sdk_init_failed: 'Não foi possível iniciar a Activity. Recarregue a Activity pelo Discord.',
  authorize_failed: 'A autorização foi recusada ou cancelada no Discord.',
  server_misconfigured: 'O servidor do All-in-One está temporariamente sem configuração para entrar. Tente de novo mais tarde.',
  token_exchange_failed: 'Não foi possível concluir a entrada com o Discord. Tente novamente em instantes.',
  backend_unreachable: 'Não foi possível falar com o servidor do All-in-One. Confira sua conexão e tente novamente.',
  backend_timeout:
    'O servidor do All-in-One demorou para responder; ele pode estar sendo iniciado, o que leva até um minuto. Aguarde alguns segundos e tente novamente.',
  backend_unavailable:
    'O servidor do All-in-One está iniciando ou temporariamente indisponível. Isso costuma levar menos de um minuto; tente novamente em instantes.',
  authenticate_failed: 'O Discord não confirmou a sua entrada. Tente novamente.',
};

/**
 * Orientações técnicas, exibidas SOMENTE em desenvolvimento (`npm run dev`): em produção, o
 * usuário nunca vê comandos ou nomes de arquivos.
 */
const devHints: Partial<Record<DiscordErrorCode, string>> = {
  ready_timeout: 'Confira se o VITE_DISCORD_CLIENT_ID do .env é o da aplicação aberta no Discord.',
  server_misconfigured: 'Preencha VITE_DISCORD_CLIENT_ID e DISCORD_CLIENT_SECRET no .env da raiz e reinicie o backend.',
  backend_unreachable: 'Inicie o backend com "npm run dev" na pasta server/.',
  backend_unavailable: 'Confira se o backend está rodando (npm run dev em server/) e o túnel/URL Mapping.',
};

/** Texto exibido para um código. `isDev` acrescenta a orientação técnica de desenvolvimento. */
export function describeSessionError(code: DiscordErrorCode, { isDev = env.isDev }: { isDev?: boolean } = {}): string {
  const hint = isDev ? devHints[code] : undefined;
  return hint ? `${messages[code]} ${hint}` : messages[code];
}

/**
 * Falhas passageiras do backend (Render acordando, proxy sem resposta, rede instável): a
 * sessão tenta de novo sozinha algumas vezes antes de mostrar o erro.
 */
const TRANSIENT: ReadonlySet<string> = new Set<DiscordErrorCode>(['backend_timeout', 'backend_unavailable', 'backend_unreachable']);

export function isTransientSessionError(code: string): boolean {
  return TRANSIENT.has(code);
}

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
    super(describeSessionError(code));
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

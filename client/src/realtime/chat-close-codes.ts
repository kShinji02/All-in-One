/**
 * Classificação dos fechamentos do WebSocket do chat: decide se o cliente deve
 * reconectar ou parar, e qual mensagem mostrar. A tabela espelha os pares
 * (código, motivo) usados em server/chat/*.js; o teste de compatibilidade falha
 * se o servidor passar a usar um par que não esteja aqui.
 */

export type CloseCategory =
  /** Falha passageira (rede, Discord lento, inundação acidental): reconectar com backoff. */
  | 'transient'
  /** Token inválido ou expirado: só reabrindo a Activity. */
  | 'session_expired'
  /** O usuário não está (mais) na instância, ou ela acabou. */
  | 'left_instance'
  /** Limites de conexão do servidor. */
  | 'limit'
  /** Chat não configurado no servidor. */
  | 'unavailable'
  /** O cliente enviou algo que o servidor recusou: erro de programação, não adianta repetir. */
  | 'protocol'
  /** Encerramento pedido pelo próprio cliente. */
  | 'client_closed';

export interface CloseClassification {
  category: CloseCategory;
  reconnect: boolean;
}

/** Pares (código, motivo) enviados pelo servidor. */
export const SERVER_CLOSE_REASONS: Readonly<Record<string, { code: number; category: CloseCategory }>> = {
  auth_timeout: { code: 4008, category: 'transient' },
  discord_unavailable: { code: 1013, category: 'transient' },
  too_many_frames: { code: 4029, category: 'transient' },

  invalid_token: { code: 4001, category: 'session_expired' },
  auth_failed: { code: 4001, category: 'session_expired' },
  auth_required: { code: 4001, category: 'session_expired' },

  not_in_instance: { code: 4003, category: 'left_instance' },
  instance_not_found: { code: 4003, category: 'left_instance' },

  too_many_connections: { code: 4029, category: 'limit' },
  room_full: { code: 4029, category: 'limit' },

  auth_unavailable: { code: 4001, category: 'unavailable' },
  server_misconfigured: { code: 1011, category: 'unavailable' },

  invalid_json: { code: 4000, category: 'protocol' },
  invalid_message: { code: 4000, category: 'protocol' },
  binary_not_supported: { code: 4000, category: 'protocol' },
  invalid_auth: { code: 4000, category: 'protocol' },
  auth_in_progress: { code: 4000, category: 'protocol' },
  invalid_instance: { code: 4000, category: 'protocol' },
};

const RECONNECT: ReadonlySet<CloseCategory> = new Set(['transient']);

/**
 * Classifica um fechamento. O motivo só é considerado quando o código também
 * confere com a tabela (um motivo com código diferente é tratado pelo código).
 */
export function classifyClose(code: number, reason: string): CloseClassification {
  const known = SERVER_CLOSE_REASONS[reason];
  if (known && known.code === code) {
    return { category: known.category, reconnect: RECONNECT.has(known.category) };
  }

  // Códigos padrão (RFC 6455) sem motivo da aplicação.
  if (code === 1000) return { category: 'client_closed', reconnect: false };
  if (code === 1009) return { category: 'protocol', reconnect: false }; // frame acima do limite
  if (code === 1011) return { category: 'unavailable', reconnect: false };
  if (code >= 1001 && code <= 1015) return { category: 'transient', reconnect: true }; // queda, reinício, 1013...

  // Faixa da aplicação (4000–4999) com motivo desconhecido: não arrisca laço de reconexão.
  if (code >= 4000 && code <= 4999) return { category: 'protocol', reconnect: false };

  return { category: 'transient', reconnect: true };
}

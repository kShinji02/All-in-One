import type { StatusTone } from '@/components/ui/StatusPill';
import type { UseChatResult } from '@/realtime/useChat';
import type { FailureReason, SendFailure } from '@/realtime/message-store';

export interface ChatBanner {
  tone: 'warn' | 'danger';
  title: string;
  description: string;
  /** reconnect = useChat().reconnect; reload = recarregar a Activity (novo token). */
  action: { kind: 'reconnect' | 'reload'; label: string } | null;
}

export interface ChatStatusView {
  /** Texto curto do indicador do cabeçalho (também anunciado a leitores de tela). */
  label: string;
  tone: StatusTone;
  pulse: boolean;
  banner: ChatBanner | null;
  /** Se presente, o campo de mensagem fica desabilitado e mostra este motivo. */
  composerDisabledReason: string | null;
}

type ChatState = Pick<UseChatResult, 'connectionState' | 'isReady' | 'isLoading' | 'error'>;

const NO_SESSION = 'O chat abre quando a Activity estiver autenticada no Discord.';

/** Traduz o estado do useChat para o que a interface mostra. Sem lógica de conexão. */
export function describeChatStatus({ connectionState, isReady, isLoading, error }: ChatState): ChatStatusView {
  if (error) {
    switch (error.reason) {
      case 'session_expired':
        return stopped('Sessão expirada', 'Sua sessão do Discord expirou. Recarregue a Activity para voltar ao chat.', 'reload', true);
      case 'left_instance':
        return stopped(
          'Fora da Activity',
          'Você não está mais nesta instância da Activity. Abra a Activity de novo pelo canal para voltar ao chat.',
          'reload',
          true,
        );
      case 'limit':
        return stopped('Limite de conexões', 'Há conexões demais com o chat. Feche outras janelas da Activity e tente de novo.', 'reconnect', false);
      case 'unavailable':
        return stopped('Chat indisponível', 'O servidor não está configurado para o chat no momento.', 'reconnect', true);
      case 'retries_exhausted':
        return stopped(
          'Sem conexão',
          'Não foi possível reconectar ao chat. Confira sua conexão e tente de novo; mensagens enviadas agora esperam a volta.',
          'reconnect',
          false,
        );
      case 'protocol':
        return stopped('Erro de comunicação', 'O servidor recusou a conexão do chat. Tente reconectar.', 'reconnect', false);
      case 'client_closed':
        return stopped('Conexão encerrada', 'A conexão com o chat foi encerrada.', 'reconnect', false);
    }
  }

  switch (connectionState.status) {
    case 'idle':
      return isLoading ? quiet('Conectando', 'neon', true) : { ...quiet('Indisponível', 'neutral', false), composerDisabledReason: NO_SESSION };
    case 'connecting':
      return quiet('Conectando', 'neon', true);
    case 'authenticating':
      return quiet('Autenticando', 'neon', true);
    case 'ready':
      return isReady ? quiet('Conectado', 'ok', true) : quiet('Carregando histórico', 'neon', true);
    case 'reconnecting':
      return {
        label: 'Reconectando',
        tone: 'warn',
        pulse: true,
        banner: {
          tone: 'warn',
          title: 'Reconectando…',
          description: 'As mensagens continuam visíveis. O que você enviar agora sai assim que a conexão voltar.',
          action: { kind: 'reconnect', label: 'Tentar agora' },
        },
        composerDisabledReason: null,
      };
    case 'offline':
      return {
        label: 'Sem internet',
        tone: 'warn',
        pulse: false,
        banner: {
          tone: 'warn',
          title: 'Sem internet',
          description: 'O chat reconecta sozinho quando a conexão voltar. O que você enviar agora fica aguardando.',
          action: { kind: 'reconnect', label: 'Tentar agora' },
        },
        composerDisabledReason: null,
      };
    case 'stopped':
      // Parada sem erro exposto não deveria ocorrer (useChat sempre preenche error).
      return stopped('Conexão encerrada', 'A conexão com o chat foi encerrada.', 'reconnect', false);
  }
}

function quiet(label: string, tone: StatusTone, pulse: boolean): ChatStatusView {
  return { label, tone, pulse, banner: null, composerDisabledReason: null };
}

function stopped(title: string, description: string, action: 'reconnect' | 'reload', disableComposer: boolean): ChatStatusView {
  return {
    label: title,
    tone: 'warn',
    pulse: false,
    banner: {
      tone: 'danger',
      title,
      description,
      action: { kind: action, label: action === 'reload' ? 'Recarregar Activity' : 'Reconectar' },
    },
    composerDisabledReason: disableComposer ? description : null,
  };
}

const REJECTED: Record<string, string> = {
  empty_message: 'a mensagem ficou vazia',
  message_too_long: 'passou de 500 caracteres',
  invalid_message: 'formato inválido',
  invalid_nonce: 'identificador inválido',
};

const FAILURE: Record<FailureReason, string> = {
  rejected: 'recusada pelo servidor',
  rate_limited: 'muitas mensagens em pouco tempo',
  timeout: 'o servidor não respondeu',
  connection_lost: 'a conexão foi encerrada',
  unconfirmed: 'sem confirmação do servidor',
};

/** Motivo curto e legível de uma falha de envio. */
export function describeFailure(failure: SendFailure): string {
  if (failure.reason === 'rejected' && failure.code && REJECTED[failure.code]) return REJECTED[failure.code]!;
  return FAILURE[failure.reason];
}

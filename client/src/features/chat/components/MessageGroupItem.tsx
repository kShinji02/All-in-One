import { memo } from 'react';
import { CircleAlert, Eye, EyeOff, Loader2, RotateCcw, X } from 'lucide-react';
import { describeFailure } from '@/features/chat/lib/chat-status';
import type { MessageGroup } from '@/features/chat/lib/group-messages';
import { MessageText } from '@/features/chat/components/MessageText';
import { Avatar } from '@/features/session/components/Avatar';
import { cn } from '@/lib/cn';
import type { ChatEntry } from '@/realtime/message-store';

const timeFormatter = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fullFormatter = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' });

interface MessageGroupItemProps {
  group: MessageGroup;
  onRetry: (key: string) => void;
  onDiscard: (key: string) => void;
  onOpenLink?: (href: string) => void;
  /** As mensagens deste autor estão ocultas para o usuário (moderação local, só nesta tela). */
  hidden?: boolean;
  /** Oculta/mostra as mensagens do autor. Ausente = sem a opção (ex.: mensagens próprias). */
  onToggleHidden?: (authorId: string) => void;
}

const hideButtonClass =
  'inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-medium text-graphite-400 transition hover:bg-white/[0.06] hover:text-white focus-visible:opacity-100';

/** Cabeçalho (avatar, nome, horário) e as mensagens seguidas de um mesmo autor. */
export const MessageGroupItem = memo(function MessageGroupItem({ group, onRetry, onDiscard, onOpenLink, hidden = false, onToggleHidden }: MessageGroupItemProps) {
  const name = group.author?.displayName ?? (group.own ? 'Você' : 'Usuário');
  const [first] = group.messages;
  const authorId = group.author?.id ?? null;
  const canHide = !group.own && authorId !== null && onToggleHidden !== undefined;

  if (hidden && canHide) {
    const count = group.messages.length;
    return (
      <li className="grid grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-x-3 rounded-xl px-2 py-1.5 sm:px-3" data-hidden-author={authorId}>
        <Avatar src={group.author?.avatarUrl ?? null} label={name} className="size-9 text-sm opacity-40 grayscale" />
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-graphite-400">
          <span className="truncate">
            {count === 1 ? '1 mensagem' : `${count} mensagens`} de {name} ocultada{count === 1 ? '' : 's'} só para você.
          </span>
          <button type="button" onClick={() => onToggleHidden(authorId)} className={hideButtonClass} aria-label={`Mostrar mensagens de ${name}`}>
            <Eye className="size-3" aria-hidden="true" />
            Mostrar
          </button>
        </p>
      </li>
    );
  }

  return (
    <li
      className={cn(
        'group/message relative grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 rounded-xl px-2 py-1.5 sm:px-3',
        group.own && 'bg-gradient-to-r from-neon-600/[0.07] to-transparent',
      )}
      data-own={group.own || undefined}
    >
      <Avatar src={group.author?.avatarUrl ?? null} label={name} className="mt-0.5 size-9 text-sm" />

      <div className="min-w-0">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className={cn('truncate text-sm font-semibold', group.own ? 'text-neon-300' : 'text-white')}>{name}</span>
          {group.own && (
            <span className="shrink-0 rounded-md border border-neon-500/35 bg-neon-500/15 px-1.5 py-px font-mono text-[10px] font-semibold tracking-wide text-neon-300 uppercase">
              Você
            </span>
          )}
          {first && first.status !== 'pending' && <Timestamp entry={first} className="shrink-0" />}
          {canHide && (
            <button
              type="button"
              onClick={() => onToggleHidden(authorId)}
              // Discreto no computador (aparece ao passar o mouse ou focar); sempre visível no celular.
              className={cn(hideButtonClass, 'ml-auto sm:opacity-0 sm:group-hover/message:opacity-100 sm:group-focus-within/message:opacity-100')}
              aria-label={`Ocultar mensagens de ${name} (só para você)`}
              title="Oculta as mensagens desta pessoa só na sua tela, até você sair da Activity"
            >
              <EyeOff className="size-3" aria-hidden="true" />
              <span className="hidden sm:inline">Ocultar</span>
            </button>
          )}
        </p>

        <ul className="mt-0.5 space-y-0.5">
          {group.messages.map((entry, index) => (
            <MessageRow
              key={entry.key}
              entry={entry}
              showTime={index > 0}
              onRetry={onRetry}
              onDiscard={onDiscard}
              onOpenLink={onOpenLink}
            />
          ))}
        </ul>
      </div>
    </li>
  );
});

function Timestamp({ entry, className }: { entry: ChatEntry; className?: string }) {
  const date = new Date(entry.createdAt);
  return (
    <time dateTime={entry.createdAt} title={fullFormatter.format(date)} className={cn('font-mono text-[11px] text-graphite-400', className)}>
      {timeFormatter.format(date)}
    </time>
  );
}

interface MessageRowProps {
  entry: ChatEntry;
  showTime: boolean;
  onRetry: (key: string) => void;
  onDiscard: (key: string) => void;
  onOpenLink?: (href: string) => void;
}

const MessageRow = memo(function MessageRow({ entry, showTime, onRetry, onDiscard, onOpenLink }: MessageRowProps) {
  const pending = entry.status === 'pending';
  const failed = entry.status === 'failed';

  return (
    <li className="group/row relative motion-safe:animate-message-in" data-status={entry.status} data-key={entry.key}>
      {/* Horário das mensagens seguintes aparece na margem ao passar o mouse ou focar. */}
      {showTime && entry.status === 'sent' && (
        <span className="absolute top-1 -left-12 hidden w-9 text-right opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 sm:block">
          <Timestamp entry={entry} className="text-[10px]" />
        </span>
      )}

      <p
        className={cn(
          'text-[15px] leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere] transition-colors duration-300',
          pending ? 'text-graphite-300' : 'text-graphite-100',
          failed && 'text-graphite-300 line-through decoration-signal-danger/50',
        )}
      >
        <MessageText text={entry.text} onOpenLink={onOpenLink} />
      </p>

      {pending && (
        <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-graphite-400">
          <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" />
          Enviando…
        </p>
      )}

      {failed && entry.failure && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="flex items-center gap-1.5 text-xs text-signal-danger">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            Não enviada: {describeFailure(entry.failure)}.
          </p>
          <div className="flex items-center gap-1">
            {entry.failure.retryable && (
              <button
                type="button"
                onClick={() => onRetry(entry.key)}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-electric-300 transition hover:bg-electric-500/10 hover:text-electric-400"
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                Tentar de novo
              </button>
            )}
            <button
              type="button"
              onClick={() => onDiscard(entry.key)}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-graphite-300 transition hover:bg-white/[0.06] hover:text-white"
            >
              <X className="size-3" aria-hidden="true" />
              Descartar
            </button>
          </div>
        </div>
      )}
    </li>
  );
});

import { useMemo, useRef, type ReactNode } from 'react';
import { ArrowDown, CircleAlert, MessageSquare, MessagesSquare, RefreshCw, WifiOff } from 'lucide-react';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { StatusPill } from '@/components/ui/StatusPill';
import { Composer } from '@/features/chat/components/Composer';
import { MessageGroupItem } from '@/features/chat/components/MessageGroupItem';
import { useAutoScroll } from '@/features/chat/hooks/useAutoScroll';
import { describeChatStatus, type ChatBanner } from '@/features/chat/lib/chat-status';
import { groupMessages } from '@/features/chat/lib/group-messages';
import { cn } from '@/lib/cn';
import type { UseChatResult } from '@/realtime/useChat';

interface ChatPanelProps {
  chat: UseChatResult;
  /** Ação "Recarregar Activity" (sessão expirada ou fora da instância). */
  onReload: () => void;
  onOpenLink?: (href: string) => void;
  /** "Agora" para os rótulos de dia (injetável nos testes). */
  now?: Date;
}

/** Painel do chat: cabeçalho com estado, histórico rolável e campo de mensagem. */
export function ChatPanel({ chat, onReload, onOpenLink, now }: ChatPanelProps) {
  const { messages, self, isReady, isLoading, sendMessage, retryMessage, discardMessage, reconnect } = chat;
  const status = describeChatStatus(chat);
  const groups = useMemo(() => groupMessages(messages, self, now), [messages, self, now]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const { atBottom, unseen, onScroll, scrollToBottom } = useAutoScroll(scrollRef, messages, status.banner?.title ?? null);

  const hasMessages = messages.length > 0;
  const runAction = (banner: ChatBanner) => (banner.action?.kind === 'reload' ? onReload() : reconnect());

  return (
    <GlassPanel
      as="section"
      aria-labelledby="chat-heading"
      className="flex h-[min(42rem,calc(100dvh-6rem))] min-h-[26rem] min-w-0 flex-col overflow-hidden motion-safe:animate-fade-up lg:h-[min(46rem,calc(100dvh-8rem))]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3 sm:px-5">
        <h2 id="chat-heading" className="flex items-center gap-2 font-display text-sm font-semibold tracking-wide text-white uppercase">
          <MessageSquare className="size-4 text-neon-400" aria-hidden="true" />
          Chat
        </h2>
        <StatusPill tone={status.tone} pulse={status.pulse}>
          {status.label}
        </StatusPill>
        <p className="sr-only" role="status">
          Chat: {status.label}
        </p>
      </header>

      <div className="relative min-h-0 flex-1">
        {/* O contêiner rolável existe sempre: a observação de tamanho (teclado, banner) não se perde. */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          tabIndex={hasMessages ? 0 : -1}
          role="log"
          aria-label="Mensagens do chat"
          className="scrollbar-subtle h-full overflow-x-hidden overflow-y-auto overscroll-contain px-2 py-3 focus-visible:outline-offset-[-2px] sm:px-3"
        >
          {hasMessages ? (
            <ol className="flex min-h-full flex-col justify-end gap-1">
              {groups.map((group) => (
                <GroupWithDay
                  key={group.key}
                  dayLabel={group.dayLabel}
                  item={<MessageGroupItem group={group} onRetry={retryMessage} onDiscard={discardMessage} onOpenLink={onOpenLink} />}
                />
              ))}
            </ol>
          ) : (
            <EmptyState loading={isLoading} ready={isReady} unavailable={status.composerDisabledReason !== null && !status.banner} />
          )}
        </div>

        {hasMessages && !atBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className={cn(
              'absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur-md transition motion-safe:animate-fade-up',
              unseen > 0
                ? 'border-neon-500/40 bg-neon-600/80 text-white hover:bg-neon-500/90'
                : 'border-white/10 bg-graphite-800/90 text-graphite-100 hover:bg-graphite-700',
            )}
          >
            <ArrowDown className="size-3.5" aria-hidden="true" />
            {unseen > 0 ? `${unseen} ${unseen === 1 ? 'nova mensagem' : 'novas mensagens'}` : 'Ir para as recentes'}
          </button>
        )}
      </div>

      {status.banner && <Banner banner={status.banner} onAction={() => runAction(status.banner!)} />}

      <Composer onSend={sendMessage} disabledReason={status.composerDisabledReason} />
    </GlassPanel>
  );
}

function GroupWithDay({ dayLabel, item }: { dayLabel: string | null; item: ReactNode }) {
  return (
    <>
      {dayLabel && (
        <li role="separator" aria-label={dayLabel} className="flex items-center gap-3 px-3 py-2">
          <span className="h-px flex-1 bg-white/[0.06]" aria-hidden="true" />
          <span className="font-mono text-[10px] tracking-[0.15em] text-graphite-400 uppercase">{dayLabel}</span>
          <span className="h-px flex-1 bg-white/[0.06]" aria-hidden="true" />
        </li>
      )}
      {item}
    </>
  );
}

function Banner({ banner, onAction }: { banner: ChatBanner; onAction: () => void }) {
  const Icon = banner.tone === 'danger' ? CircleAlert : WifiOff;
  return (
    <div
      role="alert"
      className={cn(
        'mx-3 mb-0 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border px-3.5 py-2.5 motion-safe:animate-fade-up sm:mx-4 sm:flex-nowrap',
        banner.tone === 'danger' ? 'border-signal-danger/25 bg-signal-danger/[0.07]' : 'border-signal-warn/20 bg-signal-warn/[0.06]',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', banner.tone === 'danger' ? 'text-signal-danger' : 'text-signal-warn')} aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-[calc(100%-1.75rem)] sm:basis-auto">
        <p className="text-sm font-medium text-white">{banner.title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-graphite-300">{banner.description}</p>
      </div>
      {banner.action && (
        <button
          type="button"
          onClick={onAction}
          className="ml-7 inline-flex shrink-0 items-center gap-1.5 rounded-lg border sm:ml-0 sm:self-center border-electric-400/30 bg-electric-500/10 px-2.5 py-1 text-xs font-medium text-electric-300 transition hover:border-electric-400/60 hover:bg-electric-500/20 active:scale-[0.98]"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {banner.action.label}
        </button>
      )}
    </div>
  );
}

function EmptyState({ loading, ready, unavailable }: { loading: boolean; ready: boolean; unavailable: boolean }) {
  if (loading) {
    return (
      <div className="flex h-full flex-col justify-end gap-4 px-5 py-5" aria-hidden="true">
        {[0.9, 0.6, 0.75].map((width, i) => (
          <div key={i} className="flex items-start gap-3 motion-safe:animate-pulse">
            <span className="size-9 shrink-0 rounded-full bg-white/[0.06]" />
            <span className="flex-1 space-y-2 pt-1">
              <span className="block h-2.5 w-24 rounded bg-white/[0.07]" />
              <span className="block h-2.5 rounded bg-white/[0.05]" style={{ width: `${width * 100}%` }} />
            </span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="max-w-xs">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-neon-500/20 to-electric-500/10 text-neon-300 ring-1 ring-neon-500/25 ring-inset">
          <MessagesSquare className="size-6" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <p className="mt-4 font-display text-base font-semibold text-white">
          {ready ? 'Nenhuma mensagem ainda' : unavailable ? 'Chat fora do ar' : 'Chat desconectado'}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-graphite-300">
          {ready
            ? 'Comece a conversa com quem está na Activity.'
            : unavailable
              ? 'O chat abre quando a Activity estiver autenticada no Discord.'
              : 'As mensagens aparecem assim que a conexão for restabelecida.'}
        </p>
      </div>
    </div>
  );
}

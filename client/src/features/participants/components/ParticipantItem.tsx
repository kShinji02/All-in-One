import type { DiscordParticipant } from '@/discord/types';
import { Avatar } from '@/features/session/components/Avatar';
import { cn } from '@/lib/cn';

interface ParticipantItemProps {
  participant: DiscordParticipant;
  isCurrentUser: boolean;
  leaving: boolean;
}

export function ParticipantItem({ participant, isCurrentUser, leaving }: ParticipantItemProps) {
  return (
    <li
      aria-hidden={leaving || undefined}
      className={cn(
        'group flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors duration-300',
        isCurrentUser
          ? 'border-neon-500/25 bg-gradient-to-r from-neon-600/[0.12] to-electric-600/[0.06]'
          : 'border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12]',
        leaving ? 'pointer-events-none motion-safe:animate-fade-out' : 'motion-safe:animate-fade-up',
      )}
    >
      <span className="relative shrink-0">
        <Avatar src={participant.avatarUrl} label={participant.displayName} className="size-10 text-sm" />
        <span
          className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-graphite-900 bg-signal-ok"
          aria-hidden="true"
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium text-white">{participant.displayName}</p>
          {isCurrentUser && (
            <span className="shrink-0 rounded-md border border-neon-500/35 bg-neon-500/15 px-1.5 py-px font-mono text-[10px] font-semibold tracking-wide text-neon-300 uppercase">
              Você
            </span>
          )}
          {participant.bot && (
            <span className="shrink-0 rounded-md border border-electric-400/30 bg-electric-500/10 px-1.5 py-px font-mono text-[10px] font-semibold tracking-wide text-electric-300 uppercase">
              Bot
            </span>
          )}
        </div>
        <p className="truncate font-mono text-xs text-graphite-400">@{participant.username}</p>
      </div>

      <span className="hidden shrink-0 items-center gap-1.5 font-mono text-[10px] tracking-wide text-signal-ok uppercase sm:flex">
        <span className="size-1.5 rounded-full bg-signal-ok" aria-hidden="true" />
        Na Activity
      </span>
      <span className="sr-only sm:hidden">Na Activity</span>
    </li>
  );
}

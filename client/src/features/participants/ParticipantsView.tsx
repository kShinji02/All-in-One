import { useMemo, type ReactNode } from 'react';
import { CircleAlert, RotateCcw, UserRoundX, Users } from 'lucide-react';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { StatusPill } from '@/components/ui/StatusPill';
import type { DiscordParticipant } from '@/discord/types';
import { useDiscord } from '@/discord/useDiscord';
import { ParticipantItem } from '@/features/participants/components/ParticipantItem';
import { ParticipantsSkeleton } from '@/features/participants/components/ParticipantsSkeleton';
import { useParticipants } from '@/features/participants/hooks/useParticipants';
import { usePresenceList } from '@/features/participants/hooks/usePresenceList';

const EMPTY: DiscordParticipant[] = [];
const participantKey = (p: DiscordParticipant) => p.id;
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/** Seção PARTICIPANTES: usuários conectados à mesma instância da Activity. */
export function ParticipantsView() {
  const { state: discord } = useDiscord();
  const { state, retry } = useParticipants();
  const currentUserId = discord.status === 'ready' ? discord.session.user.id : null;

  // Usuário atual primeiro; demais em ordem alfabética.
  const participants = useMemo(() => {
    if (state.status !== 'ready') return EMPTY;
    return [...state.participants].sort((a, b) => {
      if (a.id === currentUserId) return -1;
      if (b.id === currentUserId) return 1;
      return collator.compare(a.displayName, b.displayName);
    });
  }, [state, currentUserId]);

  const entries = usePresenceList(participants, participantKey);

  return (
    <GlassPanel
      as="section"
      aria-labelledby="participants-heading"
      className="flex flex-col p-5 motion-safe:animate-fade-up sm:p-6"
      style={{ animationDelay: '60ms' }}
    >
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2
          id="participants-heading"
          className="flex items-center gap-2 font-display text-sm font-semibold tracking-wide text-white uppercase"
        >
          <Users className="size-4 text-electric-400" aria-hidden="true" />
          Participantes
        </h2>
        {state.status === 'ready' ? (
          <StatusPill tone="ok" pulse>
            <span aria-live="polite">{participants.length} na Activity</span>
          </StatusPill>
        ) : state.status === 'loading' ? (
          <StatusPill tone="neon">Carregando</StatusPill>
        ) : state.status === 'error' ? (
          <StatusPill tone="warn">Erro</StatusPill>
        ) : (
          <StatusPill tone="neutral">Inativo</StatusPill>
        )}
      </div>

      {state.status === 'inactive' && (
        <Notice icon={<Users className="size-5" />} title="Aguardando a sessão do Discord">
          {discord.status === 'connecting'
            ? 'A lista aparece assim que a autenticação terminar.'
            : 'A lista de participantes fica disponível quando a Activity é aberta e autenticada no Discord.'}
        </Notice>
      )}

      {state.status === 'loading' && <ParticipantsSkeleton />}

      {state.status === 'error' && (
        <div className="space-y-4">
          <Notice icon={<CircleAlert className="size-5 text-signal-warn" />} title={state.message}>
            {state.detail && <code className="block font-mono text-xs break-all text-graphite-400">{state.detail}</code>}
          </Notice>
          <button
            type="button"
            onClick={retry}
            className="inline-flex items-center gap-2 rounded-xl border border-electric-400/30 bg-electric-500/10 px-4 py-2 text-sm font-medium text-electric-300 transition hover:border-electric-400/60 hover:bg-electric-500/20 active:scale-[0.98]"
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            Tentar novamente
          </button>
        </div>
      )}

      {state.status === 'ready' &&
        (entries.length === 0 ? (
          <Notice icon={<UserRoundX className="size-5" />} title="Ninguém conectado">
            Nenhum usuário está conectado a esta instância da Activity no momento.
          </Notice>
        ) : (
          <ul className="grid gap-2" aria-label="Participantes conectados">
            {entries.map(({ item, leaving }) => (
              <ParticipantItem
                key={item.id}
                participant={item}
                isCurrentUser={item.id === currentUserId}
                leaving={leaving}
              />
            ))}
          </ul>
        ))}

      <p className="mt-5 text-[11px] leading-relaxed text-graphite-400">
        Mostra quem abriu esta Activity, não necessariamente todos os usuários do canal de voz.
      </p>
    </GlassPanel>
  );
}

function Notice({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 text-graphite-400" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium text-white">{title}</p>
        {children && <div className="text-sm leading-relaxed text-graphite-300">{children}</div>}
      </div>
    </div>
  );
}

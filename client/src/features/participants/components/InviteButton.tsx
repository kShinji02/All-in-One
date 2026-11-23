import { useId, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, UserPlus } from 'lucide-react';
import { openInviteDialog, type InviteResult } from '@/discord/invite';

/** Orientação quando o Discord não abre a tela de convite (o recurso continua existindo no próprio Discord). */
const FALLBACK: Record<Exclude<InviteResult, 'opened' | 'unavailable'>, string> = {
  unsupported:
    'Esta versão do Discord não abre o convite pela Activity. Use o botão de convite do próprio Discord, no topo da Activity, ou chame as pessoas para o canal de voz.',
  failed:
    'O Discord não abriu o convite agora. Tente de novo ou use o botão de convite do próprio Discord, no topo da Activity.',
};

/**
 * "Convidar participantes": abre a tela de convite OFICIAL do Discord (commands.openInviteDialog).
 * Só aparece depois que o SDK concluiu a conexão; um clique por vez; erros viram orientação.
 */
export function InviteButton({ sdkReady }: { sdkReady: boolean }) {
  const hintId = useId();
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<keyof typeof FALLBACK | null>(null);
  const busy = useRef(false);

  if (!sdkReady) return null;

  async function invite() {
    if (busy.current) return; // clique duplicado
    busy.current = true;
    setOpening(true);
    setProblem(null);
    try {
      const result = await openInviteDialog({ sdkReady });
      setProblem(result === 'unsupported' || result === 'failed' ? result : null);
    } finally {
      busy.current = false;
      setOpening(false);
    }
  }

  return (
    <div className="mb-5">
      <button
        type="button"
        onClick={invite}
        disabled={opening}
        aria-busy={opening}
        aria-describedby={hintId}
        className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-electric-400/35 bg-electric-500/10 px-4 py-2.5 text-sm font-semibold text-electric-300 transition hover:border-electric-400/60 hover:bg-electric-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-electric-400 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
      >
        {opening ? <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : <UserPlus className="size-4" aria-hidden="true" />}
        {opening ? 'Abrindo convite…' : 'Convidar participantes'}
      </button>
      <p id={hintId} className="mt-1.5 text-[11px] leading-relaxed text-graphite-400">
        Abre a tela de convite do próprio Discord; você escolhe quem convidar.
      </p>
      {problem && (
        <p role="alert" className="mt-2 flex gap-2 rounded-xl border border-signal-warn/20 bg-signal-warn/[0.06] px-3 py-2 text-xs leading-relaxed text-graphite-300">
          <CircleAlert className="mt-px size-3.5 shrink-0 text-signal-warn" aria-hidden="true" />
          {FALLBACK[problem]}
        </p>
      )}
    </div>
  );
}

import { Check, LoaderCircle } from 'lucide-react';
import type { ConnectionStep } from '@/discord/types';
import { cn } from '@/lib/cn';

const steps: Array<{ id: ConnectionStep; label: string }> = [
  { id: 'ready', label: 'Handshake com o Discord' },
  { id: 'authorize', label: 'Autorização OAuth2' },
  { id: 'token', label: 'Troca de código no servidor' },
  { id: 'authenticate', label: 'Autenticação do usuário' },
  { id: 'context', label: 'Contexto do canal e servidor' },
];

export function ConnectionProgress({ current }: { current: ConnectionStep }) {
  const currentIndex = steps.findIndex((s) => s.id === current);

  return (
    <ol className="space-y-3" aria-live="polite">
      {steps.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li key={step.id} className="flex items-center gap-3 text-sm">
            <span
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-full border transition-colors duration-300',
                done && 'border-signal-ok/40 bg-signal-ok/15 text-signal-ok',
                active && 'border-electric-400/50 bg-electric-500/15 text-electric-300',
                !done && !active && 'border-white/10 text-graphite-400',
              )}
            >
              {done ? (
                <Check className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
              ) : active ? (
                <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <span className="size-1.5 rounded-full bg-current" />
              )}
            </span>
            <span className={cn(done || active ? 'text-graphite-100' : 'text-graphite-400')}>{step.label}</span>
            {active && <span className="sr-only">(em andamento)</span>}
          </li>
        );
      })}
    </ol>
  );
}

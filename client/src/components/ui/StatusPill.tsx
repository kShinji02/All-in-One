import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type StatusTone = 'ok' | 'warn' | 'neutral' | 'neon';

const toneClass: Record<StatusTone, { pill: string; dot: string }> = {
  ok: { pill: 'border-signal-ok/25 bg-signal-ok/10 text-signal-ok', dot: 'bg-signal-ok' },
  warn: { pill: 'border-signal-warn/25 bg-signal-warn/10 text-signal-warn', dot: 'bg-signal-warn' },
  neutral: { pill: 'border-white/10 bg-white/[0.04] text-graphite-300', dot: 'bg-graphite-400' },
  neon: { pill: 'border-neon-500/30 bg-neon-500/10 text-neon-300', dot: 'bg-neon-400' },
};

interface StatusPillProps {
  tone?: StatusTone;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
}

/** Indicador de estado compacto. Puramente informativo, não é interativo. */
export function StatusPill({ tone = 'neutral', pulse = false, children, className }: StatusPillProps) {
  const t = toneClass[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-medium tracking-wide uppercase',
        t.pill,
        className,
      )}
    >
      <span className="relative flex size-1.5">
        {pulse && <span className={cn('absolute inset-0 rounded-full opacity-70 motion-safe:animate-ping', t.dot)} />}
        <span className={cn('relative size-1.5 rounded-full', t.dot)} />
      </span>
      {children}
    </span>
  );
}

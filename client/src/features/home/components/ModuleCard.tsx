import { GlassPanel } from '@/components/ui/GlassPanel';
import { StatusPill } from '@/components/ui/StatusPill';
import type { FeatureModule } from '@/features/registry';
import { cn } from '@/lib/cn';

interface ModuleCardProps {
  module: FeatureModule;
  index: number;
}

const accentClass = {
  neon: 'from-neon-500/25 to-neon-600/5 text-neon-300 ring-neon-500/30',
  electric: 'from-electric-500/25 to-electric-600/5 text-electric-300 ring-electric-500/30',
} as const;

/** Cartão informativo de um módulo do roteiro. Não é clicável enquanto o módulo não existir. */
export function ModuleCard({ module, index }: ModuleCardProps) {
  const Icon = module.icon;
  return (
    <GlassPanel
      as="li"
      glow={module.accent}
      className="flex flex-col gap-4 p-5 motion-safe:animate-fade-up"
      style={{ animationDelay: `${150 + index * 70}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={cn(
            'grid size-10 place-items-center rounded-xl bg-gradient-to-br ring-1 ring-inset',
            accentClass[module.accent],
          )}
        >
          <Icon className="size-5" strokeWidth={1.75} aria-hidden="true" />
        </span>
        {module.status === 'planned' ? (
          <StatusPill tone="neutral">Planejado</StatusPill>
        ) : module.native ? (
          <StatusPill tone="neutral">Pelo Discord</StatusPill>
        ) : (
          <StatusPill tone="ok">Disponível</StatusPill>
        )}
      </div>
      <div>
        <h3 className="font-display text-base font-semibold text-white">{module.name}</h3>
        <p className="mt-1 text-sm leading-relaxed text-graphite-300">{module.description}</p>
      </div>
    </GlassPanel>
  );
}

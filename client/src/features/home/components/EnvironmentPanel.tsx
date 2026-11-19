import type { ReactNode } from 'react';
import { Cpu, KeyRound, MonitorSmartphone, Server } from 'lucide-react';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { StatusPill } from '@/components/ui/StatusPill';
import { env } from '@/config/env';
import { useDiscord } from '@/discord/useDiscord';
import type { LaunchContext } from '@/lib/launch-context';

interface EnvironmentPanelProps {
  launch: LaunchContext;
}

const platformLabel = { desktop: 'Desktop', mobile: 'Mobile', unknown: 'Não informada' } as const;

/**
 * Diagnóstico real do ambiente em que a interface está rodando.
 * Nunca exibe valores de credenciais, apenas se estão configuradas.
 */
export function EnvironmentPanel({ launch }: EnvironmentPanelProps) {
  return (
    <GlassPanel className="p-5 motion-safe:animate-fade-up sm:p-6" style={{ animationDelay: '80ms' }}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-sm font-semibold tracking-wide text-white uppercase">Ambiente</h2>
        <span className="font-mono text-[11px] text-graphite-400">{env.mode}</span>
      </div>

      <dl className="mt-5 divide-y divide-white/[0.05]">
        <Row icon={<MonitorSmartphone className="size-4" />} label="Contexto">
          {launch.isDiscord ? (
            <StatusPill tone="ok">Discord</StatusPill>
          ) : (
            <StatusPill tone="neutral">Navegador</StatusPill>
          )}
        </Row>

        {launch.isDiscord && (
          <Row icon={<Cpu className="size-4" />} label="Plataforma">
            <span className="text-sm text-graphite-100">{platformLabel[launch.platform]}</span>
          </Row>
        )}

        <Row icon={<KeyRound className="size-4" />} label="Client ID">
          {env.isDiscordClientIdConfigured ? (
            <StatusPill tone="ok">Configurado</StatusPill>
          ) : (
            <StatusPill tone="warn">Ausente no .env</StatusPill>
          )}
        </Row>

        <Row icon={<Server className="size-4" />} label="Embedded App SDK">
          <SdkStatus />
        </Row>
      </dl>
    </GlassPanel>
  );
}

function SdkStatus() {
  const { state } = useDiscord();
  switch (state.status) {
    case 'ready':
      return <StatusPill tone="ok">Autenticado</StatusPill>;
    case 'connecting':
      return <StatusPill tone="neon">Conectando</StatusPill>;
    case 'error':
      return <StatusPill tone="warn">Erro</StatusPill>;
    case 'misconfigured':
      return <StatusPill tone="warn">Sem Client ID</StatusPill>;
    case 'unavailable':
      return <StatusPill tone="neutral">Inativo</StatusPill>;
  }
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <dt className="flex items-center gap-2.5 text-sm text-graphite-300">
        <span className="text-graphite-400" aria-hidden="true">
          {icon}
        </span>
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

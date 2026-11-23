import { CircleAlert, MonitorOff, RefreshCw, RotateCcw, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { StatusPill } from '@/components/ui/StatusPill';
import { requiresReload } from '@/discord/errors';
import { useDiscord } from '@/discord/useDiscord';
import { reloadPage } from '@/lib/reload-page';
import { ConnectionProgress } from '@/features/session/components/ConnectionProgress';
import { SessionDetails } from '@/features/session/components/SessionDetails';

const actionButtonClass =
  'inline-flex items-center gap-2 rounded-xl border border-electric-400/30 bg-electric-500/10 px-4 py-2 text-sm font-medium text-electric-300 transition hover:border-electric-400/60 hover:bg-electric-500/20 active:scale-[0.98]';

/** Painel com o estado da conexão com o Discord e os dados da sessão autenticada. */
export function ConnectionPanel() {
  const { state, retry } = useDiscord();

  const pill =
    state.status === 'ready' ? (
      <StatusPill tone="ok" pulse>
        Conectado
      </StatusPill>
    ) : state.status === 'connecting' ? (
      <StatusPill tone="neon" pulse>
        Conectando
      </StatusPill>
    ) : state.status === 'error' ? (
      <StatusPill tone="warn">Erro</StatusPill>
    ) : state.status === 'misconfigured' ? (
      <StatusPill tone="warn">Configuração</StatusPill>
    ) : (
      <StatusPill tone="neutral">Offline</StatusPill>
    );

  return (
    <GlassPanel as="section" aria-labelledby="session-heading" className="p-5 motion-safe:animate-fade-up sm:p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 id="session-heading" className="font-display text-sm font-semibold tracking-wide text-white uppercase">
          Sessão Discord
        </h2>
        {pill}
      </div>

      {state.status === 'ready' && <SessionDetails session={state.session} />}

      {state.status === 'connecting' && <ConnectionProgress current={state.step} retry={state.retry} />}

      {state.status === 'unavailable' && (
        <Notice icon={<MonitorOff className="size-5" />} title="Fora do Discord">
          Esta página está aberta direto no navegador. A autenticação acontece somente quando a Activity é iniciada
          pelo Discord, em um canal de voz ou mensagem.
        </Notice>
      )}

      {state.status === 'misconfigured' && (
        <Notice icon={<Settings2 className="size-5" />} title="Client ID não configurado">
          Defina <code className="font-mono text-neon-300">VITE_DISCORD_CLIENT_ID</code> no arquivo{' '}
          <code className="font-mono text-neon-300">.env</code> da raiz do projeto e reinicie o Vite.
        </Notice>
      )}

      {state.status === 'error' && (
        <div className="space-y-4">
          <Notice icon={<CircleAlert className="size-5 text-signal-warn" />} title={state.message}>
            {/* Código curto para suporte (sem dados pessoais nem tokens). */}
            <p className="text-xs text-graphite-400">
              Código para suporte:{' '}
              <code className="font-mono break-all">
                {state.code}
                {state.detail ? ` · ${state.detail}` : ''}
              </code>
            </p>
          </Notice>
          {/* O SDK só envia o handshake no construtor: sem handshake concluído, repetir o fluxo
              na mesma instância não adianta, então o botão recarrega a Activity. */}
          {requiresReload(state.code) ? (
            <button type="button" onClick={reloadPage} className={actionButtonClass}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Recarregar Activity
            </button>
          ) : (
            <button type="button" onClick={retry} className={actionButtonClass}>
              <RotateCcw className="size-4" aria-hidden="true" />
              Tentar novamente
            </button>
          )}
        </div>
      )}
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
        <div className="text-sm leading-relaxed text-graphite-300">{children}</div>
      </div>
    </div>
  );
}

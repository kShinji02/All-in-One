import type { ReactNode } from 'react';
import { Hash, MonitorSmartphone, Server, ShieldCheck, Fingerprint } from 'lucide-react';
import type { DiscordSession } from '@/discord/types';
import { Avatar } from '@/features/session/components/Avatar';

const platformLabel = { desktop: 'Desktop', mobile: 'Mobile' } as const;

export function SessionDetails({ session }: { session: DiscordSession }) {
  const { user, guild, channel, context } = session;
  const displayName = user.globalName ?? user.username;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Avatar src={user.avatarUrl} label={displayName} className="size-14 text-xl" />
        <div className="min-w-0">
          <p className="truncate font-display text-lg font-semibold text-white">{displayName}</p>
          <p className="truncate font-mono text-xs text-graphite-400">@{user.username}</p>
        </div>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Field icon={<Server className="size-4" />} label="Servidor">
          {context.guildId === null ? (
            'Mensagem direta'
          ) : guild ? (
            <span className="flex min-w-0 items-center gap-2">
              <Avatar src={guild.iconUrl} label={guild.name} shape="rounded" className="size-5 text-[10px]" />
              <span className="truncate">{guild.name}</span>
            </span>
          ) : (
            <Unavailable />
          )}
        </Field>

        <Field icon={<Hash className="size-4" />} label="Canal">
          {channel?.name ? <span className="truncate">{channel.name}</span> : <Unavailable />}
        </Field>

        <Field icon={<MonitorSmartphone className="size-4" />} label="Plataforma">
          {platformLabel[context.platform]}
        </Field>

        <Field icon={<Fingerprint className="size-4" />} label="Instância">
          <span className="truncate font-mono text-xs" title={context.instanceId}>
            {context.instanceId}
          </span>
        </Field>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="size-4 text-signal-ok" aria-hidden="true" />
        <span className="text-xs text-graphite-400">Escopos concedidos:</span>
        {session.scopes.map((scope) => (
          <span
            key={scope}
            className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 font-mono text-[11px] text-graphite-300"
          >
            {scope}
          </span>
        ))}
      </div>
    </div>
  );
}

function Field({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
      <dt className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-graphite-400 uppercase">
        <span aria-hidden="true">{icon}</span>
        {label}
      </dt>
      <dd className="mt-1.5 flex min-w-0 text-sm text-graphite-100">{children}</dd>
    </div>
  );
}

function Unavailable() {
  return <span className="text-graphite-400">Indisponível</span>;
}

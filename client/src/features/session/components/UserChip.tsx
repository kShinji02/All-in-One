import { useDiscord } from '@/discord/useDiscord';
import { Avatar } from '@/features/session/components/Avatar';

/** Identificação compacta do usuário autenticado, exibida no cabeçalho. */
export function UserChip() {
  const { state } = useDiscord();
  if (state.status !== 'ready') return null;

  const { user } = state.session;
  const name = user.globalName ?? user.username;
  return (
    <span className="flex min-w-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-0.5 pr-3 pl-0.5">
      <Avatar src={user.avatarUrl} label={name} className="size-6 text-[11px]" />
      <span className="max-w-[10rem] truncate text-xs font-medium text-graphite-100">{name}</span>
    </span>
  );
}

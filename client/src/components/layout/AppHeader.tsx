import { BrandMark } from '@/components/brand/BrandMark';
import { StatusPill } from '@/components/ui/StatusPill';
import { UserChip } from '@/features/session/components/UserChip';
import type { LaunchContext } from '@/lib/launch-context';

interface AppHeaderProps {
  launch: LaunchContext;
}

export function AppHeader({ launch }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-void/60 backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-8" />
          <span className="font-display text-[15px] font-semibold tracking-tight text-white">
            All<span className="text-graphite-400">-</span>in<span className="text-graphite-400">-</span>One
          </span>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <UserChip />
          {launch.isDiscord ? (
            <StatusPill tone="ok" pulse>
              Discord
            </StatusPill>
          ) : (
            <StatusPill tone="neutral">Navegador</StatusPill>
          )}
        </div>
      </div>
    </header>
  );
}

import type { ReactNode } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import type { LaunchContext } from '@/lib/launch-context';

interface AppShellProps {
  launch: LaunchContext;
  children: ReactNode;
}

/**
 * Estrutura global da aplicação: fundo, cabeçalho e área de conteúdo.
 * Novas áreas (ex.: barra lateral de participantes) devem ser encaixadas aqui.
 */
export function AppShell({ launch, children }: AppShellProps) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-x-hidden">
      <div aria-hidden="true" className="bg-tech-grid pointer-events-none absolute inset-0 -z-10" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-[-12rem] left-1/2 -z-10 size-[36rem] -translate-x-1/2 rounded-full bg-neon-600/20 blur-[120px] motion-safe:animate-glow"
      />

      <AppHeader launch={launch} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-12">{children}</main>

      <footer className="border-t border-white/[0.05] py-4">
        <p className="mx-auto max-w-6xl px-4 font-mono text-[11px] tracking-wide text-graphite-400 sm:px-6">
          ALL-IN-ONE · DISCORD ACTIVITY · v0.1.0
        </p>
      </footer>
    </div>
  );
}

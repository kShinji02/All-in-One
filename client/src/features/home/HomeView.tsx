import { FeatureBoundary } from '@/components/ui/FeatureBoundary';
import { EnvironmentPanel } from '@/features/home/components/EnvironmentPanel';
import { ModuleCard } from '@/features/home/components/ModuleCard';
import { featureModules, modulesInSlot, type FeatureModule, type HomeSlot } from '@/features/registry';
import { ConnectionPanel } from '@/features/session/ConnectionPanel';
import type { LaunchContext } from '@/lib/launch-context';

interface HomeViewProps {
  launch: LaunchContext;
  /** Registro usado pela Home (injetável nos testes). */
  modules?: readonly FeatureModule[];
}

/**
 * Tela inicial: apresentação e diagnóstico, área principal dos módulos e roteiro.
 *
 * Os módulos disponíveis vêm do registro (features/registry.ts): `main` recebe a maior
 * parte do espaço e `aside` fica na coluna lateral (empilhados no celular, nessa ordem).
 * Cada painel fica num FeatureBoundary: a falha de um não derruba os outros.
 */
export function HomeView({ launch, modules = featureModules }: HomeViewProps) {
  return (
    <div className="flex flex-col gap-10 sm:gap-14">
      <section className="grid items-center gap-8 lg:grid-cols-[1.25fr_1fr] lg:gap-12">
        <div className="motion-safe:animate-fade-up">
          <p className="font-mono text-xs tracking-[0.2em] text-electric-400 uppercase">Discord Activity</p>
          <h1 className="mt-3 font-display text-4xl leading-[1.05] font-semibold tracking-tight text-white sm:text-5xl lg:text-6xl">
            Tudo em um, <span className="text-gradient-brand">direto no canal.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-graphite-300 sm:text-lg">
            Uma central única para conversar, ver quem está presente, se comunicar e assistir conteúdo
            junto, sem sair do Discord.
          </p>
        </div>

        <FeatureBoundary name="Ambiente">
          <EnvironmentPanel launch={launch} />
        </FeatureBoundary>
      </section>

      {/* Área principal: módulos "main" com a maior parte do espaço; "aside" e a sessão ao lado. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <SlotModules slot="main" modules={modules} />
        <div className="flex min-w-0 flex-col gap-6">
          <SlotModules slot="aside" modules={modules} />
          {/* A sessão é a infraestrutura dos módulos (SDK + OAuth), não um módulo do roteiro. */}
          <FeatureBoundary name="Sessão Discord">
            <ConnectionPanel />
          </FeatureBoundary>
        </div>
      </div>

      <section aria-labelledby="modules-heading">
        <div className="mb-5 flex items-end justify-between gap-4">
          <h2 id="modules-heading" className="font-display text-xl font-semibold tracking-tight text-white">
            Módulos
          </h2>
          <span className="font-mono text-[11px] tracking-wide text-graphite-400 uppercase">Roteiro</span>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {modules.map((module, index) => (
            <ModuleCard key={module.id} module={module} index={index} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function SlotModules({ slot, modules }: { slot: HomeSlot; modules: readonly FeatureModule[] }) {
  return (
    <>
      {modulesInSlot(slot, modules).map(({ id, name, View }) => (
        <FeatureBoundary key={id} name={name}>
          <View />
        </FeatureBoundary>
      ))}
    </>
  );
}

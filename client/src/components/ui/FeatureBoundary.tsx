import { Component, type ErrorInfo, type ReactNode } from 'react';
import { CircleAlert, RotateCcw } from 'lucide-react';
import { GlassPanel } from '@/components/ui/GlassPanel';

interface FeatureBoundaryProps {
  /** Nome exibido no aviso (ex.: "Chat"). */
  name: string;
  children: ReactNode;
}

interface FeatureBoundaryState {
  failed: boolean;
}

/**
 * Isola uma funcionalidade da Home: um erro de renderização dentro dela mostra um aviso
 * no lugar do painel e mantém o resto da Activity funcionando (participantes, sessão,
 * SDK e OAuth continuam montados). "Tentar novamente" remonta só este painel.
 *
 * Erros de eventos e de código assíncrono não passam por aqui (React não os captura);
 * cada funcionalidade já trata esses casos no próprio estado.
 */
export class FeatureBoundary extends Component<FeatureBoundaryProps, FeatureBoundaryState> {
  state: FeatureBoundaryState = { failed: false };

  static getDerivedStateFromError(): FeatureBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    // Só o tipo do erro: a mensagem pode conter dados do usuário.
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[home] O painel "${this.props.name}" falhou (${kind}).`);
  }

  private reset = () => this.setState({ failed: false });

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <GlassPanel as="section" aria-label={this.props.name} className="p-5 sm:p-6">
        <div role="alert" className="flex gap-3">
          <CircleAlert className="mt-0.5 size-5 shrink-0 text-signal-warn" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">{this.props.name} indisponível no momento</p>
            <p className="mt-1 text-sm leading-relaxed text-graphite-300">
              Este painel encontrou um erro. O restante da Activity continua funcionando.
            </p>
            <button
              type="button"
              onClick={this.reset}
              className="mt-3 inline-flex items-center gap-2 rounded-xl border border-electric-400/30 bg-electric-500/10 px-3 py-1.5 text-sm font-medium text-electric-300 transition hover:border-electric-400/60 hover:bg-electric-500/20 active:scale-[0.98]"
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Tentar novamente
            </button>
          </div>
        </div>
      </GlassPanel>
    );
  }
}

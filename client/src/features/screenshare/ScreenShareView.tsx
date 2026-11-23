import { Info, MonitorUp, Smartphone } from 'lucide-react';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { StatusPill } from '@/components/ui/StatusPill';
import { useDiscord } from '@/discord/useDiscord';

/**
 * Compartilhamento de tela: é um recurso do PRÓPRIO Discord, na chamada de voz.
 *
 * O Embedded App SDK não oferece comando para iniciar, capturar ou exibir a tela de alguém
 * dentro de uma Activity, e o All-in-One não usa nenhum mecanismo externo para isso. Este
 * painel só explica onde fica o recurso nativo, de acordo com o dispositivo informado pelo
 * Discord; a Activity nunca acessa a tela, a câmera ou o microfone.
 */
export function ScreenShareView() {
  const { state } = useDiscord();
  const platform = state.status === 'ready' ? state.session.context.platform : null;

  return (
    <GlassPanel
      as="section"
      aria-labelledby="screenshare-heading"
      className="flex flex-col p-5 motion-safe:animate-fade-up sm:p-6"
      style={{ animationDelay: '90ms' }}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="screenshare-heading" className="flex items-center gap-2 font-display text-sm font-semibold tracking-wide text-white uppercase">
          <MonitorUp className="size-4 text-neon-400" aria-hidden="true" />
          Compartilhar tela
        </h2>
        <StatusPill tone="neutral">Pelo Discord</StatusPill>
      </div>

      <p className="text-sm leading-relaxed text-graphite-300">
        O compartilhamento de tela é feito pelo próprio Discord, na chamada de voz em que a Activity está aberta. A
        Activity continua aberta enquanto você transmite.
      </p>

      <ul className="mt-4 space-y-3 text-sm leading-relaxed text-graphite-300">
        {platform !== 'mobile' && (
          <li className="flex gap-3">
            <MonitorUp className="mt-0.5 size-4 shrink-0 text-graphite-400" aria-hidden="true" />
            <span>
              <strong className="font-medium text-white">Computador:</strong> nos controles da chamada de voz, use o botão de
              compartilhar tela e escolha a janela ou a tela.
            </span>
          </li>
        )}
        {platform !== 'desktop' && (
          <li className="flex gap-3">
            <Smartphone className="mt-0.5 size-4 shrink-0 text-graphite-400" aria-hidden="true" />
            <span>
              <strong className="font-medium text-white">Celular:</strong> abra os controles da chamada de voz no app do
              Discord e toque em compartilhar tela. A disponibilidade depende do aparelho e do app.
            </span>
          </li>
        )}
      </ul>

      <p className="mt-4 flex gap-2 text-[11px] leading-relaxed text-graphite-400">
        <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />O All-in-One não captura nem recebe a sua tela: quem
        vê a transmissão é decidido pelo Discord, para os participantes da chamada.
      </p>
    </GlassPanel>
  );
}

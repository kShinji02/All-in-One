import { memo, useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { linkify } from '@/features/chat/lib/linkify';

interface MessageTextProps {
  text: string;
  /**
   * Dentro do Discord: abre o link pelo SDK. Quando presente, o link NÃO tem href:
   * nenhum gesto (clique do meio, Ctrl/Cmd+clique, menu de contexto, arrastar)
   * consegue navegar nativamente e pular a confirmação do Discord.
   * Fora do Discord (ausente): link comum, em nova aba.
   */
  onOpenLink?: (href: string) => void;
}

const linkClass =
  'cursor-pointer rounded-sm text-electric-300 underline decoration-electric-400/40 underline-offset-2 transition-colors hover:text-electric-400 hover:decoration-electric-400';

/** Texto da mensagem: só texto e links http(s); quebras de linha preservadas pelo CSS. */
export const MessageText = memo(function MessageText({ text, onOpenLink }: MessageTextProps) {
  const segments = useMemo(() => linkify(text), [text]);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'text') return segment.text;
        if (!onOpenLink) {
          return (
            <a key={index} href={segment.href} target="_blank" rel="noopener noreferrer nofollow" className={linkClass}>
              {segment.text}
            </a>
          );
        }
        const open = (event: MouseEvent | KeyboardEvent) => {
          event.preventDefault();
          onOpenLink(segment.href);
        };
        return (
          <a
            key={index}
            role="link"
            tabIndex={0}
            title={segment.href}
            data-external-href={segment.href}
            className={linkClass}
            onClick={open}
            // Botão do meio: o comportamento nativo começa já no mousedown (no Chromium/Electron
            // do Windows, inicia a rolagem automática; no Linux, colar a seleção). Cancelar
            // aqui impede que o navegador assuma; a abertura acontece uma única vez, no auxclick.
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            // Clique do meio dispara "auxclick", não "click".
            onAuxClick={(event) => {
              if (event.button === 1) open(event);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') open(event);
            }}
          >
            {segment.text}
          </a>
        );
      })}
    </>
  );
});

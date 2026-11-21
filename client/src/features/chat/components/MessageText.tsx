import { memo, useMemo, type MouseEvent } from 'react';
import { linkify } from '@/features/chat/lib/linkify';

interface MessageTextProps {
  text: string;
  /** Abre links externos (no Discord, pelo SDK, que mostra a confirmação de saída). */
  onOpenLink?: (href: string) => void;
}

/** Texto da mensagem: só texto e links http(s); quebras de linha preservadas pelo CSS. */
export const MessageText = memo(function MessageText({ text, onOpenLink }: MessageTextProps) {
  const segments = useMemo(() => linkify(text), [text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          segment.text
        ) : (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="rounded-sm text-electric-300 underline decoration-electric-400/40 underline-offset-2 transition-colors hover:text-electric-400 hover:decoration-electric-400"
            onClick={
              onOpenLink
                ? (event: MouseEvent<HTMLAnchorElement>) => {
                    event.preventDefault();
                    onOpenLink(segment.href);
                  }
                : undefined
            }
          >
            {segment.text}
          </a>
        ),
      )}
    </>
  );
});

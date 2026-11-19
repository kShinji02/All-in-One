import { useState } from 'react';
import { cn } from '@/lib/cn';

interface AvatarProps {
  src: string | null;
  label: string;
  className?: string;
  shape?: 'circle' | 'rounded';
}

/** Imagem com fallback para a inicial do nome caso a URL falhe ou não exista. */
export function Avatar({ src, label, className, shape = 'circle' }: AvatarProps) {
  // Guarda qual URL falhou: se a URL mudar (ex.: o usuário trocou o avatar), a nova é tentada.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = src !== null && failedSrc === src;
  const radius = shape === 'circle' ? 'rounded-full' : 'rounded-xl';

  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'grid shrink-0 place-items-center bg-gradient-to-br from-neon-600/60 to-electric-600/60 font-display font-semibold text-white',
          radius,
          className,
        )}
      >
        {label.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      onError={() => setFailedSrc(src)}
      className={cn('shrink-0 object-cover ring-1 ring-white/10', radius, className)}
    />
  );
}

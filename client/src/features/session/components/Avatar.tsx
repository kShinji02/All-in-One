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
  const [failed, setFailed] = useState(false);
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
      onError={() => setFailed(true)}
      className={cn('shrink-0 object-cover ring-1 ring-white/10', radius, className)}
    />
  );
}

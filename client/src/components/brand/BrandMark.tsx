import { useId } from 'react';
import { cn } from '@/lib/cn';

interface BrandMarkProps {
  className?: string;
}

/** Símbolo da marca All-in-One: hexágono com núcleo em gradiente neon/elétrico. */
export function BrandMark({ className }: BrandMarkProps) {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={cn('size-9', className)}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-neon-400)" />
          <stop offset="1" stopColor="var(--color-electric-500)" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="var(--color-graphite-800)" />
      <path
        d="M32 12 50 22v20L32 52 14 42V22Z"
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="32" r="6" fill={`url(#${gradientId})`} />
    </svg>
  );
}

import type { ComponentPropsWithoutRef, ElementType, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type GlassPanelProps<T extends ElementType> = {
  as?: T;
  glow?: 'none' | 'neon' | 'electric';
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'children'>;

const glowClass = {
  none: '',
  neon: 'hover:shadow-neon',
  electric: 'hover:shadow-electric',
} as const;

/** Superfície translúcida (glassmorphism moderado) usada como base dos painéis. */
export function GlassPanel<T extends ElementType = 'div'>({
  as,
  glow = 'none',
  className,
  children,
  ...rest
}: GlassPanelProps<T>) {
  const Component: ElementType = as ?? 'div';
  return (
    <Component
      className={cn(
        'relative rounded-2xl border border-white/[0.07] bg-graphite-900/55 backdrop-blur-xl',
        'shadow-[inset_0_1px_0_0_rgb(255_255_255/0.04)] transition-shadow duration-300',
        glowClass[glow],
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  );
}

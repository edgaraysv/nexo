import type { ReactNode } from 'react';

interface BadgeProps {
  variant: 'ok' | 'warn' | 'danger' | 'info' | 'neu';
  children: ReactNode;
}

export default function Badge({ variant, children }: BadgeProps) {
  return <span className={`nx-badge nx-badge--${variant}`}>{children}</span>;
}

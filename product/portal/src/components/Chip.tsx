import type { ReactNode } from 'react';

interface ChipProps {
  variant: 'ok' | 'warn' | 'miss' | 'part' | 'neu';
  children: ReactNode;
}

export default function Chip({ variant, children }: ChipProps) {
  return <span className={`nx-chip nx-chip--${variant}`}>{children}</span>;
}

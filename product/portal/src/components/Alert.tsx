import type { ReactNode } from 'react';

interface AlertProps {
  variant: 'ok' | 'warn' | 'info';
  children: ReactNode;
}

export default function Alert({ variant, children }: AlertProps) {
  return <div className={`nx-alert nx-alert--${variant}`} role={variant === 'warn' ? 'alert' : 'status'}>{children}</div>;
}

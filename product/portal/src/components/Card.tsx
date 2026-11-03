import type { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  heading?: string;
  className?: string;
}

export default function Card({ children, heading, className = '' }: CardProps) {
  const classes = ['nx-card', className].filter(Boolean).join(' ');
  return (
    <section className={classes}>
      {heading && <h2>{heading}</h2>}
      {children}
    </section>
  );
}

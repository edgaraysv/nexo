import type { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'default' | 'sm';
}

export default function Button({ variant = 'primary', size = 'default', className = '', ...props }: ButtonProps) {
  const classes = ['nx-btn', variant !== 'primary' ? `nx-btn--${variant}` : '', size === 'sm' ? 'nx-btn--sm' : '', className]
    .filter(Boolean)
    .join(' ');
  return <button className={classes} {...props} />;
}

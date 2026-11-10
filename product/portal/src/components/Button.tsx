import { forwardRef, type ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'default' | 'sm';
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'default', className = '', ...props },
  ref,
) {
  const classes = ['nx-btn', variant !== 'primary' ? `nx-btn--${variant}` : '', size === 'sm' ? 'nx-btn--sm' : '', className]
    .filter(Boolean)
    .join(' ');
  return <button ref={ref} className={classes} {...props} />;
});

export default Button;

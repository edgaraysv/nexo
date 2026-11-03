import { useId, type InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

export default function Input({
  label,
  error,
  id,
  className = '',
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  ...props
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const describedBy = [ariaDescribedBy, error ? errorId : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <label className="nx-field" htmlFor={inputId}>
      <span>{label}</span>
      <input
        id={inputId}
        className={['nx-input', className].filter(Boolean).join(' ')}
        aria-invalid={error ? true : ariaInvalid}
        aria-describedby={describedBy}
        {...props}
      />
      {error && <span className="nx-input-error" id={errorId}>{error}</span>}
    </label>
  );
}

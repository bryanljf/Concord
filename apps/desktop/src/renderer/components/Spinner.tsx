interface SpinnerProps {
  size?: 'sm' | 'md';
  label?: string;
}

export function Spinner({ size = 'md', label = 'Carregando' }: SpinnerProps) {
  return (
    <span
      className={size === 'sm' ? 'spinner spinner--sm' : 'spinner'}
      role="img"
      aria-label={label}
    />
  );
}

import { cn } from './utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };

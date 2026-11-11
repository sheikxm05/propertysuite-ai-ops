import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from './utils';

export interface EmptyStateProps {
  readonly icon?: LucideIcon;
  readonly title: string;
  readonly description?: React.ReactNode;
  /** The action that resolves the emptiness, when there is one. */
  readonly action?: React.ReactNode;
  readonly className?: string;
}

/**
 * "There is nothing here" — said once, the same way, everywhere.
 *
 * An empty list is the most common state in a freshly seeded demo and the easiest one to
 * leave as a bare sentence in grey text. It is also where a reviewer decides whether the
 * product was designed: the difference between a blank panel and a framed explanation
 * with the action that fixes it is the difference between a scaffold and a product.
 *
 * Note what this is NOT: an error. Empty means the query succeeded and the answer was
 * zero rows — which for a tenant looking at another tenant's data is also what a correct
 * authorization boundary looks like from the inside.
 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center',
        className,
      )}
    >
      {Icon ? (
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-pretty text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

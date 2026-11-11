import * as React from 'react';

import { cn } from '@/components/ui/utils';

export interface PageHeaderProps {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  /** Primary and secondary actions. Right-aligned on `sm` and up, stacked below it. */
  readonly actions?: React.ReactNode;
  /** A short label above the title — a section name or a parent record. */
  readonly eyebrow?: React.ReactNode;
  readonly className?: string;
}

/**
 * The page title block.
 *
 * Every route needs the same three things — what this page is, one sentence about it,
 * and the actions it offers — and before this existed each feature page hand-rolled its
 * own `<h1>`. They had already drifted: different sizes, different gaps, some with a
 * description and some without, actions sometimes above the title and sometimes beside
 * it. That drift is invisible on one page and obvious when you click between five.
 *
 * It is a plain server component: no state, no client bundle. `actions` is a slot, so a
 * page can pass a client component (a dialog trigger, a form) without this file knowing
 * anything about it.
 *
 * Exactly one `<h1>` per page is the accessibility contract — pass the page's title
 * here and do not write another heading at that level further down.
 */
export function PageHeader({ title, description, actions, eyebrow, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow ? (
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-balance text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-pretty text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>

      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
      ) : null}
    </div>
  );
}

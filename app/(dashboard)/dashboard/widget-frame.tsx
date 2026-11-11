'use client';

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/components/ui/utils';
import type { WidgetChrome } from '@/config/types';

/**
 * One tile's loading, error and chrome behaviour, so that no widget has to implement
 * three states correctly to be safe to put on a dashboard.
 *
 * WHY AN ERROR BOUNDARY PER TILE
 * ------------------------------
 * The dashboard renders up to six independent widgets, each resolving its own membership
 * and running its own query. Without a boundary, one failing query takes the whole
 * dashboard to the route-level `error.tsx` — the manager loses the five tiles that
 * worked because the sixth timed out. A boundary per tile degrades to five tiles and one
 * apology, which is the behaviour the exit gate asks for.
 *
 * It is a class component because React still offers no hook equivalent for
 * `componentDidCatch`. It is a client component because error boundaries only exist on
 * the client — but its `children` are server components passed through as a prop, so
 * nothing about the widgets themselves is pulled into the browser bundle.
 *
 * The fallback deliberately says nothing about the failure. A dashboard tile is the
 * wrong place to explain a server error, and the frozen error envelope's message is
 * already generic by design (CLAUDE.md rule 8: never log or surface internals).
 */

interface BoundaryProps {
  readonly title: string;
  readonly children: React.ReactNode;
}

interface BoundaryState {
  readonly failed: boolean;
}

class WidgetErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="status"
        className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <span className="text-muted-foreground">
          <span className="font-medium text-foreground">{this.props.title}</span> could not be
          loaded. The rest of this dashboard is unaffected — reload to try again.
        </span>
      </div>
    );
  }
}

/** Three lines of shimmer: enough to hold the tile's height without guessing its shape. */
function WidgetSkeleton() {
  return (
    <div className="space-y-2.5" aria-busy="true" aria-live="polite">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}

export interface WidgetFrameProps {
  readonly title: string;
  readonly description?: string;
  readonly chrome: WidgetChrome;
  readonly children: React.ReactNode;
}

export function WidgetFrame({ title, description, chrome, children }: WidgetFrameProps) {
  const guarded = (
    <WidgetErrorBoundary title={title}>
      <React.Suspense fallback={<WidgetSkeleton />}>{children}</React.Suspense>
    </WidgetErrorBoundary>
  );

  // The widget already draws its own container; wrapping it again would double the
  // border and the padding. See `widgetChrome()` in config/dashboard.slots.ts.
  if (chrome === 'none') {
    return <div className="h-full [&>*]:h-full">{guarded}</div>;
  }

  return (
    <Card className={cn('h-full', 'transition-shadow hover:shadow-md')} data-theme-surface>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{guarded}</CardContent>
    </Card>
  );
}

'use client';

/**
 * What the agent actually did, shown as steps rather than hidden as machinery.
 *
 * WHY THE TRACE IS PRODUCT SURFACE AND NOT A DEBUG PANEL
 * ------------------------------------------------------
 * "There is an active tenancy on unit 1204 and three prior air-conditioning tickets" is
 * a claim. "It called `lookup_unit`, then `lookup_tenancy`, then `recent_tickets`, and
 * here is the order and the time each took" is evidence that the claim came from this
 * organization's records rather than from the model's imagination. Checkability is the
 * reason a human is in this loop at all, so the trace is styled like the rest of the app
 * and sits in the transcript, not behind a flag.
 *
 * THE LINE IT DRAWS
 * -----------------
 * Each step carries the server's own classification, `read` or `propose`, and that is
 * the whole security model rendered as a list. A `read` step ran. A `propose` step did
 * **not** run — it stopped and became the card below. Seeing the two kinds interleaved
 * in one timeline, with different words against them, is more convincing than any
 * sentence about it.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * Tool *results*. `AgentStepSchema` is metadata only — "never a tool result" — because a
 * result can contain a resident's words and the route will not ship them to a browser
 * that did not ask for that record by name. The findings reach the reader through the
 * assistant's summary instead. This component says so out loud rather than leaving the
 * absence to look like an oversight.
 */

import { AlertTriangle, Eye, ShieldAlert, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/components/ui/utils';

import { describeStep } from '../describe';
import { STEP_OUTCOME_TEXT, isFailure, isRefusal, type AgentStep } from '../wire';

export interface ToolTraceProps {
  readonly steps: readonly AgentStep[];
}

export function ToolTrace({ steps }: ToolTraceProps) {
  if (steps.length === 0) return null;

  const reads = steps.filter((step) => step.kind === 'read').length;
  const proposed = steps.filter((step) => step.kind === 'propose').length;

  return (
    <section
      aria-label="Steps the assistant took"
      className="rounded-lg border bg-muted/20 p-3 sm:p-4"
    >
      <header className="flex flex-wrap items-center gap-2 pb-3">
        <Eye className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium">What the assistant did</h3>
        {reads > 0 ? (
          <Badge variant="secondary">
            {reads} read-only {reads === 1 ? 'lookup' : 'lookups'}
          </Badge>
        ) : null}
        {proposed > 0 ? (
          <Badge variant="warning">
            {proposed} {proposed === 1 ? 'action proposed' : 'actions proposed'}, none run
          </Badge>
        ) : null}
      </header>

      <ol className="space-y-2">
        {steps.map((step, index) => (
          <TraceStep key={`${step.round}-${step.tool}-${index}`} step={step} index={index + 1} />
        ))}
      </ol>

      <p className="pt-3 text-xs text-muted-foreground">
        Lookups ran under your own session, inside your organization, with the same row-level
        security as every other screen — the assistant can read exactly what you could read by hand,
        and nothing more. What they returned is not sent to this page; the summary above is how
        their findings reach you.
      </p>
    </section>
  );
}

function TraceStep({ step, index }: { step: AgentStep; index: number }) {
  const refused = isRefusal(step.outcome);
  const failed = isFailure(step.outcome);
  const proposal = step.kind === 'propose';

  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
          refused || failed
            ? 'border-destructive/50 text-destructive'
            : proposal
              ? 'border-warning/60 text-warning-foreground'
              : 'bg-background text-muted-foreground',
        )}
      >
        {index}
      </span>

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{describeStep(step)}</span>

        <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {step.tool}
        </code>

        <Badge
          variant={
            refused || failed
              ? 'destructive'
              : proposal
                ? 'warning'
                : step.kind === 'unknown'
                  ? 'outline'
                  : 'secondary'
          }
          className="gap-1 font-normal"
        >
          {refused ? (
            <ShieldAlert className="size-3" aria-hidden="true" />
          ) : failed ? (
            <AlertTriangle className="size-3" aria-hidden="true" />
          ) : proposal ? (
            <Sparkles className="size-3" aria-hidden="true" />
          ) : null}
          {STEP_OUTCOME_TEXT[step.outcome]}
        </Badge>

        <span className="text-xs text-muted-foreground">
          round {step.round} · {step.duration_ms} ms
        </span>
      </div>
    </li>
  );
}

/**
 * The activity timeline — read-only, by design and not merely by omission.
 *
 * `maintenance_activities` rejects UPDATE, DELETE and TRUNCATE for every caller,
 * including the table owner (`0003`'s `block_activity_mutation`, verified live as
 * `postgres`). There is therefore no edit affordance anywhere in this component and no
 * route behind one: a mistaken entry is corrected by appending a contradicting row, so
 * the timeline is evidence rather than a draft.
 *
 * Exactly one entry per transition. The transition rows are the ones whose metadata
 * carries `from_status`/`to_status`, which is the same predicate
 * `isTransitionActivity()` uses on the write side and the same one the lane's tests
 * assert with — so "one row per transition" means the same thing in the planner, in the
 * tests and on screen.
 *
 * `metadata` is rendered selectively. It is a `jsonb` column that an append-only table
 * will carry forever, and although the write side only ever puts identifiers, statuses
 * and policy reason codes in it, a reader must not assume that: only the keys named
 * below are displayed, so an unexpected key can never be printed to a provider's screen.
 */

import { ArrowRight, CircleDot } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { Activity, TicketStatus } from '@shared/index';

import { statusLabel } from './badges';

/** Metadata keys this component is willing to render, in display order. */
const SHOWN_METADATA_KEYS = ['priority', 'priority_reasons', 'evidence_count', 'source'] as const;

export function ActivityTimeline({ activities }: { activities: readonly Activity[] }) {
  if (activities.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity recorded yet.</p>;
  }

  return (
    <ol className="space-y-4">
      {activities.map((activity) => (
        <li key={activity.id} className="flex gap-3">
          <div className="mt-1 text-muted-foreground" aria-hidden="true">
            <CircleDot className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <TransitionArrow activity={activity} />
              <time className="text-xs text-muted-foreground" dateTime={activity.created_at}>
                {formatInstant(activity.created_at)}
              </time>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{activity.description}</p>
            <MetadataLine activity={activity} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Renders `from -> to` when the row records an edge, and the activity type otherwise.
 *
 * The presence of both status keys is what makes a row a transition row, so this
 * component and the one-row-per-transition invariant agree on the definition.
 */
function TransitionArrow({ activity }: { activity: Activity }) {
  const from = statusFromMetadata(activity, 'from_status');
  const to = statusFromMetadata(activity, 'to_status');

  if (from === null || to === null) {
    return <Badge variant="outline">{activity.activity_type.replace(/_/g, ' ')}</Badge>;
  }

  return (
    <span className="flex items-center gap-1 text-sm font-medium">
      {statusLabel(from)}
      <ArrowRight className="h-3 w-3" aria-hidden="true" />
      {statusLabel(to)}
    </span>
  );
}

function MetadataLine({ activity }: { activity: Activity }) {
  const parts: string[] = [];
  for (const key of SHOWN_METADATA_KEYS) {
    const value = activity.metadata[key];
    if (value === undefined || value === null) continue;
    parts.push(
      `${key.replace(/_/g, ' ')}: ${Array.isArray(value) ? value.join(', ') : String(value)}`,
    );
  }
  if (parts.length === 0) return null;
  return <p className="mt-1 text-xs text-muted-foreground">{parts.join(' · ')}</p>;
}

/* ---------------------------------------------------------------- helpers -- */

const STATUS_VALUES = new Set<string>([
  'open',
  'assigned',
  'in_progress',
  'awaiting_approval',
  'completed',
  'cancelled',
]);

/**
 * Reads a status out of `jsonb` metadata, or `null`.
 *
 * The membership test is against a local set rather than `TICKET_STATUSES` because this
 * runs on a value that came out of the database rather than through a schema, and the
 * narrowing has to be a runtime check either way. It is kept in sync by
 * `tests/maintenance/timeline.test.ts`, which asserts the set equals the shared enum.
 */
function statusFromMetadata(activity: Activity, key: string): TicketStatus | null {
  const value = activity.metadata[key];
  return typeof value === 'string' && STATUS_VALUES.has(value) ? (value as TicketStatus) : null;
}

/** Exported so the test above can assert parity with `TICKET_STATUSES`. */
export function renderedStatusValues(): readonly string[] {
  return [...STATUS_VALUES];
}

/**
 * `en-AE` per §5.7, with an explicit `Asia/Dubai` time zone so a server-rendered
 * timestamp reads the same as the operations team's wall clock regardless of where the
 * process runs.
 */
function formatInstant(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('en-AE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dubai',
  }).format(parsed);
}

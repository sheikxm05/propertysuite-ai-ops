'use client';

import * as React from 'react';
import Link from 'next/link';
import { FileClock, ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { DashboardWidget, DashboardWidgetProps } from '@/config/types';

/**
 * Dashboard widget: documents awaiting human verification. Lane w1-l6.
 *
 * It exists to make the gate visible from the first screen a manager sees. A pending
 * extraction is work nobody has done yet, and an unverified value that nobody is looking
 * at is how an unverified value eventually gets treated as a fact.
 *
 * A client component that fetches `/api/v1/documents?verification_status=pending`. Why
 * not a server component reading the database directly, which would be one round trip
 * fewer: `config/dashboard.slots.ts` types `Component` as a plain
 * `ComponentType<DashboardWidgetProps>`, and that registry belongs to lane w0-l1 and is
 * composed by w2-l5. A widget that had to be awaited would not fit the frozen type, and
 * widening it is not this lane's change to make. Going through the API also means the
 * widget sees exactly what the endpoint permits — RLS and the §4 matrix included —
 * rather than becoming a second read path with its own authorization.
 *
 * `roles` is restricted to staff because they are the only roles that can act on a
 * pending document: `documents_update_staff` is the sole UPDATE policy on the table.
 * Showing an owner or a tenant a count they cannot clear would be noise.
 */

const PENDING_ENDPOINT = '/api/v1/documents?verification_status=pending&limit=5';

interface PendingDocument {
  readonly id: string;
  readonly document_type: string;
  readonly created_at: string;
}

type State =
  | { readonly phase: 'loading' }
  | {
      readonly phase: 'ready';
      readonly items: readonly PendingDocument[];
      readonly hasMore: boolean;
    }
  | { readonly phase: 'error' };

function PendingVerificationsWidget(_props: DashboardWidgetProps) {
  const [state, setState] = React.useState<State>({ phase: 'loading' });

  React.useEffect(() => {
    const controller = new AbortController();

    fetch(PENDING_ENDPOINT, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('request failed');
        const payload: unknown = await response.json();
        setState({ phase: 'ready', ...readPage(payload) });
      })
      .catch((thrown: unknown) => {
        // An aborted fetch is a navigation, not a failure.
        if (thrown instanceof Error && thrown.name === 'AbortError') return;
        // No detail is surfaced. A dashboard tile is the wrong place to explain a
        // server error, and the frozen envelope's message is already generic.
        setState({ phase: 'error' });
      });

    return () => controller.abort();
  }, []);

  if (state.phase === 'loading') {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <p className="text-sm text-muted-foreground">
        The pending list could not be loaded. Open{' '}
        <Link href="/documents" className="underline underline-offset-4">
          Documents
        </Link>{' '}
        to check.
      </p>
    );
  }

  if (state.items.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing is waiting for verification.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-sm">
        <ShieldAlert className="size-4 text-warning" aria-hidden />
        <span>
          <Badge variant="warning">{state.items.length}</Badge>{' '}
          {state.items.length === 1 ? 'document needs' : 'documents need'} a human decision
          {state.hasMore ? ' (showing the most recent)' : ''}
        </span>
      </p>
      <ul className="space-y-1 text-sm">
        {state.items.map((item) => (
          <li key={item.id}>
            <Link
              href={`/documents/${item.id}`}
              className="inline-flex items-center gap-2 underline-offset-4 hover:underline"
            >
              <FileClock className="size-3.5 text-muted-foreground" aria-hidden />
              {item.document_type.replace(/_/g, ' ')}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Reads the list envelope defensively.
 *
 * The response shape is frozen by `listResponseSchema` in `packages/shared`, but a
 * dashboard tile that throws on an unexpected payload takes the whole dashboard with it.
 * Unknown input is narrowed field by field and anything unrecognised becomes an empty
 * list.
 */
function readPage(payload: unknown): { items: PendingDocument[]; hasMore: boolean } {
  if (typeof payload !== 'object' || payload === null) return { items: [], hasMore: false };

  const data = (payload as { data?: unknown }).data;
  const pageInfo = (payload as { page_info?: unknown }).page_info;

  const items = Array.isArray(data)
    ? data.flatMap((row): PendingDocument[] => {
        if (typeof row !== 'object' || row === null) return [];
        const id = (row as { id?: unknown }).id;
        const documentType = (row as { document_type?: unknown }).document_type;
        const createdAt = (row as { created_at?: unknown }).created_at;
        if (typeof id !== 'string' || typeof documentType !== 'string') return [];
        return [
          {
            id,
            document_type: documentType,
            created_at: typeof createdAt === 'string' ? createdAt : '',
          },
        ];
      })
    : [];

  const hasMore =
    typeof pageInfo === 'object' &&
    pageInfo !== null &&
    (pageInfo as { has_more?: unknown }).has_more === true;

  return { items, hasMore };
}

export const widget: DashboardWidget = {
  key: 'documents',
  title: 'Pending verification',
  roles: ['organization_admin', 'property_manager'],
  span: 1,
  order: 60,
  enabled: true,
  Component: PendingVerificationsWidget,
};

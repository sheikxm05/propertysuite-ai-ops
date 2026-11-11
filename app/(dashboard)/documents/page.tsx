/**
 * `/documents` — the document list, pending verifications first.
 *
 * A server component. The data is read with the caller's own Supabase client, so Row
 * Level Security applies to the page exactly as it applies to the API: there is no
 * "trusted server render" that sees more than the route would. The list is then run
 * through the same `listDocuments` the API uses, so the page and the endpoint cannot
 * disagree about what a role may see.
 *
 * `resolveMembership` is the only source of the organization. Not a cookie, not a
 * search parameter, not a prop from a client component (CLAUDE.md rule 5).
 *
 * Pending verifications lead the page because they are the only items that need a human.
 * Everything else here is a record; a `pending` row is a queue, and a queue that is not
 * at the top of the screen is a queue nobody works.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FileClock, FileCheck2, FileX2, FileUp, FileSearch, type LucideIcon } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { VERIFICATION_STATUS_STYLE, styleFor } from '@/components/ui/status';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { resolveMembership } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/supabase/server';
import { DEFAULT_PAGE_SIZE } from '@shared/index';
import { listDocuments } from '@/features/documents/server/documents-service';

import { VERIFICATION_LABELS, documentTypeLabel, formatDate } from './labels';

export const dynamic = 'force-dynamic';

export default async function DocumentsPage() {
  const supabase = await createServerClient();
  const session = await getSession(supabase);
  if (!session) redirect('/sign-in');

  const membership = await resolveMembership(session.userId, supabase);
  // Authenticated but not a member of anything is a legitimate state — an invitation
  // not yet accepted. It is not an error, and it is not a document list either.
  if (!membership) redirect('/dashboard');

  const page = await listDocuments(supabase, membership, {
    limit: DEFAULT_PAGE_SIZE,
    cursor: undefined,
    document_type: undefined,
    verification_status: undefined,
    property_id: undefined,
    tenancy_id: undefined,
    ticket_id: undefined,
  });

  const pending = page.items.filter((d) => d.verification_status === 'pending');
  const decided = page.items.filter((d) => d.verification_status !== 'pending');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        description="Extracted values are proposals until someone reviews them against the document. Nothing here is treated as legal or financial truth before that."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileClock className="size-4" aria-hidden />
            Awaiting verification
            <Badge variant={pending.length > 0 ? 'warning' : 'secondary'}>{pending.length}</Badge>
          </CardTitle>
          <CardDescription>
            Each of these has proposed values that no human has accepted yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <EmptyState
              icon={FileCheck2}
              title="Nothing is waiting for review"
              description="Every document that has been through extraction has had its values accepted or rejected by a person."
            />
          ) : (
            <DocumentTable rows={pending} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reviewed</CardTitle>
          <CardDescription>
            Verified or rejected by a named person, with the values they accepted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {decided.length === 0 ? (
            <EmptyState
              icon={FileSearch}
              title="No documents have been reviewed yet"
              description="Open a document from the queue above, check the proposed values against the page, and accept or reject them."
            />
          ) : (
            <DocumentTable rows={decided} />
          )}
        </CardContent>
      </Card>

      {page.hasMore ? (
        <p className="text-xs text-muted-foreground">
          Showing the {page.limit} most recent documents.
        </p>
      ) : null}
    </div>
  );
}

interface Row {
  id: string;
  document_type: string;
  verification_status: string;
  created_at: string;
  ticket_id: string | null;
}

function DocumentTable({ rows }: { rows: readonly Row[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Type</TableHead>
          {/* The timestamp is the least useful column on a phone: it is the first to
              fold away, and the row stays complete without it. */}
          <TableHead numeric className="hidden sm:table-cell">
            Uploaded
          </TableHead>
          <TableHead>Status</TableHead>
          <TableHead numeric>Review</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">
              {documentTypeLabel(row.document_type)}
              {row.ticket_id ? (
                <span className="ml-2 text-xs text-muted-foreground">ticket evidence</span>
              ) : null}
            </TableCell>
            <TableCell numeric className="hidden text-muted-foreground sm:table-cell">
              {formatDate(row.created_at)}
            </TableCell>
            <TableCell>
              <StatusBadge status={row.verification_status} />
            </TableCell>
            <TableCell numeric>
              <Link
                href={`/documents/${row.id}`}
                className="text-sm font-medium underline underline-offset-4"
              >
                {row.verification_status === 'pending' ? 'Review' : 'View'}
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const STATUS_ICON: Record<string, LucideIcon> = {
  verified: FileCheck2,
  rejected: FileX2,
  pending: FileUp,
};

/**
 * The colour comes from `VERIFICATION_STATUS_STYLE`, not from a branch here — amber on a
 * pending document has to mean exactly what amber means on a ticket awaiting approval,
 * because they are the same claim: the model proposed it and no person has committed.
 *
 * The label stays local: `VERIFICATION_LABELS` says "Verified by a person" rather than
 * "Verified", which is the sentence this screen exists to make.
 */
function StatusBadge({ status }: { status: string }) {
  const style = styleFor(VERIFICATION_STATUS_STYLE, status);
  const Icon = STATUS_ICON[status];
  return (
    <Badge variant={style.variant} className="gap-1 whitespace-nowrap">
      {Icon ? <Icon className="size-3" aria-hidden /> : null}
      {VERIFICATION_LABELS[status] ?? style.label}
    </Badge>
  );
}

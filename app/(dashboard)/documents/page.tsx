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
import { FileClock, FileCheck2, FileX2, FileUp } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Extracted values are proposals until someone reviews them against the document. Nothing
          here is treated as legal or financial truth before that.
        </p>
      </header>

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
            <p className="text-sm text-muted-foreground">Nothing is waiting for review.</p>
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
            <p className="text-sm text-muted-foreground">No documents have been reviewed yet.</p>
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
          <TableHead>Uploaded</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Review</TableHead>
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
            <TableCell className="text-muted-foreground">{formatDate(row.created_at)}</TableCell>
            <TableCell>
              <StatusBadge status={row.verification_status} />
            </TableCell>
            <TableCell className="text-right">
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

function StatusBadge({ status }: { status: string }) {
  const label = VERIFICATION_LABELS[status] ?? status;
  if (status === 'verified') {
    return (
      <Badge variant="success" className="gap-1">
        <FileCheck2 className="size-3" aria-hidden />
        {label}
      </Badge>
    );
  }
  if (status === 'rejected') {
    return (
      <Badge variant="destructive" className="gap-1">
        <FileX2 className="size-3" aria-hidden />
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="warning" className="gap-1">
      <FileUp className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}

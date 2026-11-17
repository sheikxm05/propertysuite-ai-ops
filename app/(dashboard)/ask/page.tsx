/**
 * `/ask` — ask a question about your documents and get an answer with its sources.
 *
 * A server component that renders a shell and one client island. The data it fetches is
 * only the scope picker's option list, read with the caller's own Supabase client, so
 * Row Level Security applies to the page exactly as it applies to the API: a tenant's
 * picker lists their tenancy's documents, a provider's lists the completion evidence on
 * tickets assigned to them, and nobody's lists another organization's anything. There is
 * no "trusted server render" that sees more than the route would.
 *
 * `resolveMembership` is the only source of the organization — not a cookie, not a
 * search parameter, not a prop (CLAUDE.md rule 5). The picker is a convenience and never
 * an authorization boundary: `POST /api/v1/rag/ask` re-derives the organization from the
 * session and applies the same visibility predicate whatever `document_id` arrives.
 *
 * The empty state is the one worth getting right. A fresh organization has no processed
 * documents, and a question box over an empty index returns "I could not find that" for
 * every question — which reads as a broken feature rather than an empty one. So when
 * there is nothing to search, the page says so and points at the upload screen instead
 * of inviting a question it cannot answer.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FileUp, Sparkles } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { resolveMembership } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/supabase/server';

import { documentTypeLabel, formatDate } from '../documents/labels';
import { AskConsole, type DocumentOption } from './ask-console';

export const dynamic = 'force-dynamic';

/** How many documents the scope picker offers. A picker is not a document list. */
const SCOPE_PICKER_LIMIT = 50;

export default async function AskPage() {
  const supabase = await createServerClient();
  const session = await getSession(supabase);
  if (!session) redirect('/sign-in');

  const membership = await resolveMembership(session.userId, supabase);
  // Authenticated with no membership is a legitimate state — an invitation not yet
  // accepted. It is not an error, and it is not a question box either.
  if (!membership) redirect('/dashboard');

  // Only the three columns the picker renders. Over-selecting here would put document
  // metadata into a client component for no reason; `extracted_data` in particular is
  // an unverified model proposal and has no business on this screen.
  const { data: rows } = await supabase
    .from('documents')
    .select('id, document_type, created_at')
    .order('created_at', { ascending: false })
    .limit(SCOPE_PICKER_LIMIT);

  const documents: DocumentOption[] = (rows ?? []).map((row) => ({
    id: row.id,
    label: documentTypeLabel(row.document_type),
    uploadedOn: formatDate(row.created_at),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ask your documents"
        description="Answers are drawn from the documents your role can already open, and every answer shows the extracts it came from. If nothing in your documents supports an answer, it says so instead of guessing."
      />

      {documents.length === 0 ? (
        <EmptyState
          icon={FileUp}
          title="There is nothing to search yet"
          description="Questions are answered from uploaded documents that have been processed. Once a tenancy contract or an invoice has been through extraction, it becomes searchable here."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/documents">
                <Sparkles aria-hidden="true" />
                Go to documents
              </Link>
            </Button>
          }
        />
      ) : (
        <AskConsole documents={documents} />
      )}
    </div>
  );
}

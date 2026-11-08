/**
 * `/documents/{documentId}` — the verification screen.
 *
 * A server component that reads with the caller's own client, so RLS decides visibility
 * exactly as it does on the API, and then applies `assertDocumentReadable` — the same
 * gate the `GET` route uses, including amendment A7's provider clause. A page that
 * rendered from a privileged read would be a second, untested authorization path.
 *
 * The screen's job is to make the gate honest. Three things are therefore always
 * visible, even when they are inconvenient:
 *
 *   * The state, in words. "Awaiting review" is not a colour; a reviewer should not have
 *     to know that amber means unverified.
 *   * Who decided, and when, once somebody has. An audit trail nobody can see on screen
 *     is an audit trail nobody checks.
 *   * Every confidence note the extraction produced, including "field extraction was
 *     unavailable". A proposal that is absent because the model never ran looks
 *     identical, on a careless screen, to a document that genuinely states nothing.
 *
 * Staff see the form. Everybody else with read access sees the values and the decision,
 * because `documents_update_staff` is the only UPDATE policy on the table — rendering a
 * form for a tenant or an owner would be offering them a button that returns 403.
 */

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileCheck2, FileClock, FileX2, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { resolveMembership } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/supabase/server';
import { DocumentPathParamsSchema } from '@shared/index';
import { assertDocumentReadable } from '@/features/documents/server/access';
import { findDocument } from '@/features/documents/server/documents-service';
import { DOCUMENT_STAFF_ROLES } from '@/features/documents/server/authorization';
import { readEnvelope, proposedFieldsFor, verifiedFieldsFor } from '@/services/extraction';

import {
  FIELD_LABELS,
  VERIFICATION_LABELS,
  displayValue,
  documentTypeLabel,
  formatDate,
} from '../labels';
import {
  VERIFIABLE_FIELDS,
  VerifyForm,
  type ProposedField,
  type VerifiableField,
} from './verify-form';

export const dynamic = 'force-dynamic';

export default async function DocumentDetailPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const resolved = DocumentPathParamsSchema.safeParse(await params);
  // A malformed id is a 404, not a validation error page: there is no document with
  // that id and saying anything more precise describes the id space.
  if (!resolved.success) notFound();

  const supabase = await createServerClient();
  const session = await getSession(supabase);
  if (!session) redirect('/sign-in');

  const membership = await resolveMembership(session.userId, supabase);
  if (!membership) redirect('/dashboard');

  const document = await findDocument(supabase, resolved.data.documentId);
  // Hidden by RLS and genuinely absent are the same page. A "you are not allowed to see
  // this" screen would confirm that another organization's document id is real.
  if (!document) notFound();

  await assertDocumentReadable(supabase, membership, document);

  const envelope = readEnvelope(document.extracted_data);
  const proposedFields = proposedFieldsFor(envelope);
  const verifiedFields = verifiedFieldsFor(envelope);
  const verification = envelope?.verification ?? null;

  const isStaff = (DOCUMENT_STAFF_ROLES as readonly string[]).includes(membership.role);
  const isPending = document.verification_status === 'pending';

  const proposed = VERIFIABLE_FIELDS.reduce(
    (accumulator, field) => {
      const excerpt = envelope?.excerpts[field] ?? null;
      accumulator[field] = {
        value: proposedFields?.[field] ?? null,
        excerpt: excerpt?.excerpt ?? null,
        found: excerpt?.found ?? false,
        line: excerpt?.line ?? null,
      };
      return accumulator;
    },
    {} as Record<VerifiableField, ProposedField>,
  );

  return (
    <div className="space-y-6">
      <Link
        href="/documents"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />
        All documents
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {documentTypeLabel(document.document_type)}
          </h1>
          <StateBadge status={document.verification_status} />
        </div>
        <p className="text-sm text-muted-foreground">
          Uploaded {formatDate(document.created_at)}
          {document.ticket_id ? ' · attached to a maintenance ticket' : ''}
        </p>
      </header>

      {isPending ? (
        <Alert variant="warning">
          <ShieldAlert className="size-4" aria-hidden />
          <AlertTitle>Nothing on this page is verified</AlertTitle>
          <AlertDescription>
            The values below were proposed by automatic extraction. They are not legal or financial
            truth and no record uses them until a person confirms each one.
          </AlertDescription>
        </Alert>
      ) : null}

      {envelope && envelope.notes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Extraction notes</CardTitle>
            <CardDescription>What the extraction was unsure about.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {envelope.notes.map((note, index) => (
                <li key={`${index}-${note.slice(0, 16)}`}>{note}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {verification ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {verification.status === 'verified' ? 'Verified values' : 'Rejected'}
            </CardTitle>
            <CardDescription>
              Decided {formatDate(verification.verified_at)} by profile {verification.verified_by}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {verification.status === 'rejected' ? (
              <p className="text-sm">
                Reason: <span className="text-muted-foreground">{verification.reason}</span>
              </p>
            ) : (
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {VERIFIABLE_FIELDS.map((field) => (
                  <div key={field} className="flex flex-col">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                      {FIELD_LABELS[field]}
                    </dt>
                    <dd className="text-sm">{displayValue(verifiedFields?.[field] ?? null)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {verification.note ? (
              <>
                <Separator />
                <p className="text-sm text-muted-foreground">{verification.note}</p>
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {isPending && isStaff ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Review and confirm</CardTitle>
            <CardDescription>
              Compare each proposed value against the document, edit anything that is wrong, and
              confirm. Only what you submit is stored.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <VerifyForm
              documentId={document.id}
              proposed={proposed}
              hasProposal={proposedFields !== null}
            />
          </CardContent>
        </Card>
      ) : null}

      {isPending && !isStaff ? (
        <Alert>
          <FileClock className="size-4" aria-hidden />
          <AlertTitle>Waiting for a manager</AlertTitle>
          <AlertDescription>
            Only an organization administrator or a property manager can confirm extracted values.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function StateBadge({ status }: { status: string }) {
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
      <FileClock className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}

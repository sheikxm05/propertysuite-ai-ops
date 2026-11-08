'use client';

/**
 * The verification form — proposed versus accepted, side by side.
 *
 * The layout is the argument. Each row shows three things at once: what the model
 * proposed, the line of the document it came from, and the value the reviewer is about
 * to accept. A reviewer can therefore disagree with the model by editing one field
 * rather than by rejecting the whole document, and a proposal the model could not
 * locate in the document is flagged as such beside it.
 *
 * Two deliberate choices about defaults:
 *
 *  1. The accepted fields are pre-filled with the proposal. The alternative — blank
 *     inputs — sounds safer but is not: it turns a review into retyping, and retyping is
 *     what people stop doing on the twentieth document. Pre-filling plus a visible
 *     source excerpt keeps the reviewer reading.
 *  2. A field the model could not find is pre-filled too, but carries a "not found in
 *     the document" warning. Clearing it would hide the model's claim, and the claim is
 *     the thing worth reviewing.
 *
 * Nothing here is authorization and nothing here is validation. The submit button is a
 * convenience; `POST /api/v1/documents/{id}/verify` re-authorizes the caller,
 * re-validates every field against `VerifyDocumentSchema`, requires `confirmed: true`
 * and compare-and-swaps on `pending`. A reviewer who crafts their own request gets
 * exactly the same checks.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, X } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';

import { FIELD_LABELS } from '../labels';

export const VERIFIABLE_FIELDS = [
  'tenant_name',
  'contract_number',
  'property_address',
  'start_date',
  'end_date',
  'rent_amount',
  'currency',
] as const;

export type VerifiableField = (typeof VERIFIABLE_FIELDS)[number];

export interface ProposedField {
  readonly value: string | null;
  /** The document line the value came from, or `null` when it was not located. */
  readonly excerpt: string | null;
  readonly found: boolean;
  readonly line: number | null;
}

export interface VerifyFormProps {
  readonly documentId: string;
  readonly proposed: Readonly<Record<VerifiableField, ProposedField>>;
  /** False when extraction has not run, so there is nothing to compare against. */
  readonly hasProposal: boolean;
}

type Mode = 'verify' | 'reject';

export function VerifyForm({ documentId, proposed, hasProposal }: VerifyFormProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [accepted, setAccepted] = React.useState<Record<VerifiableField, string>>(() =>
    initialValues(proposed),
  );
  const [mode, setMode] = React.useState<Mode>('verify');
  const [note, setNote] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const dateTypes: Partial<Record<VerifiableField, string>> = {
    start_date: 'date',
    end_date: 'date',
  };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    // `confirmed: true` is sent as a literal because the server schema demands a
    // literal. It is not a formality: it is the field that distinguishes a decision
    // from a replayed or default-valued request.
    const body =
      mode === 'verify'
        ? {
            verification_status: 'verified' as const,
            fields: toNullableFields(accepted),
            confirmed: true as const,
            ...(note.trim().length > 0 ? { note: note.trim() } : {}),
          }
        : {
            verification_status: 'rejected' as const,
            reason: reason.trim(),
            confirmed: true as const,
          };

    try {
      const response = await fetch(`/api/v1/documents/${documentId}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        // The server's frozen envelope carries a safe message and a request id. Both
        // are shown: the message so the reviewer knows what happened, the id so support
        // can find the log line without the reviewer describing it.
        const payload: unknown = await response.json().catch(() => null);
        const detail = readErrorMessage(payload);
        setError(detail.message);
        toast({
          variant: 'destructive',
          title: 'Not saved',
          description: detail.requestId
            ? `${detail.message} (${detail.requestId})`
            : detail.message,
        });
        return;
      }

      toast({
        variant: mode === 'verify' ? 'success' : 'default',
        title: mode === 'verify' ? 'Verified' : 'Rejected',
        description:
          mode === 'verify'
            ? 'The values you accepted are now recorded against your name.'
            : 'The document was rejected and no values were stored.',
      });
      router.refresh();
    } catch {
      setError('The request could not be sent. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      {!hasProposal ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertTitle>No proposed values</AlertTitle>
          <AlertDescription>
            Automatic extraction has not produced a proposal for this document. Read the document
            and enter each value yourself; the gate is the same either way.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="w-1/4 p-3 font-medium">
                Field
              </th>
              <th scope="col" className="w-1/4 p-3 font-medium">
                Proposed
              </th>
              <th scope="col" className="w-1/4 p-3 font-medium">
                From the document
              </th>
              <th scope="col" className="w-1/4 p-3 font-medium">
                Accepted value
              </th>
            </tr>
          </thead>
          <tbody>
            {VERIFIABLE_FIELDS.map((field) => {
              const item = proposed[field];
              return (
                <tr key={field} className="border-t align-top">
                  <th scope="row" className="p-3 text-left font-normal">
                    <Label htmlFor={`accepted-${field}`}>{FIELD_LABELS[field]}</Label>
                  </th>
                  <td className="p-3 text-muted-foreground">
                    {item.value === null ? (
                      <span className="italic">Not stated</span>
                    ) : (
                      <span>{item.value}</span>
                    )}
                  </td>
                  <td className="p-3">
                    {item.value === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : item.found ? (
                      <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground">
                        {item.excerpt}
                        {item.line !== null ? (
                          <span className="ml-1 opacity-70">(line {item.line})</span>
                        ) : null}
                      </blockquote>
                    ) : (
                      <Badge variant="warning" className="gap-1">
                        <AlertTriangle className="size-3" aria-hidden />
                        Not found in the document
                      </Badge>
                    )}
                  </td>
                  <td className="p-3">
                    <Input
                      id={`accepted-${field}`}
                      name={field}
                      type={dateTypes[field] ?? 'text'}
                      value={accepted[field]}
                      disabled={mode === 'reject' || submitting}
                      onChange={(event) =>
                        setAccepted((current) => ({ ...current, [field]: event.target.value }))
                      }
                      placeholder="Leave blank if the document does not say"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Decision</legend>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="mode"
              value="verify"
              checked={mode === 'verify'}
              onChange={() => setMode('verify')}
              disabled={submitting}
            />
            I have read the document and accept the values above
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="mode"
              value="reject"
              checked={mode === 'reject'}
              onChange={() => setMode('reject')}
              disabled={submitting}
            />
            Reject this document
          </label>
        </div>
      </fieldset>

      {mode === 'verify' ? (
        <div className="space-y-2">
          <Label htmlFor="note">Note (optional)</Label>
          <Textarea
            id="note"
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={submitting}
            placeholder="Anything the next person should know about this document."
          />
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="reason">Why are you rejecting it?</Label>
          <Textarea
            id="reason"
            name="reason"
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={submitting}
            placeholder="For example: the scan is unreadable, or this is the wrong tenancy."
          />
          <p className="text-xs text-muted-foreground">
            A rejection records no field values. Nothing from this document is stored as accepted.
          </p>
        </div>
      )}

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center gap-3">
        <Button
          type="submit"
          disabled={submitting || (mode === 'reject' && reason.trim().length < 3)}
        >
          {mode === 'verify' ? (
            <>
              <Check className="mr-2 size-4" aria-hidden />
              Confirm these values
            </>
          ) : (
            <>
              <X className="mr-2 size-4" aria-hidden />
              Reject document
            </>
          )}
        </Button>
        <p className="text-xs text-muted-foreground">
          Your name and the time are recorded with the decision.
        </p>
      </div>
    </form>
  );
}

/* --------------------------------------------------------------- helpers -- */

function initialValues(
  proposed: Readonly<Record<VerifiableField, ProposedField>>,
): Record<VerifiableField, string> {
  const values = {} as Record<VerifiableField, string>;
  for (const field of VERIFIABLE_FIELDS) values[field] = proposed[field].value ?? '';
  return values;
}

/**
 * An empty input means "the document does not state this", which the server schema
 * expresses as an explicit `null` rather than an omitted key. Sending `""` would fail
 * `boundedText(2, 120)` and look like a validation bug instead of a deliberate absence.
 */
function toNullableFields(
  values: Record<VerifiableField, string>,
): Record<VerifiableField, string | null> {
  const out = {} as Record<VerifiableField, string | null>;
  for (const field of VERIFIABLE_FIELDS) {
    const raw = values[field].trim();
    out[field] = raw.length === 0 ? null : raw;
  }
  return out;
}

function readErrorMessage(payload: unknown): { message: string; requestId: string | null } {
  const fallback = { message: 'The decision could not be saved.', requestId: null };
  if (typeof payload !== 'object' || payload === null) return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return fallback;

  const message = (error as { message?: unknown }).message;
  const requestId = (error as { request_id?: unknown }).request_id;
  return {
    message: typeof message === 'string' ? message : fallback.message,
    requestId: typeof requestId === 'string' ? requestId : null,
  };
}

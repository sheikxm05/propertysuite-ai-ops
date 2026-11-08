'use client';

/**
 * The AI-assisted "report an issue" panel. Lane w1-l5.
 *
 * It is the user-facing half of CLAUDE.md rule 7, so the interaction is designed around
 * the gate rather than around the model:
 *
 *  - Describing the problem produces a **draft**. The panel says so, in those words, and
 *    the button that produced it is labelled "Draft a summary", not "Submit".
 *  - The draft is reviewable and **editable**: title and description are text fields
 *    pre-filled from the classification, and the human's edits are what get committed.
 *  - Creating the ticket is a second, separate, explicitly labelled action that posts
 *    `confirmed: true`. There is no auto-advance, no timer and no path on which the first
 *    request creates anything.
 *  - When the draft asks for clarification, the confirm button is disabled and the
 *    question is shown. A tenant with more than one unit must choose one first.
 *
 * The suggested title and description are computed here with the same functions the
 * server would use (`services/ai/maintenance/draft.ts`, which has no server-side
 * imports), so the response envelope stays exactly the frozen `ClassifyResponseSchema`
 * and the two sides cannot disagree.
 */

import { useId, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { suggestDescription, suggestTitle } from '@/services/ai/maintenance/draft';
import {
  ClassifyResponseSchema,
  MAINTENANCE_CATEGORY_LABELS,
  type Classification,
  type TicketPriority,
} from '@shared/index';

const CLASSIFY_URL = '/api/v1/ai/maintenance/classify';
const CONFIRM_URL = '/api/v1/ai/maintenance/confirm';

/** `AiMessageContentSchema` bounds the message at 4000 characters. Mirrored for the UI. */
const MESSAGE_MAX_LENGTH = 4000;

/** How a priority is shown. `urgent` is destructive because it means somebody is at risk. */
const PRIORITY_VARIANT: Readonly<
  Record<TicketPriority, 'secondary' | 'default' | 'warning' | 'destructive'>
> = {
  low: 'secondary',
  normal: 'default',
  high: 'warning',
  urgent: 'destructive',
};

/** A unit the signed-in tenant may report against. Supplied by the mounting page. */
export interface ReportableUnit {
  readonly id: string;
  readonly label: string;
}

export interface ReportIssuePanelProps {
  /**
   * The caller's units, when the mounting surface already has them.
   *
   * Optional on purpose: this lane owns no units endpoint, and a tenant with exactly one
   * tenancy never needs a picker — the server resolves the unit from the session. The
   * picker appears only when a list is supplied and more than one unit is in it.
   */
  readonly units?: readonly ReportableUnit[];
  /** Rendered without the outer card, for embedding in a dashboard slot. */
  readonly compact?: boolean;
}

interface Draft {
  readonly classification: Classification;
  readonly resolvedPriority: TicketPriority;
  readonly priorityReasons: readonly string[];
  readonly conversationId: string | null;
  readonly propertyUnitId: string | null;
}

type Phase = 'describe' | 'review' | 'created';

export function ReportIssuePanel({ units, compact = false }: ReportIssuePanelProps) {
  const messageId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const unitId = useId();

  const [phase, setPhase] = useState<Phase>('describe');
  const [message, setMessage] = useState('');
  const [selectedUnit, setSelectedUnit] = useState<string>('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'classify' | 'confirm'>(null);
  const [error, setError] = useState<string | null>(null);

  const showUnitPicker = (units?.length ?? 0) > 1;
  const canDraft = message.trim().length > 0 && busy === null;

  const blockedReason = useMemo(() => {
    if (!draft) return 'No draft yet.';
    if (draft.classification.requires_clarification) {
      return draft.classification.clarification_question ?? 'More information is needed.';
    }
    if (!draft.propertyUnitId) return 'The unit for this report has not been identified.';
    if (title.trim().length < 3) return 'Add a title of at least 3 characters.';
    if (description.trim().length < 10) {
      return 'Add a description of at least 10 characters.';
    }
    return null;
  }, [draft, title, description]);

  async function onDraft() {
    setBusy('classify');
    setError(null);
    try {
      const payload = await postJson(CLASSIFY_URL, {
        message: message.trim(),
        ...(selectedUnit ? { property_unit_id: selectedUnit } : {}),
        ...(draft?.conversationId ? { conversation_id: draft.conversationId } : {}),
      });

      const parsed = ClassifyResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error('The assistant returned an unexpected response.');

      const next: Draft = {
        classification: parsed.data.data.draft,
        resolvedPriority: parsed.data.data.resolved_priority,
        priorityReasons: parsed.data.data.priority_reasons ?? [],
        conversationId: parsed.data.data.conversation_id,
        propertyUnitId: parsed.data.data.property_unit_id,
      };

      setDraft(next);
      setTitle(suggestTitle(next.classification) ?? '');
      setDescription(suggestDescription(next.classification) ?? '');
      setPhase('review');
    } catch (thrown) {
      setError(messageFor(thrown));
    } finally {
      setBusy(null);
    }
  }

  async function onConfirm() {
    if (!draft?.propertyUnitId) return;
    setBusy('confirm');
    setError(null);
    try {
      const payload = await postJson(CONFIRM_URL, {
        property_unit_id: draft.propertyUnitId,
        title: title.trim(),
        description: description.trim(),
        classification: draft.classification,
        ...(draft.conversationId ? { conversation_id: draft.conversationId } : {}),
        // The literal the server requires. A default-valued body is not a decision.
        confirmed: true,
      });
      const id = readTicketId(payload);
      setTicketId(id);
      setPhase('created');
    } catch (thrown) {
      setError(messageFor(thrown));
    } finally {
      setBusy(null);
    }
  }

  function onStartOver() {
    setPhase('describe');
    setDraft(null);
    setMessage('');
    setTitle('');
    setDescription('');
    setTicketId(null);
    setError(null);
  }

  const body = (
    <div className="space-y-4">
      {error === null ? null : (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {phase === 'describe' ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={messageId}>What is the problem?</Label>
            <Textarea
              id={messageId}
              value={message}
              maxLength={MESSAGE_MAX_LENGTH}
              rows={compact ? 3 : 5}
              placeholder="The air conditioning in the living room is running but not cooling."
              onChange={(event) => setMessage(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {message.length}/{MESSAGE_MAX_LENGTH} characters. This drafts a summary for you to
              check. Nothing is submitted yet.
            </p>
          </div>

          {showUnitPicker ? (
            <div className="space-y-2">
              <Label htmlFor={unitId}>Which unit?</Label>
              <Select value={selectedUnit} onValueChange={setSelectedUnit}>
                <SelectTrigger id={unitId}>
                  <SelectValue placeholder="Choose a unit" />
                </SelectTrigger>
                <SelectContent>
                  {(units ?? []).map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <Button type="button" onClick={onDraft} disabled={!canDraft}>
            {busy === 'classify' ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <Sparkles aria-hidden />
            )}
            Draft a summary
          </Button>
        </div>
      ) : null}

      {phase === 'review' && draft ? (
        <div className="space-y-4">
          <Alert>
            <AlertTitle>This is a draft. Nothing has been created.</AlertTitle>
            <AlertDescription>
              Check the summary, edit anything that is wrong, then submit it yourself.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {MAINTENANCE_CATEGORY_LABELS[draft.classification.category]}
            </Badge>
            <Badge variant={PRIORITY_VARIANT[draft.resolvedPriority]}>
              Priority: {draft.resolvedPriority}
            </Badge>
            {draft.classification.suggested_priority === draft.resolvedPriority ? null : (
              <span className="text-xs text-muted-foreground">
                The assistant suggested {draft.classification.suggested_priority}; policy set{' '}
                {draft.resolvedPriority}.
              </span>
            )}
          </div>

          {draft.classification.requires_clarification ? (
            <Alert variant="warning">
              <AlertTriangle aria-hidden />
              <AlertTitle>One more thing</AlertTitle>
              <AlertDescription>{draft.classification.clarification_question}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor={titleId}>Title</Label>
            <Input
              id={titleId}
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={descriptionId}>Description</Label>
            <Textarea
              id={descriptionId}
              value={description}
              rows={4}
              maxLength={4000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          {draft.classification.reported_symptoms.length > 0 ? (
            <div>
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Symptoms noted
              </h4>
              <ul className="mt-1 list-inside list-disc text-sm">
                {draft.classification.reported_symptoms.map((symptom) => (
                  <li key={symptom}>{symptom}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {draft.classification.missing_information.length > 0 ? (
            <div>
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Still unknown
              </h4>
              <ul className="mt-1 list-inside list-disc text-sm text-muted-foreground">
                {draft.classification.missing_information.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={onConfirm}
              disabled={blockedReason !== null || busy !== null}
            >
              {busy === 'confirm' ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Submit this report
            </Button>
            <Button type="button" variant="outline" onClick={onStartOver} disabled={busy !== null}>
              Start again
            </Button>
          </div>

          {blockedReason === null ? null : (
            <p className="text-xs text-muted-foreground">{blockedReason}</p>
          )}
        </div>
      ) : null}

      {phase === 'created' ? (
        <div className="space-y-4">
          <Alert variant="success">
            <AlertTitle>Report submitted</AlertTitle>
            <AlertDescription>
              {ticketId
                ? `Your maintenance request has been created. Reference ${ticketId}.`
                : 'Your maintenance request has been created.'}
            </AlertDescription>
          </Alert>
          <Button type="button" variant="outline" onClick={onStartOver}>
            Report something else
          </Button>
        </div>
      ) : null}
    </div>
  );

  if (compact) return body;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Report an issue</CardTitle>
        <CardDescription>
          Describe the problem in your own words. You will see a draft summary and submit it
          yourself.
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------- transport -- */

/**
 * Posts JSON and turns the frozen error envelope back into a readable message.
 *
 * `request_id` is appended when present, so a tenant reporting a problem can quote the id
 * the server logs are keyed on.
 */
async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify(body),
  });

  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return payload;

  const envelope =
    typeof payload === 'object' && payload !== null
      ? (payload as { error?: { message?: unknown; request_id?: unknown } }).error
      : undefined;
  const text =
    typeof envelope?.message === 'string' ? envelope.message : 'The request was rejected.';
  const requestId = typeof envelope?.request_id === 'string' ? envelope.request_id : null;
  throw new Error(requestId ? `${text} (reference ${requestId})` : text);
}

function readTicketId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const id = (data as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function messageFor(thrown: unknown): string {
  return thrown instanceof Error && thrown.message
    ? thrown.message
    : 'Something went wrong. Please try again.';
}

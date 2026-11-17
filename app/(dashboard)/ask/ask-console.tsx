'use client';

/**
 * The ask console — question in, answer and sources out.
 *
 * THE SOURCES ARE THE FEATURE, SO THEY ARE NOT HIDDEN BEHIND THE ANSWER
 * ---------------------------------------------------------------------
 * An assistant that answers questions about someone's tenancy contract is only useful if
 * the reader can check it, and "check it" has to mean something cheaper than opening the
 * PDF. So the sources are not a footnote: they are a numbered list directly beneath the
 * answer, each naming its document and its position in it, each expanding in place to
 * the exact stored extract the model was given. Expanding a source costs one click and
 * no navigation, because a verification step people have to navigate for is a
 * verification step people skip.
 *
 * They are `<details>` and `<summary>` rather than a JavaScript accordion. Native
 * disclosure is keyboard-operable, announced correctly by a screen reader, works before
 * hydration, and is found by the browser's own in-page search even while collapsed —
 * which matters here, because "find the clause that says this" is the actual task.
 *
 * WHAT IS RENDERED AND HOW
 * An excerpt is untrusted text from an uploaded PDF. It is rendered as a text node
 * inside a labelled block, never as markup and never through `dangerouslySetInnerHTML` —
 * so a document containing `<script>` or a markdown image pointing at an attacker's
 * server is just a document containing those characters. The answer is model prose and
 * is rendered the same way. The visual frame around an excerpt is part of the safety
 * story: a reader should never be in doubt about which words are the application's and
 * which came out of someone's file.
 *
 * Every colour is a semantic token (`muted`, `border`, `destructive`, `primary`), so
 * dark mode is correct by construction rather than by a second set of class names.
 *
 * Nothing here is authorization. The question goes to `POST /api/v1/rag/ask`, which
 * re-derives the organization from the session, applies the visibility predicate inside
 * the retrieval function, and re-checks every cited document with the caller's own
 * client before it builds a citation. A reader who crafts their own request gets exactly
 * the same checks and exactly the same documents.
 */

import * as React from 'react';
import { BookOpen, CornerDownLeft, FileText, Loader2, Quote, Search } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import type { RagAnswer, RagCitation } from '@/features/rag';

import { documentTypeLabel } from '../documents/labels';

/** One entry in the scope picker. Built by the page from an RLS-scoped read. */
export interface DocumentOption {
  readonly id: string;
  readonly label: string;
  readonly uploadedOn: string;
}

export interface AskConsoleProps {
  readonly documents: readonly DocumentOption[];
}

/** Radix Select has no empty-string value, so "everything" needs a name. */
const ALL_DOCUMENTS = 'all';

/** Matches `AskRequestSchema`'s bound, so the button disables before the server refuses. */
const MIN_QUESTION_CHARS = 3;
const MAX_QUESTION_CHARS = 500;

/**
 * Openers, for a reader facing an empty box.
 *
 * Not decoration: a question-answering surface is the one kind of UI where a new user
 * genuinely does not know what it will accept, and three concrete examples teach the
 * shape of a good question faster than a paragraph of help text.
 */
const EXAMPLE_QUESTIONS = [
  'What is the annual rent and how is it paid?',
  'When does the tenancy end, and what notice is required to renew?',
  'Who is responsible for air-conditioning maintenance?',
] as const;

type Status = 'idle' | 'asking' | 'answered' | 'failed';

export function AskConsole({ documents }: AskConsoleProps) {
  const [question, setQuestion] = React.useState('');
  const [scope, setScope] = React.useState<string>(ALL_DOCUMENTS);
  const [status, setStatus] = React.useState<Status>('idle');
  const [answer, setAnswer] = React.useState<RagAnswer | null>(null);
  const [asked, setAsked] = React.useState<string>('');
  const [error, setError] = React.useState<{ message: string; requestId: string | null } | null>(
    null,
  );

  const formRef = React.useRef<HTMLFormElement>(null);

  const trimmed = question.trim();
  const canAsk = trimmed.length >= MIN_QUESTION_CHARS && status !== 'asking';

  /**
   * Ctrl+Enter submits; plain Enter inserts a newline.
   *
   * The opposite binding is tempting on a question box, and wrong here: a question about
   * a contract is often two sentences, and a box that fires on the first Enter teaches
   * people to compose somewhere else and paste.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  }

  async function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAsk) return;

    setStatus('asking');
    setError(null);
    setAnswer(null);
    setAsked(trimmed);

    try {
      const response = await fetch('/api/v1/rag/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: trimmed,
          // Omitted rather than sent as null when unscoped: `AskRequestSchema` is
          // `.strict()` and `document_id` is optional, not nullable.
          ...(scope === ALL_DOCUMENTS ? {} : { document_id: scope }),
        }),
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        // The frozen envelope carries a safe message and a request id. Both are shown:
        // the message so the reader knows what happened, the id so support can find the
        // log line without the reader having to describe the failure.
        setError(readError(payload));
        setStatus('failed');
        return;
      }

      const data = readAnswer(payload);
      if (!data) {
        setError({
          message: 'The answer came back in a shape this page cannot read.',
          requestId: null,
        });
        setStatus('failed');
        return;
      }

      setAnswer(data);
      setStatus('answered');
    } catch {
      setError({
        message: 'The request could not be sent. Check your connection and try again.',
        requestId: null,
      });
      setStatus('failed');
    }
  }

  const scopeLabel =
    scope === ALL_DOCUMENTS
      ? 'every document you can open'
      : (documents.find((d) => d.id === scope)?.label ?? 'the selected document');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="size-4" aria-hidden="true" />
            Your question
          </CardTitle>
          <CardDescription>
            Searching {scopeLabel}. Nothing you ask here changes a record.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form ref={formRef} onSubmit={ask} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rag-question">Question</Label>
              <Textarea
                id="rag-question"
                name="question"
                rows={3}
                maxLength={MAX_QUESTION_CHARS}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder="What does the contract say about the security deposit?"
                disabled={status === 'asking'}
                aria-describedby="rag-question-hint"
              />
              <p id="rag-question-hint" className="text-xs text-muted-foreground">
                {MAX_QUESTION_CHARS - question.length} characters left. Press Ctrl+Enter to send.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="space-y-2">
                <Label htmlFor="rag-scope">Search in</Label>
                <Select value={scope} onValueChange={setScope} disabled={status === 'asking'}>
                  <SelectTrigger id="rag-scope" aria-label="Documents to search">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_DOCUMENTS}>All of my documents</SelectItem>
                    {documents.map((document) => (
                      <SelectItem key={document.id} value={document.id}>
                        {document.label} · {document.uploadedOn}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button type="submit" disabled={!canAsk}>
                {status === 'asking' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CornerDownLeft className="size-4" aria-hidden="true" />
                )}
                {status === 'asking' ? 'Searching…' : 'Ask'}
              </Button>
            </div>
          </form>

          {status === 'idle' ? (
            <div className="mt-5 border-t pt-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Try one of these
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {EXAMPLE_QUESTIONS.map((example) => (
                  <Button
                    key={example}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-auto whitespace-normal py-1.5 text-left font-normal"
                    onClick={() => setQuestion(example)}
                  >
                    {example}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {status === 'asking' ? <AnswerSkeleton /> : null}

      {status === 'failed' && error ? (
        <Alert variant="destructive">
          <AlertTitle>That question could not be answered</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>{error.message}</p>
            {error.requestId ? (
              <p className="font-mono text-xs opacity-80">Reference {error.requestId}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {status === 'answered' && answer ? <AnswerPanel question={asked} answer={answer} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ answer -- */

function AnswerPanel({ question, answer }: { question: string; answer: RagAnswer }) {
  const grounded = answer.citations.length > 0;

  return (
    <Card aria-live="polite">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <BookOpen className="size-4" aria-hidden="true" />
          Answer
          <Badge variant={grounded ? 'success' : 'secondary'}>
            {grounded
              ? `${answer.citations.length} ${answer.citations.length === 1 ? 'source' : 'sources'}`
              : 'No source found'}
          </Badge>
        </CardTitle>
        <CardDescription className="text-pretty">“{question}”</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <p className="text-pretty text-sm leading-relaxed">{answer.answer}</p>

        {grounded ? (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Where this came from
              </h2>
              <p className="text-xs text-muted-foreground">
                {answer.retrieved} {answer.retrieved === 1 ? 'extract' : 'extracts'} searched
              </p>
            </div>

            <ol className="space-y-2">
              {answer.citations.map((citation, index) => (
                <li key={`${citation.document_id}-${citation.chunk_index}`}>
                  <CitationBlock citation={citation} ordinal={index + 1} />
                </li>
              ))}
            </ol>

            <p className="text-xs text-muted-foreground">
              The extracts are the document&rsquo;s own words. The answer above them is a summary
              written by a model and is not a legal interpretation — check it against the source
              before you rely on it.
            </p>
          </div>
        ) : (
          <EmptyState
            icon={Quote}
            title="Nothing in your documents supports an answer"
            description={
              answer.retrieved > 0
                ? `${answer.retrieved} ${answer.retrieved === 1 ? 'extract was' : 'extracts were'} searched and none of them answered this. Try naming the clause or the figure you are looking for.`
                : 'No extract matched this question. The document may not be uploaded yet, or may not have been through extraction.'
            }
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One source, collapsed to its name and expandable to its text.
 *
 * The excerpt is set in a monospace block with a left border, which is doing real work
 * rather than decoration: it marks, unmistakably, where the application stops speaking
 * and an uploaded file starts. Everything inside that frame was written by whoever
 * uploaded the document.
 */
function CitationBlock({ citation, ordinal }: { citation: RagCitation; ordinal: number }) {
  return (
    <details className="group rounded-md border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {ordinal}
        </span>
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {documentTypeLabel(citation.document_type)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          extract {citation.chunk_index + 1}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground group-open:hidden">Show</span>
        <span className="hidden shrink-0 text-xs text-muted-foreground group-open:inline">
          Hide
        </span>
      </summary>

      <div className="border-t px-3 py-3">
        <p className="mb-2 text-xs text-muted-foreground">
          From the document, as stored. Not edited, not summarised.
        </p>
        <blockquote className="border-l-2 border-muted-foreground/30 bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
          {citation.excerpt}
        </blockquote>
      </div>
    </details>
  );
}

/** Shape, never content — the same rule the segment skeletons follow. */
function AnswerSkeleton() {
  return (
    <Card aria-busy="true" aria-live="polite">
      <CardHeader>
        <span className="sr-only">Searching your documents…</span>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/5" />
        </div>
        <div className="space-y-2 pt-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </CardContent>
    </Card>
  );
}

/* ----------------------------------------------------------------- parsing -- */

/**
 * Reads `{ data: … }` without trusting it.
 *
 * The page is the one place the response shape is read, and reading it defensively costs
 * three guards. It returns `null` rather than throwing so a shape change becomes a
 * message on screen instead of a blank panel and a console error nobody sees.
 */
function readAnswer(payload: unknown): RagAnswer | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;

  const record = data as Record<string, unknown>;
  if (typeof record.answer !== 'string') return null;
  if (!Array.isArray(record.citations)) return null;

  const citations: RagCitation[] = [];
  for (const entry of record.citations) {
    if (typeof entry !== 'object' || entry === null) continue;
    const citation = entry as Record<string, unknown>;
    if (
      typeof citation.document_id !== 'string' ||
      typeof citation.document_type !== 'string' ||
      typeof citation.chunk_index !== 'number' ||
      typeof citation.excerpt !== 'string'
    ) {
      continue;
    }
    citations.push({
      document_id: citation.document_id,
      document_type: citation.document_type,
      chunk_index: citation.chunk_index,
      excerpt: citation.excerpt,
    });
  }

  return {
    answer: record.answer,
    citations,
    retrieved: typeof record.retrieved === 'number' ? record.retrieved : citations.length,
  };
}

/** Reads the frozen error envelope: `{ error: { code, message, request_id } }`. */
function readError(payload: unknown): { message: string; requestId: string | null } {
  const fallback = 'Something went wrong while answering. Nothing was changed.';
  if (typeof payload !== 'object' || payload === null)
    return { message: fallback, requestId: null };

  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return { message: fallback, requestId: null };

  const record = error as Record<string, unknown>;
  return {
    message: typeof record.message === 'string' ? record.message : fallback,
    requestId: typeof record.request_id === 'string' ? record.request_id : null,
  };
}

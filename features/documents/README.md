# Documents, extraction and the job runner — lane w1-l6

Upload a PDF to private storage, extract its text and propose fields, and let an
authorized human accept or reject them. The last clause is the feature; everything
before it is machinery.

## The one invariant

**Nothing in this lane can verify a document.**

`POST /api/v1/documents/{documentId}/verify` is the only code that writes
`documents.verification_status`, and it needs an authenticated staff session and
`confirmed: true` as a Zod literal. The extraction worker writes exactly two columns,
`extracted_text` and `extracted_data`, and the function that builds its envelope
(`buildPendingEnvelope`) has no parameter capable of producing a verification block — so
the code to misuse does not exist. `DocumentExtractionSchema` has no
`verification_status` field either, so there is no value a model could return that moves
a document out of `pending`, however thoroughly an injected instruction has persuaded it.

That is acceptance criterion 9 and CLAUDE.md rule 7, and it is attacked from four
directions in `tests/documents/verification-gate.test.ts`.

## Where things live

| Path                                 | What                                                                |
| ------------------------------------ | ------------------------------------------------------------------- |
| `app/api/v1/documents/**`            | the six route handlers                                              |
| `app/(dashboard)/documents/**`       | the list and the proposed-versus-accepted verification screen       |
| `features/documents/server/**`       | database and storage access, the two authorization gates, the cursor |
| `features/documents/{nav,widget}`    | the sidebar entry and the pending-verification dashboard tile        |
| `services/extraction/**`             | validation, PDF text, fencing, the prompt, excerpts, the envelope    |
| `services/workers/**`                | the job queue, the bounded retry policy, the runner                  |
| `tests/documents/**`                 | 193 unit tests, including a real PDF corpus built in memory          |

## The flow

1. `POST /documents/upload-url` — authorize, validate the declared MIME, extension and
   size, insert a `pending` row, and return a signed upload URL on
   `{organization_id}/{entity}/{uuid}.pdf`. The organization comes from the session;
   there is no field in `UploadUrlSchema` through which a caller could supply one.
2. The client uploads straight to Storage. The bytes never pass through the application,
   which is why step 3 exists.
3. `POST /documents/{id}/process` — **magic-byte check** (a ranged `GET` of the first
   kibibyte over a 60-second signed URL), then enqueue. `202`. A file that is secretly a
   ZIP is rejected here with `422`, before a job row exists.
4. The worker claims the job, re-checks the signature on the whole object, extracts text
   with `pdf-parse`, fences the text, calls the AI port, validates the reply against the
   frozen shared schema, and stores a proposal. The document is still `pending`.
5. `POST /documents/{id}/verify` — a human accepts or rejects. Audited, compare-and-swap
   on `pending`, and it writes `documents` and nothing else.

Step 5 writes no `tenancies` row. A verified contract is a record of what a document
says; its dates and rent becoming a tenancy's actual terms is a separate decision by a
human in the tenancy screens.

## Three things found by running the code

- **pdf-parse silently mis-parses a pooled Node `Buffer`.** A small `Buffer` is a view
  into Node's allocation pool with a non-zero `byteOffset`, and the bundled pdf.js reads
  through `.buffer` without applying it, so every offset in the cross-reference table is
  wrong by the pool offset. It fails with `FormatError: bad XRef entry`, which looks
  exactly like a corrupt upload. `extractPdfText` copies to a zero-offset `Uint8Array`
  first; `tests/documents/pdf-text.test.ts` is what stops that copy being deleted as
  redundant.
- **The magic-byte check has only one possible home.** With a direct-to-Storage upload,
  the declared `content-type` and the `.pdf` extension are the only signals available at
  `upload-url` time, and both are strings the caller chose. `/process` is the first
  moment the real bytes can be inspected.
- **The job queue needs a visibility timeout, not just a retry cap.** A worker that dies
  between claiming and reporting leaves a row `running` forever — never retried, never
  dead-lettered, which is the one failure mode a bounded-retry design is meant to rule
  out. The claim pushes `next_run_at` to a deadline and the reaper treats an expired
  `running` row as abandoned, using only columns the existing schema has.

## What is not proven here

The unit suite cannot evaluate Row Level Security, and no test in it claims to. What it
proves is the complementary half: seeded with another organization's row — which is what
an RLS failure looks like — the routes refuse it anyway. That is the second of the two
enforcement layers, tested on the assumption that the first has failed.

Live RLS, live Storage expiry and a live model call are covered by `tests/rls/**`, the
end-to-end suite, and the evals — none of which could run in this lane's environment,
because the Supabase anon and service-role keys and `ANTHROPIC_API_KEY` were not
available. See the lane report for the exact list.

## Running the worker

```bash
npx tsx services/workers/cli.ts            # poll until interrupted
npx tsx services/workers/cli.ts --once     # one batch, then exit
```

Requires `SUPABASE_SERVICE_ROLE_KEY`: `public.jobs` has RLS enabled with no policies, so
the queue is service-role only. Without the key the process exits non-zero with a named
reason rather than polling a queue it cannot read.

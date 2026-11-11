/**
 * Shared eval helpers. Lane w1-l5.
 *
 * `runCase` is the one path every offline eval takes: build the real adapter over the
 * recorded transport, classify, then apply the same server-side steps the classify route
 * applies — the clarification overlay and `resolvePriority` with trusted facts. The
 * assertions are therefore about the application's end-to-end answer, not about one
 * function in the middle of it.
 *
 * `resolvePriority` is called directly rather than through `decidePriority`, which needs a
 * Supabase client. The two differ only in where the trusted facts come from, and an eval
 * that needed a database would not be an eval.
 */

import {
  resolvePriority,
  type Classification,
  type MaintenanceCategory,
  type PriorityDecision,
} from '@shared/index';
import { applyUnitClarification } from '@/services/ai/maintenance/draft';
import { createClassificationProvider } from '@/services/ai/providers/provider';
import type { TrustedContext, UnitResolution } from '@/services/ai';

import { recordedCase, recordedTransport, type RecordedTransport } from './recorded-transport';

/** A tenant with exactly one active tenancy: the unambiguous case. */
export const RESOLVED_CONTEXT: TrustedContext = Object.freeze({
  unitResolution: 'resolved',
  candidateUnitCount: 1,
  hasActiveTenancy: true,
});

/** A tenant with three tenancies who did not say which unit. */
export const AMBIGUOUS_CONTEXT: TrustedContext = Object.freeze({
  unitResolution: 'ambiguous',
  candidateUnitCount: 3,
  hasActiveTenancy: false,
});

export interface EvalOutcome {
  /** The validated model output, before the server's overlay. */
  readonly classification: Classification;
  /** What the tenant would actually see, after the server's unit knowledge is applied. */
  readonly draft: Classification;
  /** What the ticket would actually get. */
  readonly priority: PriorityDecision;
  readonly attempts: number;
  readonly promptVersion: string;
  readonly transport: RecordedTransport;
}

export interface RunCaseOptions {
  readonly trusted?: TrustedContext;
  /** Overrides the message from the fixture. */
  readonly message?: string;
  /** Simulates an out-of-hours report. Defaults to in-hours, so results are stable. */
  readonly outsideBusinessHours?: boolean;
  /** Other live tickets on the same unit and category. Defaults to none. */
  readonly recurringOpenTickets?: number;
}

/** Runs one recorded case through the real adapter and the real server-side policy. */
export async function runCase(id: string, options: RunCaseOptions = {}): Promise<EvalOutcome> {
  const fixture = recordedCase(id);
  const message = options.message ?? fixture.message;
  if (!message) {
    throw new Error(`Case '${id}' has no message; pass one with options.message.`);
  }

  const transport = recordedTransport(id);
  const adapter = createClassificationProvider({ transport, model: 'fixture-model' });
  const trusted = options.trusted ?? RESOLVED_CONTEXT;

  const result = await adapter.classify({ untrusted: { tenantMessage: message }, trusted });
  const draft = applyUnitClarification(result.classification, {
    resolution: trusted.unitResolution as UnitResolution,
  });

  const priority = resolvePriority(
    { suggested_priority: draft.suggested_priority },
    {
      category: draft.category as MaintenanceCategory,
      hasActiveTenancy: trusted.hasActiveTenancy,
      recurringOpenTickets: options.recurringOpenTickets ?? 0,
      outsideBusinessHours: options.outsideBusinessHours ?? false,
    },
  );

  return {
    classification: result.classification,
    draft,
    priority,
    attempts: result.attempts,
    promptVersion: result.promptVersion,
    transport,
  };
}

/** Builds the adapter for a case without running it, for the failure-path evals. */
export function adapterFor(id: string): {
  transport: RecordedTransport;
  classify: (message: string, trusted?: TrustedContext) => Promise<unknown>;
} {
  const transport = recordedTransport(id);
  const adapter = createClassificationProvider({ transport, model: 'fixture-model' });
  return {
    transport,
    classify: (message, trusted = RESOLVED_CONTEXT) =>
      adapter.classify({ untrusted: { tenantMessage: message }, trusted }),
  };
}

/** The seven fields `ClassificationSchema` permits, sorted. Nothing else may appear. */
export const CONTRACT_FIELDS = [
  'category',
  'clarification_question',
  'missing_information',
  'reported_symptoms',
  'requires_clarification',
  'suggested_priority',
  'summary',
] as const;

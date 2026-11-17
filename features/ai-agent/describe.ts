/**
 * Turning a tool call into English.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * A proposal arrives as `{ tool_name: "create_ticket", arguments: { … } }`. Rendering
 * that verbatim and putting an Approve button under it would be asking a property
 * manager to authorize a JSON blob — which is how consent theatre works, and the
 * opposite of what this screen claims. A human can only meaningfully approve something
 * they can read, so the card leads with a sentence:
 *
 *     Create a maintenance ticket — unit 1204, category air conditioning and heating,
 *     priority high.
 *
 * and keeps the raw arguments one click below it, verbatim, so the sentence can be
 * checked rather than trusted. Both are shown; neither replaces the other.
 *
 * DEGRADES RATHER THAN BREAKS
 * ---------------------------
 * The tool catalogue is `services/ai/agent/tools/**` and it will grow. Nothing here
 * depends on recognising a tool: an unknown `tool_name` still becomes a sentence by
 * unsnaking it, and unknown arguments still become labelled rows by unsnaking their keys.
 * The tables below only make the current eight read perfectly. They are not a whitelist,
 * and a tool missing from them renders a complete, approvable card anyway.
 *
 * Pure functions, no React, no server imports — safe on either side of the boundary.
 */

import { MAINTENANCE_CATEGORY_LABELS } from '@shared/index';
import { TICKET_PRIORITY_STYLE, TICKET_STATUS_STYLE } from '@/components/ui/status';

import type { AgentProposal, AgentStep } from './wire';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export interface ActionFact {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** An identifier: rendered in a mono face rather than wrapped as prose. */
  readonly mono?: boolean;
  /** A controlled-vocabulary value, so a sentence may lower-case it. */
  readonly enumLike?: boolean;
}

export interface ActionDescription {
  /** The verb phrase alone: "Create a maintenance ticket". */
  readonly headline: string;
  /** The verb phrase with its most important arguments, as one sentence. */
  readonly sentence: string;
  /** Every argument worth showing without expanding the raw JSON. */
  readonly facts: readonly ActionFact[];
  /** True when an argument was too nested to summarise; the JSON is then the only full view. */
  readonly truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Tool vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The three consequential tools, phrased as the imperative the human is authorizing.
 *
 * Imperative and present tense, never past: "Create a maintenance ticket" is a thing
 * that has not happened. "Created a maintenance ticket" on a pending card would be
 * exactly the lie this product exists to avoid.
 */
const PROPOSAL_TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  create_ticket: 'Create a maintenance ticket',
  assign_provider: 'Assign a service provider to a ticket',
  set_priority: 'Change a ticket priority',
});

/**
 * The five read-only tools, phrased in the past tense, because by the time the browser
 * renders this they have already run. They changed nothing, so they needed no gate.
 */
const READ_TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  lookup_unit: 'Looked up a unit',
  lookup_tenancy: 'Checked the tenancy on a unit',
  recent_tickets: 'Searched recent maintenance tickets',
  list_providers: 'Listed the service providers',
  search_documents: 'Searched the documents',
});

/** Argument keys, in plain words. */
const ARGUMENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  property_unit_id: 'Unit',
  unit_id: 'Unit',
  unit_label: 'Unit',
  property_id: 'Property',
  ticket_id: 'Ticket',
  service_provider_id: 'Service provider',
  tenancy_id: 'Tenancy',
  document_id: 'Document',
  category: 'Category',
  priority: 'Priority',
  status: 'Status',
  title: 'Title',
  description: 'Description',
  query: 'Search',
  limit: 'Limit',
});

/**
 * The order facts appear in, so the first line of every card reads the same way: subject
 * first, then classification, then free text. Anything unnamed follows in wire order.
 */
const FACT_PRIORITY: readonly string[] = [
  'unit_label',
  'property_unit_id',
  'unit_id',
  'ticket_id',
  'service_provider_id',
  'category',
  'priority',
  'status',
  'title',
];

/* -------------------------------------------------------------------------- */
/* Public helpers                                                             */
/* -------------------------------------------------------------------------- */

/** The imperative sentence under which Approve and Reject sit. */
export function describeProposal(proposal: AgentProposal): ActionDescription {
  const headline = PROPOSAL_TOOL_LABELS[proposal.tool_name] ?? unsnake(proposal.tool_name);
  return buildDescription(headline, proposal.arguments);
}

/**
 * One line for a step in the trace.
 *
 * `AgentStepSchema` carries metadata only — round, tool, kind, outcome, duration — and
 * deliberately no arguments and no results: "never a tool result" is a comment in the
 * schema and a rule in the route, because a tool result can contain a resident's words.
 * So this describes the *call*, and the assistant's own summary describes the findings.
 */
export function describeStep(step: AgentStep): string {
  if (step.kind === 'propose') {
    return PROPOSAL_TOOL_LABELS[step.tool] ?? unsnake(step.tool);
  }
  return READ_TOOL_LABELS[step.tool] ?? unsnake(step.tool);
}

/** `create_ticket` to `Create ticket`. Never throws, never returns an empty string. */
export function unsnake(value: string): string {
  const words = value
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  if (words.length === 0) return 'Unnamed action';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A server override of the model's request, in the reader's terms.
 *
 * `adjustments` is where the deterministic policy shows its work: the model may ask for
 * `urgent` and `clampPriority()` reduces it to `high`, because escalating to urgent is a
 * human decision. Surfacing it on the card matters — the reader is approving the
 * *adjusted* arguments, not the ones the model wrote, and should be told which is which.
 */
export function describeAdjustment(adjustment: string): string {
  return adjustment.includes(' ') ? adjustment : unsnake(adjustment);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function buildDescription(
  headline: string,
  args: Readonly<Record<string, unknown>>,
): ActionDescription {
  const facts: ActionFact[] = [];
  let truncated = false;

  for (const key of orderedKeys(args)) {
    const raw = args[key];
    if (raw === null || raw === undefined || raw === '') continue;

    const formatted = formatValue(key, raw);
    if (formatted === null) {
      truncated = true;
      continue;
    }
    facts.push({
      key,
      label: ARGUMENT_LABELS[key] ?? unsnake(key),
      value: formatted.value,
      mono: formatted.mono,
      enumLike: formatted.enumLike,
    });
  }

  // Four is about as many clauses as a sentence carries before it stops being read. The
  // rest are still on the card as labelled rows; nothing is hidden, only de-emphasised.
  const clauses = facts
    .slice(0, 4)
    .map((fact) => `${fact.label.toLowerCase()} ${fact.enumLike ? lower(fact.value) : fact.value}`);

  return {
    headline,
    sentence: clauses.length > 0 ? `${headline} — ${clauses.join(', ')}.` : `${headline}.`,
    facts,
    truncated,
  };
}

/** Known keys first, in the order above; everything else in the order the server sent it. */
function orderedKeys(args: Readonly<Record<string, unknown>>): string[] {
  const present = Object.keys(args);
  const ranked = FACT_PRIORITY.filter((key) => present.includes(key));
  const rest = present.filter((key) => !ranked.includes(key));
  return [...ranked, ...rest];
}

interface FormattedValue {
  readonly value: string;
  readonly mono?: boolean;
  readonly enumLike?: boolean;
}

/**
 * One argument, as text. `null` means "this cannot be summarised in a row" — the caller
 * flags the card as truncated and the reader expands the raw JSON instead.
 */
function formatValue(key: string, raw: unknown): FormattedValue | null {
  if (typeof raw === 'boolean') return { value: raw ? 'Yes' : 'No' };
  if (typeof raw === 'number') return { value: String(raw) };

  if (Array.isArray(raw)) {
    const scalars = raw.filter(
      (item): item is string | number => typeof item === 'string' || typeof item === 'number',
    );
    if (scalars.length === 0 || scalars.length !== raw.length) return null;
    return { value: scalars.join(', ') };
  }

  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (text.length === 0) return null;

  // Controlled vocabularies get their product label, so the card says "Air conditioning
  // and heating" where the wire said "hvac" — the same words the maintenance screens use.
  if (key === 'category') {
    const label = MAINTENANCE_CATEGORY_LABELS[text as keyof typeof MAINTENANCE_CATEGORY_LABELS];
    if (label) return { value: label, enumLike: true };
  }
  if (key === 'priority') {
    const style = TICKET_PRIORITY_STYLE[text as keyof typeof TICKET_PRIORITY_STYLE];
    if (style) return { value: style.label, enumLike: true };
  }
  if (key === 'status') {
    const style = TICKET_STATUS_STYLE[text as keyof typeof TICKET_STATUS_STYLE];
    if (style) return { value: style.label, enumLike: true };
  }

  if (isUuid(text)) return { value: text, mono: true };
  if (text.length > 240) return { value: `${text.slice(0, 237)}…` };
  return { value: text };
}

/** Lower-cases a label for mid-sentence use without flattening an acronym or an id. */
function lower(value: string): string {
  return /^[A-Z][a-z]/.test(value) ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

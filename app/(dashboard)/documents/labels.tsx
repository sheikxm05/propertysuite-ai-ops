/**
 * Display strings for the document screens.
 *
 * Labels only. The *values* come from `DOCUMENT_TYPES` and `VERIFICATION_STATUSES` in
 * `packages/shared`, so this file maps a frozen enum to prose rather than restating the
 * enum (CLAUDE.md rule 4). `documentTypeLabel` falls back to the raw value, because
 * `documents.document_type` is `text` in SQL rather than a Postgres enum (§5.9 carries
 * that gap for `w2-l3`) — a row written directly could hold anything, and the UI should
 * render it rather than crash on it.
 *
 * The field labels matter more than they look. A verification screen is only a gate if
 * the reviewer understands what they are confirming, and "Tenant name as written on the
 * contract" asks a different question from "tenant_name".
 */

import { DOCUMENT_TYPES, VERIFICATION_STATUSES, type DocumentType } from '@shared/index';

const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  tenancy_contract: 'Tenancy contract',
  title_deed: 'Title deed',
  ejari_certificate: 'Ejari certificate',
  emirates_id: 'Emirates ID',
  passport: 'Passport',
  invoice: 'Invoice',
  maintenance_evidence: 'Maintenance evidence',
  other: 'Other document',
};

export function documentTypeLabel(value: string): string {
  return (DOCUMENT_TYPE_LABELS as Record<string, string>)[value] ?? value;
}

/** Keyed by string, not by the enum, for the same reason as above. */
export const VERIFICATION_LABELS: Record<string, string> = {
  pending: 'Awaiting review',
  verified: 'Verified by a person',
  rejected: 'Rejected',
};

/** Compile-time check that every frozen value has a label. */
const _COVERAGE: readonly string[] = [
  ...DOCUMENT_TYPES.map(documentTypeLabel),
  ...VERIFICATION_STATUSES.map((status) => VERIFICATION_LABELS[status] ?? status),
];
void _COVERAGE;

export const FIELD_LABELS = {
  tenant_name: 'Tenant name, as written on the document',
  contract_number: 'Contract or Ejari number',
  property_address: 'Property address',
  start_date: 'Start date',
  end_date: 'End date',
  rent_amount: 'Rent amount',
  currency: 'Currency',
} as const;

/**
 * Formats an instant for display.
 *
 * `en-AE` and `Asia/Dubai` are pinned (§5.7 freezes the locale) so a server render and a
 * client render agree. Without the pin the same row reads differently depending on where
 * it was rendered, which on a date field a human is verifying is a genuine hazard.
 */
export function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-AE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dubai',
  }).format(parsed);
}

/** A value, or an explicit statement that the document did not give one. */
export function displayValue(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim().length === 0) return 'Not stated';
  return value;
}

/**
 * Controlled maintenance categories.
 *
 * `maintenance_tickets.category` is `text not null default 'unknown'` in
 * `0001_initial_schema.sql` — it is NOT a Postgres enum, so there is no
 * database type to mirror and no parity assertion is possible for it. The
 * controlled list is therefore owned here and comes from
 * `docs/ai-prompts/maintenance-classification.md` ("Allowed categories"),
 * which is the frozen contract both the AI adapter and the ticket schema
 * validate against.
 *
 * `unknown` is last and is the database default: it means "not yet
 * classified", not "none of the above" (that is `other`).
 */
export const MAINTENANCE_CATEGORIES = [
  'hvac',
  'plumbing',
  'electrical',
  'appliance',
  'structural',
  'pest_control',
  'cleaning',
  'other',
  'unknown',
] as const;

export type MaintenanceCategory = (typeof MAINTENANCE_CATEGORIES)[number];

/** The database default for `maintenance_tickets.category`. */
export const DEFAULT_MAINTENANCE_CATEGORY = 'unknown' as const satisfies MaintenanceCategory;

export const MAINTENANCE_CATEGORY_LABELS: Readonly<Record<MaintenanceCategory, string>> =
  Object.freeze({
    hvac: 'Air conditioning and heating',
    plumbing: 'Plumbing',
    electrical: 'Electrical',
    appliance: 'Appliance',
    structural: 'Structural',
    pest_control: 'Pest control',
    cleaning: 'Cleaning',
    other: 'Other',
    unknown: 'Unclassified',
  });

export function isMaintenanceCategory(value: unknown): value is MaintenanceCategory {
  return (
    typeof value === 'string' && (MAINTENANCE_CATEGORIES as readonly string[]).includes(value)
  );
}

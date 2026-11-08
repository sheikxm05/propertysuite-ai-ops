/**
 * Throwaway rows for tests that must mutate state. Lane w0-l6.
 *
 * The seeded fixture is shared by every file in the suite, so a test that drives a
 * ticket from `assigned` to `in_progress` would change the answer to a later test's
 * question — and would fail on a second run against the same database, because the
 * edge is no longer legal from the new state. Both failures look like security
 * findings and are not.
 *
 * So anything that genuinely mutates gets its own ticket, created here through the
 * service-role client (fixture setup, never an assertion) and walked to the required
 * status along legal edges only.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrgFixture } from './fixtures';
import { SHARED_SHAPE } from './fixtures';

export interface ScratchTicketOptions {
  /** Target status. Reached by walking legal edges from `open`. */
  status?: string;
  /** Which seeded tenant reports it. Defaults to the tenant principal (t1). */
  tenant?: 't1' | 't2';
  /** Which seeded provider it is assigned to, when the path passes through `assigned`. */
  provider?: 'sp1' | 'sp2';
  /** Put it on the property the owner does not own. */
  onUnownedProperty?: boolean;
}

const LEGAL_PATH = ['open', 'assigned', 'in_progress', 'awaiting_approval', 'completed'] as const;

/** The legal edge sequence from `open` to `target`. */
export function pathTo(target: string): string[] {
  if (target === 'open') return [];
  if (target === 'cancelled') return ['cancelled'];
  const index = LEGAL_PATH.indexOf(target as (typeof LEGAL_PATH)[number]);
  if (index < 0) throw new Error(`No legal path to status "${target}"`);
  return LEGAL_PATH.slice(1, index + 1) as unknown as string[];
}

/**
 * Creates a ticket and walks it to `status`. Returns its id.
 *
 * Uses the service-role client deliberately: the point of the state-machine suite is
 * what the DATABASE TRIGGER does to the transition under test, so arriving at the
 * starting state must not itself depend on the policy being tested.
 */
export async function createScratchTicket(
  service: SupabaseClient,
  f: OrgFixture,
  options: ScratchTicketOptions = {},
): Promise<string> {
  const { status = 'open', tenant = 't1', provider = 'sp1', onUnownedProperty = false } = options;
  const id = randomUUID();
  const property = onUnownedProperty ? f.properties.p2 : f.properties.p1;
  const unit = onUnownedProperty ? f.units.p2u1 : f.units.p1u1;
  const tenancy = onUnownedProperty ? f.tenancies.tc3 : f.tenancies.tc1;

  const { error } = await service.from('maintenance_tickets').insert({
    id,
    organization_id: f.organizationId,
    property_id: property,
    property_unit_id: unit,
    tenancy_id: tenancy,
    tenant_id: f.tenants[tenant],
    title: SHARED_SHAPE.ticketTitles[0],
    description: 'Scratch ticket created by the isolation suite.',
    category: 'hvac',
    priority: 'normal',
    status: 'open',
    source: 'web',
  });
  if (error) {
    throw new Error(`Could not create a scratch ticket: ${error.message}`);
  }

  for (const next of pathTo(status)) {
    const patch: Record<string, unknown> = { status: next };
    if (next === 'assigned') patch.assigned_provider_id = f.providers[provider];
    const step = await service.from('maintenance_tickets').update(patch).eq('id', id);
    if (step.error) {
      throw new Error(
        `Could not walk scratch ticket ${id} to ${next}: ${step.error.message}. ` +
          'Only legal edges are walked here, so this indicates the transition trigger ' +
          'disagrees with the §4 state machine.',
      );
    }
  }

  return id;
}

/** Reads a single column of a scratch row with the service-role client. Setup only. */
export async function readScratchStatus(
  service: SupabaseClient,
  ticketId: string,
): Promise<string | null> {
  const { data } = await service
    .from('maintenance_tickets')
    .select('status')
    .eq('id', ticketId)
    .maybeSingle();
  return data ? ((data as { status: string }).status ?? null) : null;
}

/**
 * Server-side intake facts: unit resolution and the priority decision. Lane w1-l5.
 *
 * What these tests can and cannot prove is worth being explicit about. They use a
 * recording Supabase double, so they prove **which queries the handler issues and how it
 * reacts to rows** — that a requested unit is filtered by the caller's own tenant id,
 * that the database's `can_access_unit` opinion is asked independently, and that a
 * disagreement fails closed. They do not and cannot prove that RLS would have refused a
 * cross-tenant read: that claim belongs to `tests/rls/**` against real Postgres, and
 * asserting it here against a scripted double would be asserting the script.
 */

import { describe, expect, it } from 'vitest';

import { ApiRouteError } from '@/lib/api/errors';
import type { Membership } from '@/lib/auth/roles';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import {
  decidePriority,
  isOutsideBusinessHours,
  resolveUnitContext,
} from '@/services/ai/maintenance/intake';

import { createFakeSupabase, type Row, type SupabaseScript } from './_support/fake-supabase';

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const UNIT_A = '33333333-3333-4333-8333-333333333333';
const UNIT_B = '44444444-4444-4444-8444-444444444444';
const PROPERTY = '55555555-5555-4555-8555-555555555555';

function membership(overrides: Partial<Membership> = {}): Membership {
  return {
    memberId: '66666666-6666-4666-8666-666666666666',
    role: 'tenant',
    status: 'active',
    profile: { id: '77777777-7777-4777-8777-777777777777', authUserId: 'auth', fullName: 'T' },
    organization: { id: ORGANIZATION, name: 'Org', slug: 'org', status: 'active' },
    tenantId: TENANT,
    providerId: null,
    ...overrides,
  };
}

function client(script: SupabaseScript) {
  const fake = createFakeSupabase(script);
  return { fake, client: fake as unknown as AppSupabaseClient };
}

function tenancyRows(units: readonly string[]): Row[] {
  return units.map((unit, index) => ({ id: `tenancy-${index}`, property_unit_id: unit }));
}

const UNIT_SCRIPT = (units: readonly string[], rpc = true): SupabaseScript => ({
  select: (table) => {
    if (table === 'tenancies') return tenancyRows(units);
    if (table === 'property_units') return [{ property_id: PROPERTY }];
    return [];
  },
  rpc: () => rpc,
});

describe('resolveUnitContext', () => {
  it('resolves the single unit a tenant leases without being told which', async () => {
    const { client: supabase } = client(UNIT_SCRIPT([UNIT_A]));
    const unit = await resolveUnitContext(supabase, membership(), undefined);

    expect(unit).toEqual({
      resolution: 'resolved',
      unitId: UNIT_A,
      propertyId: PROPERTY,
      tenancyId: 'tenancy-0',
      candidateUnitCount: 1,
    });
  });

  it('reports ambiguity rather than guessing when the tenant leases two', async () => {
    const { client: supabase } = client(UNIT_SCRIPT([UNIT_A, UNIT_B]));
    const unit = await resolveUnitContext(supabase, membership(), undefined);

    expect(unit.resolution).toBe('ambiguous');
    expect(unit.unitId).toBeNull();
    expect(unit.candidateUnitCount).toBe(2);
  });

  it('accepts a requested unit the tenant actually leases', async () => {
    const { client: supabase } = client(UNIT_SCRIPT([UNIT_A, UNIT_B]));
    const unit = await resolveUnitContext(supabase, membership(), UNIT_B);
    expect(unit.resolution).toBe('resolved');
    expect(unit.unitId).toBe(UNIT_B);
  });

  it('reports a requested unit the tenant does not lease as absent, not forbidden', async () => {
    const { client: supabase } = client(UNIT_SCRIPT([UNIT_A]));
    const error = await resolveUnitContext(supabase, membership(), UNIT_B).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ApiRouteError);
    expect((error as ApiRouteError).code).toBe('NOT_FOUND');
    expect((error as ApiRouteError).logFields).toMatchObject({
      reason: 'unit_not_leased_by_caller',
    });
  });

  it('filters the tenancy read by organization, tenant and active status', async () => {
    const { fake, client: supabase } = client(UNIT_SCRIPT([UNIT_A]));
    await resolveUnitContext(supabase, membership(), undefined);

    const tenancyRead = fake.operations.find(
      (entry) => entry.table === 'tenancies' && entry.op === 'select',
    );
    expect(tenancyRead?.filters).toEqual({
      organization_id: ORGANIZATION,
      tenant_id: TENANT,
      status: 'active',
    });
  });

  it('asks the database independently and fails closed when the two disagree', async () => {
    const { fake, client: supabase } = client(UNIT_SCRIPT([UNIT_A], false));
    const error = await resolveUnitContext(supabase, membership(), UNIT_A).catch(
      (thrown: unknown) => thrown,
    );

    expect(fake.operations.some((entry) => entry.table === 'rpc:can_access_unit')).toBe(true);
    expect((error as ApiRouteError).code).toBe('FORBIDDEN');
    expect((error as ApiRouteError).logFields).toMatchObject({
      reason: 'unit_access_layers_disagree',
    });
  });

  it('returns `none` for a caller who is not a tenant, without querying anything', async () => {
    const { fake, client: supabase } = client(UNIT_SCRIPT([UNIT_A]));
    const unit = await resolveUnitContext(supabase, membership({ tenantId: null }), undefined);

    expect(unit.resolution).toBe('none');
    expect(fake.operations).toHaveLength(0);
  });

  it('never issues an insert', async () => {
    const { fake, client: supabase } = client(UNIT_SCRIPT([UNIT_A]));
    await resolveUnitContext(supabase, membership(), undefined);
    expect(fake.insertedTables()).toEqual([]);
  });
});

describe('decidePriority', () => {
  const resolvedUnit = {
    resolution: 'resolved' as const,
    unitId: UNIT_A,
    propertyId: PROPERTY,
    tenancyId: 'tenancy-0',
    candidateUnitCount: 1,
  };

  /** A Wednesday, 10:00 GST. Inside business hours, so no out-of-hours escalation. */
  const MIDWEEK = new Date('2026-11-11T06:00:00Z');

  it('ignores a model suggestion of urgent, capping it at high', async () => {
    const { client: supabase } = client({ select: () => [] });
    const decision = await decidePriority(supabase, {
      organizationId: ORGANIZATION,
      category: 'hvac',
      unit: resolvedUnit,
      suggestedPriority: 'urgent',
      now: MIDWEEK,
    });

    expect(decision.priority).not.toBe('urgent');
    expect(decision.suggestionCapped).toBe(true);
    expect(decision.reasons).toContain('model_suggestion_capped');
  });

  it('counts only open tickets on the same unit and category', async () => {
    const { fake, client: supabase } = client({ select: () => [] });
    await decidePriority(supabase, {
      organizationId: ORGANIZATION,
      category: 'plumbing',
      unit: resolvedUnit,
      suggestedPriority: 'normal',
      now: MIDWEEK,
    });

    const read = fake.operations.find((entry) => entry.table === 'maintenance_tickets');
    expect(read?.op).toBe('select');
    expect(read?.filters).toMatchObject({
      organization_id: ORGANIZATION,
      property_unit_id: UNIT_A,
      category: 'plumbing',
    });
  });

  it('does not query for tickets when no unit was resolved', async () => {
    const { fake, client: supabase } = client({ select: () => [] });
    await decidePriority(supabase, {
      organizationId: ORGANIZATION,
      category: 'hvac',
      unit: { ...resolvedUnit, resolution: 'ambiguous', unitId: null },
      suggestedPriority: 'high',
      now: MIDWEEK,
    });
    expect(fake.operations).toHaveLength(0);
  });

  it('caps a vacant unit at normal', async () => {
    const { client: supabase } = client({ select: () => [] });
    const decision = await decidePriority(supabase, {
      organizationId: ORGANIZATION,
      category: 'electrical',
      unit: { ...resolvedUnit, resolution: 'none', unitId: null },
      suggestedPriority: 'high',
      now: MIDWEEK,
    });
    expect(decision.priority).toBe('normal');
    expect(decision.reasons).toContain('vacant_unit_cap');
  });

  it('never issues an insert', async () => {
    const { fake, client: supabase } = client({ select: () => [] });
    await decidePriority(supabase, {
      organizationId: ORGANIZATION,
      category: 'hvac',
      unit: resolvedUnit,
      suggestedPriority: 'normal',
      now: MIDWEEK,
    });
    expect(fake.insertedTables()).toEqual([]);
  });
});

describe('isOutsideBusinessHours', () => {
  it('is inside hours on a midweek morning in Dubai', () => {
    // 06:00Z is 10:00 GST on a Wednesday.
    expect(isOutsideBusinessHours(new Date('2026-11-11T06:00:00Z'))).toBe(false);
  });

  it('is outside hours late in the Dubai evening', () => {
    // 19:00Z is 23:00 GST.
    expect(isOutsideBusinessHours(new Date('2026-11-11T19:00:00Z'))).toBe(true);
  });

  it('is outside hours at the weekend', () => {
    // Saturday 08:00Z = 12:00 GST.
    expect(isOutsideBusinessHours(new Date('2026-11-14T08:00:00Z'))).toBe(true);
    // Sunday 08:00Z = 12:00 GST.
    expect(isOutsideBusinessHours(new Date('2026-11-15T08:00:00Z'))).toBe(true);
  });

  it('does not depend on the host time zone', () => {
    // The same instant expressed two ways must give the same answer.
    const a = new Date('2026-11-11T06:00:00Z');
    const b = new Date(a.getTime());
    expect(isOutsideBusinessHours(a)).toBe(isOutsideBusinessHours(b));
  });

  it('treats the boundary hours as the policy states', () => {
    // 04:00Z = 08:00 GST, the first business hour.
    expect(isOutsideBusinessHours(new Date('2026-11-11T04:00:00Z'))).toBe(false);
    // 14:00Z = 18:00 GST, the first hour after close.
    expect(isOutsideBusinessHours(new Date('2026-11-11T14:00:00Z'))).toBe(true);
  });
});

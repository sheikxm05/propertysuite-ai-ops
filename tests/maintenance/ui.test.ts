/**
 * The presentation layer's invariants — the ones that are claims rather than pixels.
 *
 * Nothing is rendered here. What is asserted is the three things about these files that
 * could be wrong in a way a screenshot would not reveal:
 *
 *  1. The nav entry and the widget are ENABLED, which is the lane's contract with
 *     w0-l1's registries — a feature lane flips its own flag when its route exists, and
 *     a lane that shipped routes with `enabled: false` would be invisible in the demo.
 *  2. The registries filter by role for PRESENTATION ONLY. Asserting that every role
 *     still sees the link is asserting that the sidebar is not where isolation lives:
 *     the row scope is `ticketListScope()` plus RLS, and a role removed from the list
 *     would still be able to call the API.
 *  3. The timeline's runtime status narrowing matches the shared enum. It reads a value
 *     out of a `jsonb` column, so the check has to be a runtime set — and a set that
 *     drifted from `TICKET_STATUSES` would silently stop rendering an edge.
 *
 * `@/lib/supabase/server` is mocked because `lib/env.ts` parses the browser-visible
 * configuration eagerly on import, and the live project's anon key is not available to
 * this lane. The mock is only there to let the widget module load; nothing in it is
 * exercised.
 */

import { describe, expect, it, vi } from 'vitest';

import { MEMBER_ROLES, TICKET_STATUSES } from '@shared/index';

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => ({}),
  createRouteHandlerClient: () => ({ supabase: {}, pendingCookies: [] }),
}));

import { NAV_REGISTRY, navForRole } from '@/config/nav.registry';
import { DASHBOARD_SLOTS, widgetsForRole } from '@/config/dashboard.slots';
import { navEntry } from '@/features/maintenance/nav';
import { renderedStatusValues } from '@/features/maintenance/components/activity-timeline';

describe('the sidebar entry', () => {
  it('is enabled now that /maintenance exists', () => {
    expect(navEntry.enabled).toBe(true);
    expect(navEntry.href).toBe('/maintenance');
  });

  it('keeps the slot w0-l1 reserved, so the sidebar does not reshuffle', () => {
    expect(navEntry.order).toBe(40);
    expect(navEntry.key).toBe('maintenance');
  });

  it('is reachable by all five roles — each lands on a different set of rows', () => {
    for (const role of MEMBER_ROLES) {
      expect(navForRole(role).map((entry) => entry.key)).toContain('maintenance');
    }
  });

  it('is registered exactly once', () => {
    expect(NAV_REGISTRY.filter((entry) => entry.key === 'maintenance')).toHaveLength(1);
  });
});

describe('the dashboard widget', () => {
  it('is enabled and visible to every role', async () => {
    const { widget } = await import('@/features/maintenance/widget');
    expect(widget.enabled).toBe(true);
    expect(widget.key).toBe('maintenance');
    expect(widget.order).toBe(40);
    for (const role of MEMBER_ROLES) {
      expect(widgetsForRole(role).map((slot) => slot.key)).toContain('maintenance');
    }
  });

  it('is registered exactly once', () => {
    expect(DASHBOARD_SLOTS.filter((slot) => slot.key === 'maintenance')).toHaveLength(1);
  });

  it('exposes a synchronous component, as config/types.ts requires', async () => {
    const { widget } = await import('@/features/maintenance/widget');
    expect(typeof widget.Component).toBe('function');
    // An async component would not satisfy `ComponentType`, and widening that type
    // would mean editing w0-l1's `config/types.ts`.
    expect(widget.Component.constructor.name).not.toBe('AsyncFunction');
  });
});

describe('the timeline renders every status the shared enum defines', () => {
  it('narrows jsonb metadata against exactly TICKET_STATUSES', () => {
    expect([...renderedStatusValues()].sort()).toEqual([...TICKET_STATUSES].sort());
  });
});

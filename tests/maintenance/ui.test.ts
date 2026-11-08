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

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { MEMBER_ROLES, TICKET_STATUSES } from '@shared/index';

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => ({}),
  createRouteHandlerClient: () => ({ supabase: {}, pendingCookies: [] }),
}));

import { NAV_REGISTRY, navForRole } from '@/config/nav.registry';
import { navEntry as aiIntakeNav } from '@/features/ai-intake/nav';
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

/**
 * Every enabled sidebar link that points into this lane's route group has a page.
 *
 * This is the A17 lesson generalised. `features/ai-intake/nav.ts` points at
 * `/maintenance/report`, which lives under `app/(dashboard)/maintenance/**` — w1-l4's
 * glob — so w1-l5 could ship an enabled nav entry whose target this lane had not created,
 * and the link 404'd for every tenant. The nav entry and the page are owned by different
 * lanes, which is exactly the kind of gap a green per-lane gate hides.
 *
 * Filesystem existence rather than a render: the page is an async server component that
 * resolves a session, so importing it proves nothing a 404 would not also allow.
 */
describe('no enabled nav link into /maintenance 404s', () => {
  const ROOT = resolve(__dirname, '..', '..');

  function pageExistsFor(href: string): boolean {
    const segments = href.replace(/^\//, '');
    return existsSync(resolve(ROOT, 'app', '(dashboard)', segments, 'page.tsx'));
  }

  const intoThisLane = NAV_REGISTRY.filter(
    (entry) =>
      entry.enabled && (entry.href === '/maintenance' || entry.href.startsWith('/maintenance/')),
  );

  it('finds the links it is supposed to be checking', () => {
    // A canary: if the registry stopped pointing anything at /maintenance, every
    // assertion below would pass vacuously.
    expect(intoThisLane.length).toBeGreaterThanOrEqual(2);
    expect(intoThisLane.map((entry) => entry.href)).toContain('/maintenance/report');
  });

  for (const entry of intoThisLane) {
    it(`${entry.key} -> ${entry.href} has a page`, () => {
      expect(pageExistsFor(entry.href)).toBe(true);
    });
  }
});

describe('the AI intake slot this lane hosts', () => {
  it('is tenant-only, which is what /maintenance/report gates on', () => {
    // §4 grants `ai_conversations` create to `tenant` alone. The page sends every other
    // role to /maintenance/new rather than rendering a panel that would be refused by a
    // Postgres policy on its first insert, so the page's gate must track this list.
    expect([...aiIntakeNav.roles]).toEqual(['tenant']);
  });

  it('still points at the slot this lane created', () => {
    expect(aiIntakeNav.href).toBe('/maintenance/report');
    expect(aiIntakeNav.enabled).toBe(true);
  });
});

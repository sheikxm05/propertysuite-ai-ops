import type { DashboardWidget, FeatureKey, RoleKey, WidgetChrome } from './types';

// One import per feature, same discipline as nav.registry.ts. Feature lanes replace
// only their own widget.tsx; W2-L5 composes these into the five role dashboards.
import { widget as organizations } from '@/features/organizations/widget';
import { widget as properties } from '@/features/properties/widget';
import { widget as tenancies } from '@/features/tenancies/widget';
import { widget as maintenance } from '@/features/maintenance/widget';
import { widget as aiIntake } from '@/features/ai-intake/widget';
import { widget as documents } from '@/features/documents/widget';

export const DASHBOARD_SLOTS: readonly DashboardWidget[] = [
  organizations,
  properties,
  tenancies,
  maintenance,
  aiIntake,
  documents,
];

/** Widgets a given role should see, in display order. Presentation only, as per nav. */
export function widgetsForRole(role: RoleKey): readonly DashboardWidget[] {
  return DASHBOARD_SLOTS.filter((w) => w.enabled && w.roles.includes(role)).sort(
    (a, b) => a.order - b.order,
  );
}

/**
 * Widgets that draw their own card.
 *
 * Wave 1 shipped without an agreed answer to "who draws the border", so three widgets
 * render a `<Card>` of their own and three render bare content and rely on the composer
 * for chrome. Composing them identically therefore produces either three borderless
 * tiles or three double-bordered ones.
 *
 * This set is the transitional bridge: it records the three that already own their
 * chrome, so Wave 2 can give all six the same shape without editing a feature file,
 * which this lane may not do. It is checked ONLY when the widget itself says nothing —
 * a feature lane that sets `chrome` on its own widget object wins, and that is the
 * intended migration. Once all six declare it, this set becomes dead and can be deleted.
 */
const SELF_CHROMED: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  'organizations',
  'properties',
  'ai-intake',
]);

/** Whether the dashboard should draw a titled card around this widget. */
export function widgetChrome(widget: DashboardWidget): WidgetChrome {
  return widget.chrome ?? (SELF_CHROMED.has(widget.key) ? 'none' : 'card');
}

export interface DashboardIntro {
  readonly headline: string;
  readonly summary: string;
}

/**
 * What each role's dashboard is FOR, in one sentence.
 *
 * Five roles, five different jobs, and the same grid of tiles reads as five different
 * products once it is framed correctly: an admin is watching an organization, an owner
 * is watching an asset, a tenant is reporting a problem, a provider is working a queue.
 * Keys are `MEMBER_ROLES` values from `packages/shared` — the registry types roles as
 * plain strings on purpose (see `config/types.ts`), so this map is deliberately total
 * over the five and falls back rather than throwing.
 */
const ROLE_INTRO: Readonly<Record<string, DashboardIntro>> = Object.freeze({
  organization_admin: {
    headline: 'Operations overview',
    summary:
      'Everything inside this organization: members, portfolio, tenancies, maintenance load and the documents still waiting on a human decision.',
  },
  property_manager: {
    headline: 'Today in the portfolio',
    summary:
      'The properties you manage, the renewals coming up, the maintenance queue and the extractions that still need verifying.',
  },
  property_owner: {
    headline: 'Your assets',
    summary:
      'Read-only visibility of the properties you own, their occupancy and the maintenance activity against them.',
  },
  tenant: {
    headline: 'Your home',
    summary:
      'Your tenancy, your reported issues, and a way to report a new one. You see only your own records — never another tenant’s.',
  },
  service_provider: {
    headline: 'Your assigned work',
    summary:
      'Only the jobs assigned to you. Tickets you are not assigned to are invisible here and refused by the database if requested directly.',
  },
});

const FALLBACK_INTRO: DashboardIntro = Object.freeze({
  headline: 'Dashboard',
  summary: 'Sections appear here according to what this role is authorized to see.',
});

export function dashboardIntroFor(role: RoleKey): DashboardIntro {
  return ROLE_INTRO[role] ?? FALLBACK_INTRO;
}

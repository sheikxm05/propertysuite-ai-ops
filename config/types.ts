import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Contracts for the two registries that would otherwise be merge points for six
 * parallel agents. Each feature lane owns exactly one `features/<key>/nav.ts` and one
 * `features/<key>/widget.tsx`, and NEVER edits `config/*` — see
 * docs/parallel-execution-plan.md §0 mechanism 3.
 *
 * WHY `roles` IS `readonly string[]` AND NOT THE MemberRole UNION
 * --------------------------------------------------------------
 * `MemberRole` lives in packages/shared, owned by lane w0-l4. This scaffold lane must
 * compile with zero dependency on another lane's output, so the registry widens the
 * type here rather than importing it or — forbidden by CLAUDE.md rule 4 — declaring a
 * second copy of the union.
 *
 * Role VALUES must still come from `MEMBER_ROLES` in packages/shared. Narrow typing is
 * enforced at the single point where it matters: lib/auth/roles.ts resolves the
 * caller's role as a true `MemberRole`, and the shell compares that against these
 * strings. Never hand-write a role literal in a feature's nav.ts.
 */
export type RoleKey = string;

export const FEATURE_KEYS = [
  'organizations',
  'properties',
  'tenancies',
  'maintenance',
  'ai-intake',
  'documents',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface NavEntry {
  /** Must equal the owning feature's directory name. */
  readonly key: FeatureKey;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /** Roles that may see this item. Values from MEMBER_ROLES. */
  readonly roles: readonly RoleKey[];
  /** Ascending sidebar position. Stubs reserve the slot; lanes keep the number. */
  readonly order: number;
  /**
   * Stubs ship `false` so the shell renders nothing in Wave 0. The owning feature lane
   * flips it to `true` when the route exists, which is what makes the sidebar light up
   * incrementally as lanes land instead of linking to 404s.
   */
  readonly enabled: boolean;
}

export interface DashboardWidgetProps {
  /** The caller's resolved role, passed down by the dashboard shell. */
  readonly role: RoleKey;
}

export interface DashboardWidget {
  readonly key: FeatureKey;
  readonly title: string;
  readonly roles: readonly RoleKey[];
  /** Grid columns on large screens. */
  readonly span: 1 | 2 | 3;
  readonly order: number;
  readonly enabled: boolean;
  readonly Component: ComponentType<DashboardWidgetProps>;
}

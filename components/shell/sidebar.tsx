'use client';

import { Brand, NavItems, OrganizationBadge } from './nav';

export interface SidebarProps {
  /**
   * The caller's resolved role, or null before a session exists. Resolved server-side
   * in app/(dashboard)/layout.tsx — never read from a cookie or query parameter here.
   */
  role: string | null;
  organizationName?: string | null;
}

/**
 * The desktop navigation rail.
 *
 * Deliberately `hidden md:flex`: below `md` the same entries are rendered by
 * `MobileNav` inside a sheet, from the same registry via the same `NavItems`. One source
 * of nav truth, two presentations — see `components/shell/nav.tsx`.
 */
export function Sidebar({ role, organizationName }: SidebarProps) {
  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r bg-card md:flex">
      <div className="flex h-14 items-center border-b px-4">
        <Brand />
      </div>

      {organizationName ? (
        <div className="p-3 pb-0">
          <OrganizationBadge name={organizationName} />
        </div>
      ) : null}

      <nav aria-label="Main" className="flex-1 overflow-y-auto p-3">
        <NavItems role={role} />
      </nav>

      <div className="border-t p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Links are presentation only. Every route re-checks authorization server-side and row-level
          security denies independently.
        </p>
      </div>
    </aside>
  );
}

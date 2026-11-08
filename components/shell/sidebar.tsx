'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { navForRole } from '@/config/nav.registry';
import { cn } from '@/components/ui/utils';

export interface SidebarProps {
  /**
   * The caller's resolved role, or null before a session exists. Resolved server-side
   * in app/(dashboard)/layout.tsx — never read from a cookie or query parameter here.
   */
  role: string | null;
  organizationName?: string | null;
}

export function Sidebar({ role, organizationName }: SidebarProps) {
  const pathname = usePathname();
  const items = role ? navForRole(role) : [];

  return (
    <aside className="hidden w-60 shrink-0 border-r bg-card md:flex md:flex-col">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
        <span className="truncate text-sm font-semibold">PropertySuite AI Ops</span>
      </div>

      {organizationName ? (
        <div className="border-b px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Organization</p>
          <p className="truncate text-sm font-medium">{organizationName}</p>
        </div>
      ) : null}

      <nav aria-label="Main" className="flex-1 space-y-1 p-2">
        {items.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            {role ? 'No sections available.' : 'Not signed in.'}
          </p>
        ) : (
          items.map(({ key, href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={key}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </Link>
            );
          })
        )}
      </nav>

      <div className="border-t p-3">
        <p className="text-xs text-muted-foreground">
          Links are presentation only. Every route re-checks authorization server-side.
        </p>
      </div>
    </aside>
  );
}

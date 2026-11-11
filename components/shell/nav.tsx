'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';

import { navForRole } from '@/config/nav.registry';
import { cn } from '@/components/ui/utils';

/**
 * The navigation, as data turned into markup exactly once.
 *
 * `config/nav.registry.ts` is the single source of nav truth — one entry per feature,
 * contributed by the owning lane, filtered by role. This module is the single
 * *presentation* of that truth, and the sidebar and the mobile sheet both render it.
 * Two components building their own list from the same registry is how a desktop nav and
 * a mobile nav drift apart by one item and nobody notices for a month.
 *
 * Role filtering here is presentation only. It hides links a role cannot use; it is not
 * authorization. Every route re-checks server-side via `withApiHandler`, and Postgres RLS
 * denies independently — see `navForRole`'s own note.
 */

export interface NavProps {
  /** Resolved server-side in the dashboard layout. Never read from the client. */
  readonly role: string | null;
  /** Called after a link is activated — the mobile sheet uses it to close itself. */
  readonly onNavigate?: () => void;
  readonly className?: string;
}

export function NavItems({ role, onNavigate, className }: NavProps) {
  const pathname = usePathname();
  const items = role ? navForRole(role) : [];

  if (items.length === 0) {
    return (
      <p className={cn('px-3 py-2 text-sm text-muted-foreground', className)}>
        {role ? 'No sections are available for this role.' : 'Not signed in.'}
      </p>
    );
  }

  return (
    <ul className={cn('space-y-0.5', className)}>
      {items.map(({ key, href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <li key={key}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-accent font-semibold text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground',
              )}
            >
              {/* The active marker is a shape as well as a colour, so the current
                  section is still identifiable without colour perception. */}
              <span
                aria-hidden="true"
                className={cn(
                  'absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary transition-opacity',
                  active ? 'opacity-100' : 'opacity-0',
                )}
              />
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** The product mark. Shared so the sidebar, the mobile sheet and the top bar agree. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <ShieldCheck className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold leading-tight">PropertySuite</span>
        <span className="block truncate text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
          AI Operations
        </span>
      </span>
    </span>
  );
}

/** The organization strip. Which tenant you are inside is the product's whole claim. */
export function OrganizationBadge({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return (
    <div className="min-w-0 rounded-md border bg-muted/50 px-3 py-2">
      <p className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground">
        Organization
      </p>
      <p className="truncate text-sm font-medium">{name}</p>
    </div>
  );
}

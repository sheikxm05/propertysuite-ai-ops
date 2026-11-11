'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/components/ui/utils';
import { MEMBER_ROLE_LABELS, isMemberRole } from '@shared/index';

import { ThemeChoice } from './theme-toggle';

export interface AccountMenuProps {
  /** Resolved server-side from trusted rows. Never read from the client. */
  readonly role: string | null;
  readonly displayName?: string | null;
  readonly email?: string | null;
  readonly organizationName?: string | null;
  /**
   * Account-level actions the shell cannot own — in practice the sign-out control.
   *
   * It is a slot rather than a built-in because signing out is a session operation that
   * belongs to the identity feature (`features/organizations`), and
   * `components/shell/**` is a presentation layer with no business importing a server
   * action. The dashboard layout passes its `<SignOutButton />` in here; see the lane
   * report for the exact change the owning lane needs to make.
   */
  readonly accountActions?: React.ReactNode;
}

/** Up to two initials. Falls back to a neutral glyph rather than rendering nothing. */
function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '');
  return parts.join('') || '?';
}

function roleLabel(role: string | null): string | null {
  if (!role) return null;
  // Labels come from packages/shared. A second copy in the shell would be exactly the
  // local duplicate of a shared constant that CLAUDE.md rule 4 forbids.
  return isMemberRole(role) ? MEMBER_ROLE_LABELS[role] : role;
}

/**
 * Who you are, which organization you are inside, which role you hold, how the app looks,
 * and how to leave. One control, in the place every product puts it.
 *
 * Showing the organization and the role here is not decoration: the entire demo claim is
 * that what you can see depends on which tenant and which role you are, so the answer to
 * "who am I right now" has to be one click away on every screen.
 */
export function AccountMenu({
  role,
  displayName,
  email,
  organizationName,
  accountActions,
}: AccountMenuProps) {
  const name = displayName ?? 'Not signed in';
  const label = roleLabel(role);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex max-w-[14rem] items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-2.5 text-left transition-colors',
            'hover:bg-accent hover:text-accent-foreground',
          )}
          aria-label={`Account menu for ${name}`}
        >
          <Avatar className="size-7">
            <AvatarFallback className="bg-primary text-[0.625rem] text-primary-foreground">
              {initials(displayName)}
            </AvatarFallback>
          </Avatar>
          <span className="hidden min-w-0 flex-col leading-tight sm:flex">
            <span className="truncate text-xs font-medium">{name}</span>
            {label ? (
              <span className="truncate text-[0.6875rem] text-muted-foreground">{label}</span>
            ) : null}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-semibold">{name}</span>
          {email && email !== displayName ? (
            <span className="block truncate text-xs text-muted-foreground">{email}</span>
          ) : null}
        </DropdownMenuLabel>

        {label || organizationName ? (
          <>
            <DropdownMenuSeparator />
            <div className="space-y-2 px-2 py-1.5">
              {organizationName ? (
                <div>
                  <p className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground">
                    Organization
                  </p>
                  <p className="truncate text-sm">{organizationName}</p>
                </div>
              ) : null}
              {label ? <Badge variant="secondary">{label}</Badge> : null}
            </div>
          </>
        ) : null}

        <DropdownMenuSeparator />
        <ThemeChoice />

        {accountActions ? (
          <>
            <DropdownMenuSeparator />
            <div className="p-1 [&>*]:w-full">{accountActions}</div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

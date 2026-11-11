'use client';

import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { MEMBER_ROLE_LABELS, isMemberRole } from '@shared/index';

import { AccountMenu } from './account-menu';
import { Brand } from './nav';
import { MobileNav } from './mobile-nav';
import { ThemeToggle } from './theme-toggle';

export interface TopbarProps {
  role: string | null;
  displayName?: string | null;
  /** The verified session email, when the profile has no name yet. */
  email?: string | null;
  /** Shown in the mobile sheet and the account menu. */
  organizationName?: string | null;
  /**
   * Account-level controls the shell cannot own — the sign-out button in practice.
   * Rendered at the foot of the account menu. See `AccountMenu` for why it is a slot.
   */
  accountActions?: React.ReactNode;
}

export function Topbar({
  role,
  displayName,
  email,
  organizationName,
  accountActions,
}: TopbarProps) {
  const label = role && isMemberRole(role) ? MEMBER_ROLE_LABELS[role] : role;

  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="page-gutter mx-auto flex h-14 w-full max-w-[var(--content-max)] items-center gap-2">
        <MobileNav role={role} organizationName={organizationName} />

        {/* The rail carries the mark on desktop; below `md` the top bar does. */}
        <Brand className="md:hidden" />

        <div className="ml-auto flex items-center gap-2">
          {/* The visible role is a cue for the demo: it makes each role boundary legible
              on screen, which is how the isolation story gets told. */}
          {label ? (
            <Badge variant="secondary" className="hidden lg:inline-flex">
              {label}
            </Badge>
          ) : null}
          <ThemeToggle />
          <AccountMenu
            role={role}
            displayName={displayName}
            email={email}
            organizationName={organizationName}
            accountActions={accountActions}
          />
        </div>
      </div>
    </header>
  );
}

'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

import { Brand, NavItems, OrganizationBadge } from './nav';

export interface MobileNavProps {
  role: string | null;
  organizationName?: string | null;
}

/**
 * Navigation below `md`, where the sidebar is hidden.
 *
 * Before this existed there was no way to reach any section on a phone at all: the rail
 * is `hidden md:flex` and nothing replaced it. The sheet primitive was already built and
 * unused — this is what it was built for.
 *
 * It renders `NavItems` from `config/nav.registry.ts`, the same component the sidebar
 * renders, so the two can never disagree about what a role may see. Closing on
 * navigation is handled by watching the pathname rather than by the link's own click
 * handler, so a back-button navigation closes it too.
 */
export function MobileNav({ role, organizationName }: MobileNavProps) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();

  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Open navigation"
        >
          <Menu aria-hidden="true" />
        </Button>
      </SheetTrigger>

      <SheetContent side="left" className="flex w-[17rem] flex-col gap-0 p-0">
        <SheetHeader className="border-b p-4 text-left">
          <SheetTitle asChild>
            <span>
              <Brand />
            </span>
          </SheetTitle>
          <SheetDescription className="sr-only">
            Sections available to your role. Hiding a link is presentation, not authorization.
          </SheetDescription>
        </SheetHeader>

        {organizationName ? (
          <div className="p-3 pb-0">
            <OrganizationBadge name={organizationName} />
          </div>
        ) : null}

        <nav aria-label="Main" className="flex-1 overflow-y-auto p-3">
          <NavItems role={role} onNavigate={() => setOpen(false)} />
        </nav>
      </SheetContent>
    </Sheet>
  );
}

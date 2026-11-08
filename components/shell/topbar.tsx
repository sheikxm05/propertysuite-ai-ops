'use client';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';

const ROLE_LABELS: Record<string, string> = {
  organization_admin: 'Organization admin',
  property_manager: 'Property manager',
  property_owner: 'Property owner',
  tenant: 'Tenant',
  service_provider: 'Service provider',
};

export interface TopbarProps {
  role: string | null;
  displayName?: string | null;
}

function initials(name: string | null | undefined) {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function Topbar({ role, displayName }: TopbarProps) {
  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b bg-background px-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{displayName ?? 'Not signed in'}</p>
      </div>

      <div className="flex items-center gap-3">
        {/* The visible role is a cue for the demo: it makes each role boundary legible
            on screen, which is how the isolation story gets told. */}
        {role ? <Badge variant="secondary">{ROLE_LABELS[role] ?? role}</Badge> : null}
        <Avatar>
          <AvatarFallback>{initials(displayName)}</AvatarFallback>
        </Avatar>
      </div>
    </header>
  );
}

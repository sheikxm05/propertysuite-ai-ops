import { Bot } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * The multi-step agent, and the human approval gate in front of it.
 *
 * Staff only, and that is enforced three times over: this link, `STAFF_ROLES` on the run
 * route, and `is_org_staff()` inside `approve_agent_proposal`. A tenant reports an issue
 * through `/maintenance/report`, which is the draft-then-confirm flow built for them.
 */
export const navEntry: NavEntry = {
  key: 'ai-agent',
  label: 'Assistant',
  href: '/assistant',
  icon: Bot,
  roles: ['organization_admin', 'property_manager'],
  order: 75,
  enabled: true,
};

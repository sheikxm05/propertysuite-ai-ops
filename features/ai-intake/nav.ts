import { MessageSquarePlus } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * AI maintenance intake navigation. Lane w1-l5 — replaces the w0-l1 stub.
 *
 * `enabled` is now `true`: the two routes behind this entry point exist
 * (`/api/v1/ai/maintenance/classify` and `/confirm`) and the review panel is shipped as
 * `features/ai-intake/report-issue-panel.tsx`.
 *
 * TWO DELIBERATE CHANGES FROM THE STUB
 * ------------------------------------
 * 1. `roles` is now `['tenant']`, not `['tenant', 'property_manager']`.
 *    `docs/implementation-plan.md` §4 grants `ai_conversations` / `ai_messages`
 *    create-and-read to `tenant` alone; a manager has read only. A manager following this
 *    link would authenticate, pass the coarse role gate if it still named them, and then
 *    be refused by a Postgres policy on the first conversation insert. Showing a link
 *    that cannot work is worse than not showing it: staff create tickets directly through
 *    the maintenance surface, which is w1-l4's.
 * 2. `href` is unchanged at `/maintenance/report`, the slot the stub reserved. That page
 *    lives under `app/(dashboard)/maintenance/**`, which lane w1-l4 owns, so this lane
 *    cannot create it — reported as a planning defect. The panel component is exported
 *    from `features/ai-intake/index.ts` ready to be mounted there.
 *
 * `key`, `order` and `icon` are unchanged, because `config/navigation.ts` imports this
 * module by path and sorts on `order`.
 */
export const navEntry: NavEntry = {
  key: 'ai-intake',
  label: 'Report an issue',
  href: '/maintenance/report',
  icon: MessageSquarePlus,
  roles: ['tenant'],
  order: 50,
  enabled: true,
};

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { DashboardWidget, DashboardWidgetProps } from '@/config/types';

import { ReportIssuePanel } from './report-issue-panel';

/**
 * The "report an issue" dashboard widget. Lane w1-l5 — replaces the w0-l1 stub, which
 * rendered `null` with `enabled: false`.
 *
 * It mounts the real panel in `compact` mode rather than linking away, because the whole
 * flow is two requests and a text box: a tenant seeing "my AC is broken" on their
 * dashboard should be able to say so there. The panel is a client component; this file is
 * a plain server component wrapper, which is why the card chrome lives here and not
 * inside the client bundle.
 *
 * It takes no scope from `props`. There is nothing to scope: the panel sends a message
 * and the server resolves the caller's unit from the session (CLAUDE.md rule 5). A widget
 * that passed a unit id down from a prop would be one prop away from drafting against
 * somebody else's tenancy.
 *
 * `roles` is `['tenant']`, matching `nav.ts` and §4's matrix — `ai_conversations` create
 * is granted to `tenant` alone, so the widget would not function for anyone else.
 * `key`, `span` and `order` are unchanged from the stub, because
 * `config/dashboard.slots.ts` imports this module by path and sorts on `order`.
 */
function AiIntakeWidget(_props: DashboardWidgetProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Report an issue</CardTitle>
        <CardDescription>
          Describe the problem. You will see a draft summary and submit it yourself — nothing is
          created until you do.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ReportIssuePanel compact />
      </CardContent>
    </Card>
  );
}

export const widget: DashboardWidget = {
  key: 'ai-intake',
  title: 'Report an issue',
  roles: ['tenant'],
  span: 1,
  order: 50,
  enabled: true,
  Component: AiIntakeWidget,
};

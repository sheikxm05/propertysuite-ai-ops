/**
 * `/inbox` — where the demo opens.
 *
 * The screen has to carry the whole story in one glance: a message arrived, we know (or
 * do not know) who sent it, the assistant has or has not read it, and a human has or has
 * not turned it into a ticket. Everything on the page is in service of that sentence.
 *
 * Three audiences, one query. Staff see their organization's inbound queue; a tenant
 * sees messages from their own number; an owner and a provider see nothing and are told
 * why. The role never branches the query — `listMessages()` applies `audienceFor()` and
 * RLS applies the matching policies, so the difference between those screens is entirely
 * in the rows that come back.
 *
 * Rendered on every request. A tenant-scoped page must never be served from a shared
 * cache, and the dynamic `searchParams` read is what guarantees it.
 */

import Link from 'next/link';
import { Inbox, MailQuestion, ShieldCheck } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  ListInboxQuerySchema,
  audienceFor,
  inboxContextFrom,
  listMessages,
  senderDirectory,
  tenantDirectory,
  toMessageView,
} from '@/features/inbox/domain';
import { MessageTable } from '@/features/inbox/components/message-table';
import { SimulateComposer } from '@/features/inbox/components/simulate-composer';
import { inboxPageContext } from '@/features/inbox/server-context';

export const metadata = { title: 'Inbox' };

/** Next 15 passes `searchParams` as a promise. */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function InboxPage({ searchParams }: { searchParams: SearchParams }) {
  const { supabase, membership, logger } = await inboxPageContext();

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Inbox" />
        <EmptyState
          icon={Inbox}
          title="No organization yet"
          description="You are not an active member of an organization, so there is no inbound queue to show. Redeem an invitation and it appears here."
          action={
            <Button asChild variant="outline">
              <Link href="/organization/accept">Redeem an invitation</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const audience = audienceFor(membership.role);

  if (audience === 'none') {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Inbox"
          description="Inbound tenant messages, before they become anything."
        />
        <EmptyState
          icon={ShieldCheck}
          title="This queue is not part of your role"
          description="An inbound message is a conversation with a tenant. An owner sees the assets they own and a provider sees the jobs assigned to them; neither is a party to the message that precedes a ticket. Nothing is being hidden from a list you can otherwise reach — there is no row here for this account at all."
        />
      </div>
    );
  }

  // Parsed with the SAME schema the API route uses, so a malformed cursor or an
  // out-of-range limit is rejected identically on the page and on the endpoint.
  const raw = await searchParams;
  const parsed = ListInboxQuerySchema.safeParse(flatten(raw));
  const query = parsed.success ? parsed.data : ListInboxQuerySchema.parse({});

  const context = inboxContextFrom({ supabase, membership, logger });
  const [page, directory, tenants] = await Promise.all([
    listMessages(context, query),
    senderDirectory(context),
    tenantDirectory(context),
  ]);

  const messages = page.items.map((row) => toMessageView(row, directory));
  const unmatched = messages.filter((message) => !message.sender.matched).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inbox"
        description={
          audience === 'organization'
            ? 'Every inbound message in your organization, newest first. A message is a message until a person decides otherwise — nothing here has changed any state yet.'
            : 'Messages you have sent to the business WhatsApp number. The inbound queue itself is an operations surface — migration 0004 grants SELECT on it to organization staff only — so what you can reach here is your own traffic and nothing else.'
        }
        actions={
          <Button asChild variant="outline">
            <Link href="/maintenance">Maintenance queue</Link>
          </Button>
        }
      />

      {/* The simulator sits above the list, because during a recording it is the first
          thing anyone touches and the list is what it changes. */}
      <SimulateComposer
        tenants={tenants.map((tenant) => ({
          id: tenant.id,
          label: tenant.unit ? `${tenant.fullName} — ${tenant.unit.label}` : tenant.fullName,
          reachable: Boolean(tenant.phone),
        }))}
        canUseArbitrarySender={audience === 'organization'}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Inbound queue
            {unmatched > 0 ? (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {unmatched} of {messages.length} from a number we cannot place
              </span>
            ) : null}
          </CardTitle>
          <CardDescription>
            A row shaded grey came from a number that resolves to no tenant you can see — no tenant
            to show, no unit to infer, and no ticket that could be raised without a person choosing
            one. A message whose sender resolves to <em>nobody at all</em> never reaches this list:
            it is stored with no organization, and the read policy requires one, so it is visible to
            no organization including this one. The simulator above reports that outcome directly,
            because a boundary you cannot see is indistinguishable from a bug.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MessageTable
            messages={messages}
            empty={
              <EmptyState
                icon={MailQuestion}
                title="Nothing has arrived yet"
                description={
                  audience === 'organization'
                    ? 'When a tenant messages the business WhatsApp number it lands here first, untouched. Use the simulator above to put one through the same pipeline now.'
                    : 'The inbound queue is read by the operations team. When one of your messages becomes a maintenance ticket, that ticket appears under Maintenance — which is the surface built for you.'
                }
              />
            }
          />
        </CardContent>
      </Card>

      {page.hasMore && page.nextCursor ? (
        <div className="flex justify-end">
          <Button asChild variant="secondary">
            <Link href={`/inbox?cursor=${encodeURIComponent(page.nextCursor)}`}>Next page</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** `searchParams` may repeat a key; the schema takes it as the API wrapper does. */
function flatten(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * `/inbox/{messageId}` — one message, and what a human can do about it.
 *
 * The page is a server component and reads everything through the caller's own
 * credentials. `readMessage()` returns `null` for a row that does not exist, a row in
 * another organization and a row a tenant did not send; all three become the same 404,
 * for the same reason the frozen envelope phrases `NOT_FOUND` and `FORBIDDEN` alike.
 *
 * The layout follows the decision being made, top to bottom: what was said, who said it
 * (or that we cannot tell), then the controls. The controls are a client component
 * because they are a conversation with the server; everything above them is static
 * markup rendered once.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MessageSquare, UserX } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { UuidSchema } from '@shared/index';
import { ChannelBadge, MessageStatusBadge } from '@/features/inbox/components/badges';
import { MessageWorkbench } from '@/features/inbox/components/message-workbench';
import {
  audienceFor,
  formatReceivedAt,
  inboxContextFrom,
  mayCommitTicket,
  organizationUnits,
  readMessage,
  senderDirectory,
  toMessageDetailView,
} from '@/features/inbox/domain';
import { inboxPageContext } from '@/features/inbox/server-context';

export const metadata = { title: 'Inbound message' };

type Params = Promise<{ messageId: string }>;

export default async function InboxMessagePage({ params }: { params: Params }) {
  const { supabase, membership, logger } = await inboxPageContext();
  const { messageId } = await params;

  if (!membership || audienceFor(membership.role) === 'none') notFound();

  const id = UuidSchema.safeParse(messageId);
  if (!id.success) notFound();

  const context = inboxContextFrom({ supabase, membership, logger });
  const row = await readMessage(context, id.data);
  if (!row) notFound();

  const directory = await senderDirectory(context);
  const message = toMessageDetailView(row, directory);
  const units = await organizationUnits(context);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Inbound message"
        title={
          message.sender.matched ? (message.sender.tenantName ?? 'Known sender') : 'Unknown sender'
        }
        description={
          message.sender.matched
            ? 'The sender resolved to a tenant in your organization, so the unit and the tenancy came with them.'
            : 'No tenant in this organization has this number. Nothing is hidden from you here — there is no match to show, which is what a correct boundary looks like from the inside.'
        }
        actions={
          <Button asChild variant="outline">
            <Link href="/inbox">Back to the inbox</Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">What was said</CardTitle>
            <ChannelBadge channel={message.channel} />
            <MessageStatusBadge status={message.status} />
          </div>
          <CardDescription>
            Received {formatReceivedAt(message.receivedAt)} from{' '}
            <span className="font-mono">{message.from}</span>. Stored exactly as it arrived and
            never written to a log.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <blockquote className="whitespace-pre-wrap rounded-md border-l-2 bg-muted/40 p-4 text-sm">
            {message.body || 'This message carried no text.'}
          </blockquote>

          <Separator />

          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Tenant
              </dt>
              <dd>
                {message.sender.matched ? (
                  message.sender.tenantName
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <UserX className="size-3.5" aria-hidden="true" />
                    Not resolved
                  </span>
                )}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Unit
              </dt>
              <dd>
                {message.sender.unitLabel ?? (
                  <span className="text-muted-foreground">No single active tenancy</span>
                )}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Provider message id
              </dt>
              <dd className="break-all font-mono text-xs text-muted-foreground">
                {message.externalMessageId}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {!message.sender.matched ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <MessageSquare className="size-4" aria-hidden="true" />
              <CardTitle className="text-base">Why there is no tenant here</CardTitle>
            </div>
            <CardDescription>
              Resolution happens against the tenants you are entitled to read. A number that matches
              none of them resolves to nothing — and it would resolve to nothing even if that number
              belonged to a tenant of another organization, because that row is not reachable from
              this account. The assistant can still read the message; a ticket still needs a person
              to choose the unit.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <MessageWorkbench
        messageId={message.id}
        ticketId={message.ticketId}
        canClassify={true}
        canCommit={mayCommitTicket(membership.role)}
        units={units}
        suggestedUnitId={message.sender.unitId}
      />
    </div>
  );
}

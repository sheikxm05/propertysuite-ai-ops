/**
 * The inbound queue, as a table.
 *
 * A server component. The rows that arrive are already scoped — `audienceFor()` built
 * the query and RLS answered it — so this file contains no filtering of any kind. A
 * table that hid a row by role would invite the mistake of relying on it.
 *
 * The column set is the same for everyone. What an unmatched sender looks like is the
 * one piece of visual emphasis in here, and it is deliberate: the row is tinted with
 * `bg-muted/40` and carries an explicit chip, because a reviewer watching the recording
 * needs to see at a glance that the system declined to guess. Muted, not red. Nothing
 * failed.
 *
 * Below `sm` the channel and timestamp columns fold away and the snippet keeps the row
 * readable; the table's own wrapper scrolls rather than overflowing the viewport.
 */

import * as React from 'react';
import Link from 'next/link';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { formatReceivedAt, type InboxMessageView } from '../domain/view';
import { ChannelBadge, MessageStatusBadge, SenderBadge } from './badges';

export interface MessageTableProps {
  readonly messages: readonly InboxMessageView[];
  /** Rendered when the page is empty. The page composes the whole state. */
  readonly empty: React.ReactNode;
}

export function MessageTable({ messages, empty }: MessageTableProps) {
  if (messages.length === 0) return <>{empty}</>;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>From</TableHead>
          <TableHead>Message</TableHead>
          <TableHead className="hidden sm:table-cell">Channel</TableHead>
          <TableHead>Status</TableHead>
          <TableHead numeric className="hidden md:table-cell">
            Received
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {messages.map((message) => (
          <TableRow key={message.id} className={message.sender.matched ? undefined : 'bg-muted/40'}>
            <TableCell className="align-top">
              <div className="space-y-1">
                <SenderBadge sender={message.sender} />
                <p className="font-mono text-xs text-muted-foreground">{message.fromMasked}</p>
                {message.sender.unitLabel ? (
                  <p className="text-xs text-muted-foreground">{message.sender.unitLabel}</p>
                ) : null}
              </div>
            </TableCell>

            <TableCell className="max-w-[32rem] align-top">
              <Link
                href={`/inbox/${message.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {message.snippet || 'No message text'}
              </Link>
              {message.ticketId ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Committed as{' '}
                  <Link
                    href={`/maintenance/${message.ticketId}`}
                    className="underline underline-offset-4"
                  >
                    a maintenance ticket
                  </Link>
                  .
                </p>
              ) : null}
            </TableCell>

            <TableCell className="hidden align-top sm:table-cell">
              <ChannelBadge channel={message.channel} />
            </TableCell>

            <TableCell className="align-top">
              <MessageStatusBadge status={message.status} />
            </TableCell>

            <TableCell numeric className="hidden align-top md:table-cell">
              <span className="text-xs text-muted-foreground">
                {formatReceivedAt(message.receivedAt)}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

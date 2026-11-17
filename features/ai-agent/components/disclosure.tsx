'use client';

/**
 * "Show me what it actually said."
 *
 * Two small pieces used by both the tool trace and the approval card, kept together
 * because they encode one decision: **the raw payload is always available and never the
 * first thing you read.** A screen that only showed prose would be asking you to trust
 * the prose; a screen that only showed JSON would not be readable by the person whose
 * job it is to approve. So every summary on this surface has an expandable original
 * underneath it, and the original is rendered verbatim — no re-ordering, no pretty
 * renaming, no omissions.
 *
 * `<pre>` scrolls in both axes rather than wrapping, which is what keeps a long
 * description or a deep object from blowing the card out on a phone.
 */

import * as React from 'react';
import { ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';

export interface DisclosureProps {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly defaultOpen?: boolean;
  readonly className?: string;
}

export function Disclosure({ label, children, defaultOpen = false, className }: DisclosureProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const panelId = React.useId();

  return (
    <div className={className}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="-ml-2 h-7 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn('transition-transform duration-150', open && 'rotate-90')}
          aria-hidden="true"
        />
        {label}
      </Button>
      {open ? (
        <div id={panelId} className="pt-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface RawJsonProps {
  readonly value: unknown;
  /** Announced to a screen reader, since the block itself is a wall of punctuation. */
  readonly label: string;
}

/** The payload, unaltered. */
export function RawJson({ value, label }: RawJsonProps) {
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground"
    >
      <code>{stringify(value)}</code>
    </pre>
  );
}

/**
 * `JSON.stringify` with the two failure modes handled: a cyclic object (which throws)
 * and `undefined` (which returns `undefined`, not a string). Neither should blank a card.
 */
function stringify(value: unknown): string {
  if (value === undefined) return 'null';
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return '/* this value could not be displayed */';
  }
}

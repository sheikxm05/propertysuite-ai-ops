/**
 * Unit tests for the acknowledgement text and its reference.
 *
 * These cover the half of the feature that can be tested without a database or a
 * credential: the string that is actually sent to a human being. The assertions are
 * mostly *negative* on purpose — the security property here is not "the sentence reads
 * well", it is "the sentence cannot contain tenant data", and the way that is proven is
 * by showing the function has no way to learn any.
 *
 * The send path itself (`server-only/acknowledgement.ts`) imports `server-only`, whose
 * `index.js` throws outside a React Server Component resolution, so it cannot be
 * imported under Vitest's node environment. Covering it needs an alias in
 * `vitest.config.ts`, which belongs to lane w0-l6; that is reported as a planning
 * defect rather than worked around here.
 */

import { describe, expect, it } from 'vitest';

import {
  ACKNOWLEDGEMENT_REFERENCE_PREFIX,
  acknowledgementText,
  inboundMessageReference,
} from './acknowledgement';
import { MAX_OUTBOUND_TEXT_LENGTH } from './constants';

const MESSAGE_ID = '7f3a9c21-4b55-4c1e-8a2d-9f0e1d2c3b4a';

describe('inboundMessageReference', () => {
  it('derives a stable, prefixed handle from the message id', () => {
    expect(inboundMessageReference(MESSAGE_ID)).toBe('MSG-7F3A9C21');
  });

  it('is deterministic — the inbox lane can recompute it from the same row', () => {
    expect(inboundMessageReference(MESSAGE_ID)).toBe(inboundMessageReference(MESSAGE_ID));
  });

  it('is case-insensitive in, upper-case out', () => {
    expect(inboundMessageReference(MESSAGE_ID.toUpperCase())).toBe('MSG-7F3A9C21');
  });

  it('carries the published prefix', () => {
    expect(inboundMessageReference(MESSAGE_ID)).toContain(ACKNOWLEDGEMENT_REFERENCE_PREFIX);
  });

  it('refuses an id it cannot make a reference from, rather than inventing one', () => {
    expect(inboundMessageReference('')).toBeNull();
    expect(inboundMessageReference('zzz-zzz')).toBeNull();
    expect(inboundMessageReference('1234567')).toBeNull();
    expect(inboundMessageReference(undefined as unknown as string)).toBeNull();
  });

  it('never echoes more of the id than the handle', () => {
    const reference = inboundMessageReference(MESSAGE_ID);
    expect(reference).not.toContain('9f0e1d2c3b4a');
  });
});

describe('acknowledgementText', () => {
  const reference = 'MSG-7F3A9C21';
  const text = acknowledgementText(reference);

  it('quotes the reference back, so the tenant has something to cite', () => {
    expect(text).toContain(reference);
  });

  it('is a pure function of the reference and nothing else', () => {
    expect(acknowledgementText(reference)).toBe(text);
    expect(acknowledgementText('MSG-00000000')).not.toBe(text);
  });

  it('discloses nothing: the reference is the only variable part', () => {
    // Everything either side of the reference is constant, so there is no position in
    // the string where a name, a unit, an address or an amount could appear.
    const other = acknowledgementText('MSG-DEADBEEF');
    expect(text.replace(reference, '<ref>')).toBe(other.replace('MSG-DEADBEEF', '<ref>'));
  });

  it('promises follow-up without naming a person, a team member or a time', () => {
    expect(text).toMatch(/follow up/i);
    expect(text).not.toMatch(/\b(hours?|minutes?|days?|today|tomorrow)\b/i);
  });

  it('fits inside the Cloud API text limit by a wide margin', () => {
    expect(text.length).toBeLessThan(MAX_OUTBOUND_TEXT_LENGTH);
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it('is plain text — no link to unfurl, no markup to render', () => {
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/[<>]/);
  });
});

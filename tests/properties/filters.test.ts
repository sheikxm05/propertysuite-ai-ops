/**
 * The free-text search filter.
 *
 * `?q=` is the one place in this lane where caller-supplied *text* reaches a PostgREST
 * filter expression, so the whole suite is about one question: can a term change the
 * structure of the expression, or add an `ILIKE` wildcard the user did not type?
 *
 * The design answer is reduction, not escaping — see `features/properties/filters.ts`.
 * These tests assert the reduction, and then assert the property that matters: whatever
 * goes in, the expression that comes out has exactly one comma and no parentheses.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SEARCH_TERM_LENGTH,
  sanitizeSearchTerm,
  searchFilter,
} from '@/features/properties/filters';

describe('sanitizeSearchTerm', () => {
  it('keeps ordinary property and street names intact', () => {
    expect(sanitizeSearchTerm('Marina Heights Tower')).toBe('Marina Heights Tower');
    expect(sanitizeSearchTerm("Al Wasl - Jumeirah 'Plaza' & Co")).toBe(
      "Al Wasl - Jumeirah 'Plaza' & Co",
    );
  });

  it('keeps non-Latin script, because a Dubai portfolio contains it', () => {
    expect(sanitizeSearchTerm('برج خليفة')).toBe('برج خليفة');
  });

  it.each([
    ['an ILIKE wildcard', 'Marina%', 'Marina'],
    ['an underscore wildcard', 'Marina_1', 'Marina 1'],
    ['a PostgREST wildcard', 'Marina*', 'Marina'],
    ['a filter separator', 'Marina,status.eq.archived', 'Marina status eq archived'],
    ['a group opener', 'Marina)or(id.gt.0', 'Marina or id gt 0'],
    ['a quote', 'Marina"Heights', 'Marina Heights'],
    ['a backslash', 'Marina\\Heights', 'Marina Heights'],
    ['a colon', 'Marina:1', 'Marina 1'],
  ])('strips %s', (_label, raw, expected) => {
    expect(sanitizeSearchTerm(raw)).toBe(expected);
  });

  it('treats a term with nothing usable left as no filter at all', () => {
    // Not "match nothing": an unfiltered list is less surprising than an empty result the
    // user cannot explain. See the function's own comment.
    expect(sanitizeSearchTerm('%%%')).toBeNull();
    expect(sanitizeSearchTerm('   ')).toBeNull();
    expect(sanitizeSearchTerm('')).toBeNull();
    expect(sanitizeSearchTerm(undefined)).toBeNull();
    expect(sanitizeSearchTerm(null)).toBeNull();
  });

  it('bounds the length', () => {
    const term = sanitizeSearchTerm('a'.repeat(500));
    expect(term).toHaveLength(MAX_SEARCH_TERM_LENGTH);
  });
});

describe('searchFilter', () => {
  it('searches name and address', () => {
    expect(searchFilter('Marina')).toBe('name.ilike.*Marina*,address_line.ilike.*Marina*');
  });

  it('cannot be restructured by any term the sanitiser lets through', () => {
    const hostile = [
      'Marina,status.eq.archived',
      'Marina)or(organization_id.neq.0',
      'Marina%,id.gt.0',
      '")or("',
      'a,b,c,d,e',
    ];

    for (const raw of hostile) {
      const term = sanitizeSearchTerm(raw);
      if (term === null) continue;

      const filter = searchFilter(term);
      // One comma separates the two `ilike` clauses, and there are no groups. Anything
      // else would mean the term had added structure to the expression.
      expect(filter.split(',')).toHaveLength(2);
      expect(filter).not.toContain('(');
      expect(filter).not.toContain(')');
      expect(filter).not.toContain('%');
    }
  });
});

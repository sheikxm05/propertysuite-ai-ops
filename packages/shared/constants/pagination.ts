/**
 * Cursor pagination, frozen in `docs/parallel-execution-plan.md` §5.7:
 * "Cursor pagination, default limit 25, maximum 100."
 *
 * Offset pagination is not used anywhere in this application: with
 * row-level security the visible row set differs per caller, so an offset is
 * not stable across requests.
 */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MIN_PAGE_SIZE = 1;

/** Upper bound on an opaque cursor, so a hostile caller cannot send a megabyte of query string. */
export const MAX_CURSOR_LENGTH = 512;

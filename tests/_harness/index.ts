/**
 * Harness barrel. Lane w0-l6.
 *
 * Test files import from here rather than reaching into individual modules, so the
 * harness can be reorganized without touching every suite. `tests/_harness/e2e/**` is
 * lane w2-l1's and is deliberately not re-exported.
 */

export * from './assertions';
export * from './driver';
export * from './driver-pg';
export * from './driver-supabase';
export * from './fixtures';
export * from './jwt-factory';
export * from './policy-coverage';
export * from './policy-matrix';
export * from './probes';
export * from './psql';
export * from './scratch';
export * from './sql';
export * from './tables';
export * from './world';

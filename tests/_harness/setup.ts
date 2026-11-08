/**
 * Vitest setup file — runs before every test file in every suite. Lane w0-l6.
 *
 * Deliberately almost empty. It is shared with lanes w0-l4 and w0-l5, so anything
 * opinionated here (fake timers, a pinned TZ, global mocks) would silently change the
 * meaning of their tests. Its one job is to make locally-configured credentials
 * visible to the RLS harness without every developer exporting three variables by hand.
 *
 * No secret is read, printed or logged here. dotenv only populates process.env.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

const ROOT = resolve(__dirname, '..', '..');

// Later files do not override earlier ones in dotenv, so list most specific first.
for (const file of ['.env.test', '.env.local']) {
  const path = resolve(ROOT, file);
  if (existsSync(path)) dotenv.config({ path, override: false });
}

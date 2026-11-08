#!/usr/bin/env node
/**
 * scan-client-bundle.mjs — fails the build if a server secret reached the browser.
 *
 * The service-role key bypasses Row Level Security completely. If it ships in a client
 * bundle, multi-tenant isolation is over regardless of how correct the policies are.
 * This is therefore a release gate (docs/test-plan.md), not a lint.
 *
 * Scans .next/static for:
 *   1. The literal values of known server-only secrets, when present in the env.
 *   2. Server-only variable NAMES, which indicate a value was inlined at build time.
 *   3. Shapes that look like a Supabase service_role JWT or an Anthropic key.
 *
 *   node scripts/scan-client-bundle.mjs
 *   node scripts/scan-client-bundle.mjs --dir .next/static
 *
 * Exit 0 clean, 1 secret found, 2 nothing to scan.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const dirArg = process.argv.indexOf('--dir');
const SCAN_DIR = resolve(
  ROOT,
  dirArg !== -1 ? (process.argv[dirArg + 1] ?? '.next/static') : '.next/static',
);

/** Variables that must never appear in client-side output, by name or by value. */
const SERVER_ONLY_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_VERIFY_TOKEN',
  'RESEND_API_KEY',
  'GOOGLE_CLIENT_SECRET',
];

/** Shape-based detection, so an unset env var cannot hide a committed secret. */
const SHAPE_PATTERNS = [
  { name: 'Supabase service_role JWT', re: /"role"\s*:\s*"service_role"/ },
  {
    name: 'Supabase service_role JWT (encoded)',
    re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl/,
  },
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'OpenAI API key', re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'Stripe secret key', re: /sk_(?:live|test)_[A-Za-z0-9]{16,}/ },
];

const TEXT_EXT = /\.(js|mjs|cjs|css|json|map|txt|html)$/i;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (TEXT_EXT.test(entry)) out.push(full);
  }
  return out;
}

if (!existsSync(SCAN_DIR)) {
  console.error(
    `bundle-scan: nothing to scan at ${relative(ROOT, SCAN_DIR)} — run \`npm run build\` first.`,
  );
  process.exit(2);
}

// Only treat a value as a needle if it is long enough to be a real secret; short or
// empty values would match everywhere and make the gate useless.
const valueNeedles = SERVER_ONLY_VARS.map((name) => ({ name, value: process.env[name] })).filter(
  (v) => typeof v.value === 'string' && v.value.length >= 12,
);

const files = walk(SCAN_DIR);
const findings = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);

  for (const { name, value } of valueNeedles) {
    if (text.includes(value)) {
      findings.push({
        rel,
        kind: `VALUE of ${name}`,
        detail: 'exact secret value present in client output',
      });
    }
  }
  for (const name of SERVER_ONLY_VARS) {
    if (text.includes(name)) {
      findings.push({
        rel,
        kind: `NAME ${name}`,
        detail: 'server-only variable name inlined into client output',
      });
    }
  }
  for (const { name, re } of SHAPE_PATTERNS) {
    if (re.test(text)) {
      findings.push({ rel, kind: `SHAPE ${name}`, detail: 'string matching a secret format' });
    }
  }
}

console.log(
  `bundle-scan: ${files.length} file(s) under ${relative(ROOT, SCAN_DIR)}; ` +
    `${valueNeedles.length}/${SERVER_ONLY_VARS.length} secret value(s) available to match exactly.`,
);

if (findings.length === 0) {
  console.log('✓ no server secret found in the client bundle');
  process.exit(0);
}

console.error(`\n✗ ${findings.length} finding(s) — a server secret reached the client bundle:\n`);
for (const f of findings) {
  console.error(`  ${f.rel}\n    ${f.kind} — ${f.detail}`);
}
console.error(
  '\nThe service-role key bypasses RLS entirely. Do not suppress this check.\n' +
    'Move the import behind a server-only module and rebuild.\n',
);
process.exit(1);

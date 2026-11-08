#!/usr/bin/env node
/**
 * reset-db.mjs — drop and rebuild the local database from supabase/migrations.
 * Lane w0-l6.
 *
 * `npm run db:reset` is the first thing anyone runs when the isolation suite starts
 * behaving oddly, so it reuses supabase-local.mjs's preflight and the same actionable
 * failure text. A reset throws away the fixtures; the suite re-seeds them on its next
 * run, because every fixture row uses a deterministic id and an upsert.
 *
 *   node scripts/reset-db.mjs              # reset, then verify every migration applied
 *   node scripts/reset-db.mjs --quiet      # less chatter, same checks
 *   node scripts/reset-db.mjs --no-verify  # skip the post-reset verification
 *
 * Exit codes: 0 ok, 1 reset or verification failed, 2 environment not ready.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight, migrationsDiagnosis, runSupabase } from './supabase-local.mjs';

function die(code, title, lines = []) {
  console.error(`\n${title}`);
  if (lines.length > 0) console.error(lines.join('\n'));
  console.error('');
  process.exit(code);
}

export function parseArgs(argv) {
  const known = new Set(['--quiet', '--no-verify', '--help']);
  const unknown = argv.filter((a) => a.startsWith('--') && !known.has(a));
  const positional = argv.filter((a) => !a.startsWith('--'));
  return {
    quiet: argv.includes('--quiet'),
    verify: !argv.includes('--no-verify'),
    help: argv.includes('--help'),
    unknown,
    positional,
  };
}

const cli = (args, capture) => runSupabase(args, { capture });

function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log('node scripts/reset-db.mjs [--quiet] [--no-verify]');
    return 0;
  }
  if (args.unknown.length > 0) {
    die(2, `Unknown flag(s): ${args.unknown.join(', ')}`, [
      '  - Known flags: --quiet, --no-verify, --help',
    ]);
  }
  if (args.positional.length > 0) {
    die(2, `reset-db takes no positional arguments (got: ${args.positional.join(' ')}).`, [
      '  - Did you mean: node scripts/supabase-local.mjs ' + args.positional[0] + '?',
    ]);
  }

  const { problems } = preflight();
  if (problems.length > 0) {
    const first = problems[0];
    die(first.code, first.title, first.lines);
  }

  if (!args.quiet) {
    const { files } = migrationsDiagnosis();
    console.log(`Resetting local database from ${files.length} migration(s):`);
    for (const f of files) console.log(`  - ${f}`);
    console.log('');
  }

  const reset = cli(['db', 'reset', '--no-seed'], false);
  if (reset.status !== 0) {
    die(1, `supabase db reset failed (exit ${reset.status}).`, [
      '  - A migration that does not apply to a fresh database is a defect in the',
      '    migration, not in this script. Fix it in the owning lane (w0-l2 / w0-l3).',
    ]);
  }

  if (args.verify) {
    const list = cli(['migration', 'list'], true);
    if (list.status !== 0) {
      die(1, 'Reset completed but `supabase migration list` failed.', [
        (list.stderr || list.stdout || '').trim(),
      ]);
    }
    const out = list.stdout || '';
    const { files } = migrationsDiagnosis();
    const unapplied = files
      .map((f) => f.replace(/_.*$/, '').replace(/\.sql$/, ''))
      .filter((version) => {
        const row = out.split(/\r?\n/).find((l) => l.includes(version));
        // A row shows local and remote columns; a blank remote column means unapplied.
        return !row || !/\|\s*\d/.test(row.split('|').slice(1).join('|'));
      });
    if (unapplied.length > 0 && !args.quiet) {
      console.warn(
        `\nCould not confirm from \`migration list\` that these applied: ${unapplied.join(', ')}`,
      );
      console.warn('Check manually with: npx supabase migration list');
    }
  }

  if (!args.quiet) {
    console.log('\nDatabase rebuilt. Fixtures were dropped; the isolation suite re-seeds');
    console.log('them deterministically on its next run (npm run test:rls).');
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)) ?? 0);
}

#!/usr/bin/env node
/**
 * supabase-local.mjs — lifecycle for the local Supabase stack the isolation suite
 * runs against. Lane w0-l6.
 *
 * The suite is worthless without a real Postgres: RLS can only be proven against the
 * engine that enforces it. That makes this script part of the security story, not a
 * convenience wrapper, so it fails loudly and specifically instead of handing you a
 * stack trace from the Supabase CLI.
 *
 *   node scripts/supabase-local.mjs doctor     # preflight only: Docker, CLI, config
 *   node scripts/supabase-local.mjs start      # start the stack, then apply migrations
 *   node scripts/supabase-local.mjs migrate    # apply migrations to the running stack
 *   node scripts/supabase-local.mjs reset      # drop, re-create, re-apply migrations
 *   node scripts/supabase-local.mjs status     # CLI status passthrough
 *   node scripts/supabase-local.mjs env        # export lines for .env.local
 *   node scripts/supabase-local.mjs stop       # tear the stack down
 *   node scripts/supabase-local.mjs stop --no-backup
 *
 * Exit codes: 0 ok, 1 command failed, 2 environment not ready (Docker, CLI, config).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = resolve(ROOT, 'supabase', 'migrations');
const CONFIG_PATH = resolve(ROOT, 'supabase', 'config.toml');

export const COMMANDS = ['doctor', 'start', 'migrate', 'reset', 'status', 'env', 'stop'];

/**
 * Prefer the CLI binary the frozen devDependency already installed. `npx supabase`
 * is the documented invocation but resolves unreliably on Windows shells, and a test
 * harness that cannot find Postgres must not look like a failing assertion.
 */
export function resolveSupabaseBin() {
  // The npm package's bin is a plain JS entry point. Running it with the current Node
  // binary sidesteps both the Windows .cmd shim (which spawnSync cannot exec directly
  // on Node 20+) and npx resolution quirks.
  const entry = resolve(ROOT, 'node_modules', 'supabase', 'dist', 'supabase.js');
  if (existsSync(entry)) return { cmd: process.execPath, prefix: [entry], source: 'local' };

  const shim = resolve(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
  );
  if (existsSync(shim)) return { cmd: shim, prefix: [], source: 'bin-shim' };

  return {
    cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    prefix: ['--no-install', 'supabase'],
    source: 'npx',
  };
}

/** Single entry point for every Supabase CLI call made by this lane. */
export function runSupabase(args, { capture = false, cwd = ROOT } = {}) {
  const { cmd, prefix, source } = resolveSupabaseBin();
  return spawnSync(cmd, [...prefix, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
    shell: source === 'bin-shim' && process.platform === 'win32',
  });
}

/** `supabase status -o env` parsed into an object. Empty when the stack is down. */
export function statusEnv() {
  const res = runSupabase(['status', '-o', 'env'], { capture: true });
  if (res.status !== 0) return {};
  const parsed = {};
  for (const line of (res.stdout || '').split(/\r?\n/)) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (m) parsed[m[1]] = m[2];
  }
  return parsed;
}

/* ------------------------------------------------------------------ output -- */

const bullet = (s) => `  - ${s}`;

function fail(code, title, lines = []) {
  console.error(`\n${title}`);
  if (lines.length > 0) console.error(lines.join('\n'));
  console.error('');
  process.exit(code);
}

/* --------------------------------------------------------------- preflight -- */

/** True when the Docker *daemon* answers, not merely when the binary exists. */
export function dockerDiagnosis() {
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (probe.error && probe.error.code === 'ENOENT') {
    return { ok: false, reason: 'missing-binary', detail: 'docker is not on PATH' };
  }
  if (probe.status !== 0) {
    const stderr = (probe.stderr || '').trim();
    return {
      ok: false,
      reason: 'daemon-unreachable',
      detail: stderr.split('\n').slice(0, 3).join(' ').slice(0, 300) || 'docker info failed',
    };
  }
  return { ok: true, serverVersion: (probe.stdout || '').trim() };
}

export function supabaseCliDiagnosis() {
  const probe = runSupabase(['--version'], { capture: true });
  if (probe.status !== 0) {
    return { ok: false, detail: (probe.stderr || probe.stdout || '').trim().slice(0, 300) };
  }
  return { ok: true, version: (probe.stdout || '').trim() };
}

export function migrationsDiagnosis() {
  if (!existsSync(MIGRATIONS_DIR)) {
    return { ok: false, files: [], detail: 'supabase/migrations does not exist' };
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return { ok: files.length > 0, files, detail: files.length === 0 ? 'no .sql files' : '' };
}

/**
 * Every precondition in one place, so `doctor` and every real command report the same
 * thing. Returns a list of problems; empty means ready.
 */
export function preflight({ requireConfig = true } = {}) {
  const problems = [];

  const docker = dockerDiagnosis();
  if (!docker.ok) {
    problems.push({
      code: 2,
      title:
        docker.reason === 'missing-binary'
          ? 'Docker is not installed, or not on PATH.'
          : 'The Docker daemon is not reachable.',
      lines: [
        bullet(`Probe: docker info -> ${docker.detail}`),
        '',
        'The local Supabase stack runs in Docker containers. Without a running daemon',
        'there is no Postgres, so the RLS isolation suite cannot execute at all — and it',
        'must never be faked with mocks, because mocks do not enforce RLS.',
        '',
        'Do this:',
        bullet('Start Docker Desktop (Windows/macOS) and wait for "Engine running".'),
        bullet('Or start the daemon directly: sudo systemctl start docker (Linux).'),
        bullet('Then re-run: node scripts/supabase-local.mjs doctor'),
      ],
    });
  }

  const cli = supabaseCliDiagnosis();
  if (!cli.ok) {
    problems.push({
      code: 2,
      title: 'The Supabase CLI is not runnable from this checkout.',
      lines: [
        bullet(`Probe: supabase --version -> ${cli.detail || 'failed'}`),
        bullet(`Resolved via: ${resolveSupabaseBin().source}`),
        '',
        'The CLI ships as a devDependency (frozen list, docs/parallel-execution-plan.md',
        '§5.1). Do not install anything — run npm ci and try again. If it is genuinely',
        'absent from package.json, that is a planning defect to report, not to patch.',
      ],
    });
  }

  if (requireConfig && !existsSync(CONFIG_PATH)) {
    problems.push({
      code: 2,
      title: 'supabase/config.toml is missing — the stack has never been initialised.',
      lines: [
        bullet(`Expected at: ${CONFIG_PATH}`),
        '',
        'Run this once, from the repository root:',
        bullet('npx supabase init'),
        '',
        'This script will not create it for you: supabase/config.toml is owned by no',
        'lane in lanes.json, and lane w0-l6 may not write outside its own paths.',
        'Reported as a planning defect by the lane that found it.',
      ],
    });
  }

  const migrations = migrationsDiagnosis();
  if (!migrations.ok) {
    problems.push({
      code: 2,
      title: 'No SQL migrations found.',
      lines: [
        bullet(`Looked in: ${MIGRATIONS_DIR} (${migrations.detail})`),
        '',
        'The isolation suite asserts the policy matrix in docs/implementation-plan.md §4,',
        'which lives in migrations 0002 and 0003. Without them the suite is expected to',
        'run RED — that is the test-first contract, not a bug.',
      ],
    });
  }

  return { problems, docker, cli, migrations };
}

function requireReady(options) {
  const { problems } = preflight(options);
  if (problems.length > 0) {
    const first = problems[0];
    for (const p of problems.slice(1)) {
      console.error(`\n${p.title}`);
      console.error(p.lines.join('\n'));
    }
    fail(first.code, first.title, first.lines);
  }
}

/* ------------------------------------------------------------------- calls -- */

function runCli(args, { capture = false } = {}) {
  const res = runSupabase(args, { capture });
  if (res.status !== 0) {
    const detail = capture ? (res.stderr || res.stdout || '').trim() : '';
    fail(1, `supabase ${args.join(' ')} failed (exit ${res.status}).`, detail ? [detail] : []);
  }
  return capture ? res.stdout : '';
}

/* ---------------------------------------------------------------- commands -- */

function cmdDoctor() {
  const { problems, docker, cli, migrations } = preflight();
  console.log('Local Supabase stack preflight');
  console.log(
    bullet(`docker daemon : ${docker.ok ? `ok (${docker.serverVersion})` : docker.detail}`),
  );
  console.log(
    bullet(`supabase cli  : ${cli.ok ? cli.version.split('\n')[0] : cli.detail || 'not runnable'}`),
  );
  console.log(bullet(`config.toml   : ${existsSync(CONFIG_PATH) ? 'present' : 'MISSING'}`));
  console.log(
    bullet(`migrations    : ${migrations.files.length} file(s) ${migrations.files.join(', ')}`),
  );
  if (problems.length === 0) {
    console.log('\nReady. Next: node scripts/supabase-local.mjs start');
    return 0;
  }
  console.log('');
  for (const p of problems) {
    console.error(p.title);
    console.error(p.lines.join('\n'));
    console.error('');
  }
  process.exit(2);
}

function cmdStart() {
  requireReady();
  runCli(['start']);
  runCli(['db', 'reset', '--no-seed']);
  printEnv('\nStack is up and migrations are applied. Credentials:');
  console.log('\nRun the isolation suite with: npm run test:rls');
  return 0;
}

function cmdMigrate() {
  requireReady();
  runCli(['migration', 'up']);
  console.log('\nMigrations applied.');
  return 0;
}

function cmdReset() {
  requireReady();
  runCli(['db', 'reset', '--no-seed']);
  console.log('\nDatabase re-created from supabase/migrations. Fixtures are gone;');
  console.log('the suite re-seeds them on its next run.');
  return 0;
}

function cmdStatus() {
  requireReady();
  runCli(['status']);
  return 0;
}

function printEnv(title) {
  const env = statusEnv();
  const wanted = {
    NEXT_PUBLIC_SUPABASE_URL: env.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.SERVICE_ROLE_KEY,
  };
  if (!wanted.NEXT_PUBLIC_SUPABASE_URL) {
    fail(1, 'supabase status returned no API_URL — is the stack actually running?', [
      bullet('node scripts/supabase-local.mjs start'),
    ]);
  }
  if (title) console.log(title);
  for (const [k, v] of Object.entries(wanted)) console.log(`${k}=${v ?? ''}`);
  console.log('\nSUPABASE_SERVICE_ROLE_KEY bypasses RLS. It belongs in .env.local (gitignored)');
  console.log('and nowhere else. Never commit it, never log it, never ship it to a client.');
}

function cmdEnv() {
  requireReady();
  printEnv('');
  return 0;
}

function cmdStop(args) {
  requireReady({ requireConfig: true });
  runCli(args.includes('--no-backup') ? ['stop', '--no-backup'] : ['stop']);
  console.log('\nStack stopped.');
  return 0;
}

/* --------------------------------------------------------------------- cli -- */

export function dispatch(argv) {
  const command = argv.find((a) => !a.startsWith('--')) ?? 'doctor';
  const flags = argv.filter((a) => a.startsWith('--'));

  if (flags.includes('--help') || command === 'help') {
    console.log(COMMANDS.join(' | '));
    return 0;
  }
  if (!COMMANDS.includes(command)) {
    fail(2, `Unknown command "${command}".`, [bullet(`Known: ${COMMANDS.join(', ')}`)]);
  }

  switch (command) {
    case 'doctor':
      return cmdDoctor();
    case 'start':
      return cmdStart();
    case 'migrate':
      return cmdMigrate();
    case 'reset':
      return cmdReset();
    case 'status':
      return cmdStatus();
    case 'env':
      return cmdEnv();
    case 'stop':
      return cmdStop(flags);
    default:
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exit(dispatch(process.argv.slice(2)) ?? 0);
}

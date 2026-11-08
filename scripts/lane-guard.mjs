#!/usr/bin/env node
/**
 * lane-guard.mjs — PreToolUse hook blocking out-of-lane writes before they happen.
 *
 * Wired in .claude/settings.json on Write | Edit | NotebookEdit. Reads the hook payload
 * from stdin, resolves the target path against this repository, and asks
 * check-lane-ownership.mjs whether the active lane owns it.
 *
 * Active ONLY when CLAUDE_LANE is set, so the orchestrator and ordinary sessions are
 * unaffected:
 *
 *   export CLAUDE_LANE=w1-l4      # bash
 *   $env:CLAUDE_LANE = 'w1-l4'    # powershell
 *
 * Exit codes follow the hook contract, not the validator's:
 *   0  allow
 *   2  block, and feed stderr back to the agent as the reason
 * Any internal failure exits 0 — a broken guard must never halt a build. The
 * pre-commit check in each lane's procedure remains the real gate.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LANE = process.env.CLAUDE_LANE?.trim();

if (!LANE) process.exit(0); // guard inactive

/** Reads the whole of stdin synchronously; returns '' if nothing is piped. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let payload;
try {
  payload = JSON.parse(readStdin() || '{}');
} catch {
  process.exit(0); // unparseable payload is not the agent's fault
}

const input = payload.tool_input ?? payload.toolInput ?? {};
const raw = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
if (!raw) process.exit(0);

// Normalise to a repo-relative POSIX path; ignore writes outside the repo entirely.
// Windows needs care: fileURLToPath yields "C:\..." while an agent may pass "c:\...",
// and path.relative treats those as different roots — which would silently disable the
// guard. Compare the prefix case-insensitively on win32, keep the tail's real case
// because ownership globs are case-sensitive.
const toPosix = (p) => p.replace(/\\/g, '/');
const rootPosix = toPosix(resolve(ROOT));
const absPosix = toPosix(isAbsolute(raw) ? resolve(raw) : resolve(ROOT, raw));
const fold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;

if (fold(absPosix) !== fold(rootPosix) && !fold(absPosix).startsWith(fold(rootPosix) + '/')) {
  process.exit(0); // outside this repository
}
const rel = absPosix.slice(rootPosix.length + 1);
if (!rel) process.exit(0);

let result;
try {
  const out = execFileSync(
    process.execPath,
    [resolve(ROOT, 'scripts/check-lane-ownership.mjs'), '--lane', LANE, '--files', rel, '--json'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  result = JSON.parse(out);
} catch (err) {
  // Exit status 1 means a violation and still carries JSON on stdout.
  if (err.status === 1 && err.stdout) {
    try {
      result = JSON.parse(err.stdout);
    } catch {
      process.exit(0);
    }
  } else {
    process.exit(0); // status 2 = config error, or the validator is missing
  }
}

const violation = result?.violations?.[0];
if (!violation) process.exit(0);

process.stderr.write(
  `BLOCKED by lane ownership: ${violation.file}\n` +
    `  Your lane: ${LANE}\n` +
    `  Owned by:  ${violation.owner} (${violation.ownerTitle}) — ${violation.scope}\n\n` +
    `Five other agents are working in this repository right now. Writing here would\n` +
    `collide with ${violation.owner}.\n\n` +
    `This is a PLANNING DEFECT, not an obstacle to route around. Do not widen your\n` +
    `globs, do not edit lanes.json, and do not copy the file into your territory.\n` +
    `Finish everything in your lane that does not depend on this, then report:\n\n` +
    `PLANNING DEFECT\n` +
    `  Lane: ${LANE}\n` +
    `  Needed: ${violation.file} — <the change required>\n` +
    `  Owner: ${violation.owner}\n` +
    `  Why: <what your lane cannot complete without it>\n`,
);
process.exit(2);

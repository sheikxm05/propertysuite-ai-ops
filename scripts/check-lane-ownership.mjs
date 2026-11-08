#!/usr/bin/env node
/**
 * check-lane-ownership.mjs — path-ownership enforcement for parallel agent lanes.
 *
 * Mechanically enforces docs/parallel-execution-plan.md section 6 via lanes.json.
 * An agent must run this before every commit; CI runs it on every lane branch.
 *
 *   node scripts/check-lane-ownership.mjs --lane w1-l4
 *   node scripts/check-lane-ownership.mjs --lane w1-l4 --base main
 *   node scripts/check-lane-ownership.mjs --lane w1-l4 --files app/x.ts lib/y.ts
 *   node scripts/check-lane-ownership.mjs --overlaps
 *   node scripts/check-lane-ownership.mjs --list
 *
 * Flags
 *   --lane <id>      Lane to check changed files against. Required unless --list/--overlaps.
 *   --base <ref>     Compare the whole branch against <ref> instead of the working tree.
 *   --files <paths>  Check these paths instead of asking git.
 *   --orphans        Also warn about changed paths no lane in this wave owns.
 *   --overlaps       Static check: assert no two lanes in the same wave can own one path.
 *   --list           Print every wave, lane and owned glob.
 *   --json           Machine-readable output.
 *   --quiet          Only print on failure.
 *
 * Exit codes: 0 clean, 1 violation found, 2 usage or configuration error.
 * No dependencies — runs before `npm install` has ever been executed.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = resolve(ROOT, 'lanes.json');

/* ------------------------------------------------------------------ args -- */

function parseArgs(argv) {
  const out = { files: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lane') out.lane = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--files') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.files.push(argv[++i]);
    } else if (a.startsWith('--')) out.flags.add(a.slice(2));
    else out.files.push(a);
  }
  return out;
}

/* ------------------------------------------------------------------ glob -- */

const RE_SPECIAL = /[.+^$|()[\]{}\\]/g;
const escapeLiteral = (s) => s.replace(RE_SPECIAL, '\\$&');

/**
 * Converts a glob to an anchored RegExp.
 * Supported: `**` (any depth), `*` (one segment), `?` (one char), `{a,b}` (alternation).
 * Parentheses and brackets are literal — Next.js route groups like `app/(dashboard)/`
 * and `features/[id]/` must match as written.
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // `a/**/b` also matches `a/b`
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map(escapeLiteral).join('|') + ')';
        i = end;
      }
    } else {
      re += escapeLiteral(c);
    }
  }
  return new RegExp('^' + re + '$');
}

const normalize = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();

/** Splits an `owns` list into compiled include and exclude matchers. */
function compileOwns(owns) {
  const include = [];
  const exclude = [];
  for (const g of owns) {
    if (g.startsWith('!')) exclude.push({ glob: g.slice(1), re: globToRegExp(g.slice(1)) });
    else include.push({ glob: g, re: globToRegExp(g) });
  }
  return { include, exclude };
}

/** Returns the matching include glob, or null when the lane does not own the path. */
function ownsPath(compiled, path) {
  if (compiled.exclude.some((e) => e.re.test(path))) return null;
  const hit = compiled.include.find((i) => i.re.test(path));
  return hit ? hit.glob : null;
}

/* ---------------------------------------------------------------- config -- */

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) fail(`lanes.json not found at ${CONFIG_PATH}`);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    fail(`lanes.json is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(cfg.waves)) fail('lanes.json has no "waves" array.');

  const lanes = new Map();
  for (const wave of cfg.waves) {
    for (const lane of wave.lanes ?? []) {
      if (lanes.has(lane.id)) fail(`duplicate lane id "${lane.id}" in lanes.json`);
      lanes.set(lane.id, {
        ...lane,
        wave: wave.wave,
        waveName: wave.name,
        compiled: compileOwns(lane.owns ?? []),
      });
    }
  }
  if (cfg.preWave) {
    lanes.set(cfg.preWave.id, {
      ...cfg.preWave,
      wave: 'pre',
      waveName: 'Pre-wave artifacts',
      compiled: compileOwns(cfg.preWave.owns ?? []),
    });
  }
  return { cfg, lanes };
}

/* ------------------------------------------------------------------- git -- */

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isRepo() {
  try {
    git(['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/** Working-tree changes: staged, unstaged, untracked and both sides of a rename. */
function workingTreeFiles() {
  const out = git(['status', '--porcelain=v1', '-z']);
  const entries = out.split('\0').filter(Boolean);
  const files = new Set();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') {
      files.add(normalize(path)); // destination
      if (i + 1 < entries.length) files.add(normalize(entries[++i])); // origin
    } else {
      files.add(normalize(path));
    }
  }
  return [...files];
}

function branchFiles(base) {
  const out = git(['diff', '--name-only', `${base}...HEAD`]);
  return out.split('\n').map(normalize).filter(Boolean);
}

/* ---------------------------------------------------------------- checks -- */

function checkLane(lanes, laneId, files, opts) {
  const lane = lanes.get(laneId);
  if (!lane) {
    fail(`unknown lane "${laneId}". Known: ${[...lanes.keys()].join(', ')}`);
  }

  const peers = [...lanes.values()].filter((l) => l.wave === lane.wave && l.id !== lane.id);
  const violations = [];
  const orphans = [];
  const allowed = [];

  for (const file of files) {
    if (ownsPath(lane.compiled, file)) {
      allowed.push(file);
      continue;
    }
    const peerOwner = peers.find((p) => ownsPath(p.compiled, file));
    const otherWaveOwner = [...lanes.values()].find(
      (l) => l.wave !== lane.wave && ownsPath(l.compiled, file),
    );
    if (peerOwner) {
      violations.push({ file, owner: peerOwner.id, ownerTitle: peerOwner.title, scope: 'same-wave' });
    } else if (otherWaveOwner) {
      violations.push({
        file,
        owner: otherWaveOwner.id,
        ownerTitle: otherWaveOwner.title,
        scope: `wave ${otherWaveOwner.wave}`,
      });
    } else {
      orphans.push(file);
    }
  }

  return { lane, allowed, violations, orphans };
}

function checkOverlaps(lanes) {
  // Heuristic: synthesise concrete candidate paths from every include glob, then
  // assert no candidate is claimed by two lanes in the same wave.
  const candidates = new Set();
  const expandBraces = (glob) => {
    const m = glob.match(/\{([^}]*)\}/);
    if (!m) return [glob];
    return m[1]
      .split(',')
      .flatMap((alt) => expandBraces(glob.replace(m[0], alt)));
  };
  for (const lane of lanes.values()) {
    for (const inc of lane.compiled.include) {
      for (const g of expandBraces(inc.glob)) {
        candidates.add(
          g.replace(/\*\*\//g, 'seg/').replace(/\*\*/g, 'seg/leaf.ts').replace(/\*/g, 'leaf').replace(/\?/g, 'x'),
        );
      }
    }
  }

  const collisions = [];
  for (const path of candidates) {
    const owners = [...lanes.values()].filter((l) => ownsPath(l.compiled, path));
    const byWave = new Map();
    for (const o of owners) {
      if (!byWave.has(o.wave)) byWave.set(o.wave, []);
      byWave.get(o.wave).push(o.id);
    }
    for (const [wave, ids] of byWave) {
      if (ids.length > 1) collisions.push({ path, wave, lanes: ids });
    }
  }
  return { candidateCount: candidates.size, collisions };
}

/* ---------------------------------------------------------------- output -- */

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', green: '', yellow: '', dim: '', bold: '', off: '' };

function fail(msg) {
  console.error(`${C.red}lane-ownership: ${msg}${C.off}`);
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { cfg, lanes } = loadConfig();
  const json = args.flags.has('json');
  const quiet = args.flags.has('quiet');

  if (args.flags.has('list')) {
    if (json) {
      console.log(JSON.stringify([...lanes.values()].map(({ compiled, ...l }) => l), null, 2));
      return;
    }
    for (const wave of cfg.waves) {
      console.log(`\n${C.bold}Wave ${wave.wave} — ${wave.name}${C.off}`);
      for (const lane of wave.lanes) {
        console.log(`  ${C.bold}${lane.id}${C.off}  ${lane.title}`);
        for (const g of lane.owns) {
          console.log(`      ${g.startsWith('!') ? C.yellow : C.dim}${g}${C.off}`);
        }
      }
    }
    console.log();
    return;
  }

  if (args.flags.has('overlaps')) {
    const { candidateCount, collisions } = checkOverlaps(lanes);
    if (json) {
      console.log(JSON.stringify({ candidateCount, collisions }, null, 2));
      process.exit(collisions.length ? 1 : 0);
    }
    if (collisions.length === 0) {
      console.log(
        `${C.green}✓ no same-wave ownership collisions${C.off} ${C.dim}(${candidateCount} synthesised paths tested across ${lanes.size} lanes)${C.off}`,
      );
      return;
    }
    console.error(`${C.red}✗ ${collisions.length} same-wave ownership collision(s)${C.off}`);
    for (const c of collisions) {
      console.error(`  wave ${c.wave}: ${c.path} claimed by ${c.lanes.join(' and ')}`);
    }
    process.exit(1);
  }

  if (!args.lane) fail('--lane <id> is required. Use --list to see lane ids.');

  let files = args.files.map(normalize).filter(Boolean);
  if (files.length === 0) {
    if (!isRepo()) {
      fail('not a git repository — pass --files <paths> explicitly, or run `git init` first.');
    }
    files = args.base ? branchFiles(args.base) : workingTreeFiles();
  }

  const result = checkLane(lanes, args.lane, files, args);
  const { lane, allowed, violations, orphans } = result;
  const showOrphans = args.flags.has('orphans');

  if (json) {
    console.log(
      JSON.stringify(
        { lane: lane.id, wave: lane.wave, checked: files.length, allowed, violations, orphans },
        null,
        2,
      ),
    );
    process.exit(violations.length ? 1 : 0);
  }

  if (files.length === 0) {
    if (!quiet) console.log(`${C.dim}lane ${lane.id}: no changed files${C.off}`);
    return;
  }

  if (violations.length === 0) {
    if (!quiet) {
      console.log(
        `${C.green}✓ ${lane.id}${C.off} — ${allowed.length} changed file(s), all within owned paths ${C.dim}(wave ${lane.wave})${C.off}`,
      );
    }
    if (showOrphans && orphans.length) {
      console.log(`${C.yellow}⚠ ${orphans.length} path(s) owned by no lane in wave ${lane.wave}:${C.off}`);
      for (const f of orphans) console.log(`    ${f}`);
    }
    return;
  }

  console.error(`\n${C.red}${C.bold}✗ lane-ownership violation — ${lane.id} (${lane.title})${C.off}\n`);
  for (const v of violations) {
    console.error(`  ${C.red}${v.file}${C.off}`);
    console.error(`    owned by ${C.bold}${v.owner}${C.off} (${v.ownerTitle}) — ${v.scope}`);
  }
  if (orphans.length) {
    console.error(`\n  ${C.yellow}${orphans.length} path(s) owned by no lane:${C.off}`);
    for (const f of orphans) console.error(`    ${f}`);
  }
  console.error(
    `\n${C.bold}This is a planning defect, not something to work around.${C.off}\n` +
      `Revert these paths, then report that lane ${lane.id} needs a change in another lane's\n` +
      `territory. Do not edit across the boundary and do not widen your globs.\n`,
  );
  process.exit(1);
}

main();

#!/usr/bin/env node
/**
 * Assert that every Python module an image's sources import at module scope is copied into it. The
 * Python suites import from the source tree, check-docs-drift asserts a build command exists, and
 * check-image-tag-parity compares pins; a module left out of a Dockerfile's COPY is found only by
 * the container crash-looping with ModuleNotFoundError. Module scope, because an import at column 0
 * fails at interpreter start. Directory-local: a copied module's local imports resolve against its
 * own source directory and must be copied by the same Dockerfile; third-party imports are
 * requirements.txt's business.
 *
 * Usage: node scripts/check-image-sources.mjs [--verbose]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

/**
 * The Dockerfiles that ship Python. Listed rather than globbed so a new one is a decision somebody
 * makes here.
 */
const DOCKERFILES = [
  'ingestion/Dockerfile',
  'i3x/Dockerfile',
  'test-harness/Dockerfile',
];

let failed = false;
const fail = (m) => { failed = true; console.log(`  FAIL  ${m}`); };
const pass = (m) => console.log(`  ok    ${m}`);
const note = (m) => console.log(`        ${m}`);

/**
 * Physical lines joined on a trailing backslash, comments dropped. test-harness/Dockerfile copies
 * four pairs of files across continuations.
 */
function instructions(text) {
  const out = [];
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!current && (line === '' || line.startsWith('#'))) continue;
    if (line.endsWith('\\')) { current += line.slice(0, -1) + ' '; continue; }
    out.push((current + line).trim());
    current = '';
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Every `.py` path a Dockerfile copies, repo-relative. The last argument of a COPY is the
 * destination and is skipped, as are `--from=` and other flags.
 */
function copiedPythonFiles(dockerfile) {
  const copied = [];
  for (const line of instructions(dockerfile)) {
    if (!/^COPY\s/i.test(line)) continue;
    const args = line.split(/\s+/).slice(1).filter((a) => !a.startsWith('--'));
    for (const arg of args.slice(0, -1)) {
      if (arg.endsWith('.py')) copied.push(arg);
    }
  }
  return copied;
}

/**
 * Module-scope imports: `import x`, `import x as y`, `from x import ...`, at column 0 only. `import
 * a.b` yields `a`, which never resolves to a sibling file; these images have flat modules.
 */
function moduleScopeImports(source) {
  const names = new Set();
  for (const raw of source.split(/\r?\n/)) {
    if (/^\s/.test(raw)) continue;
    let m = /^import\s+([A-Za-z_][\w.]*)/.exec(raw);
    if (m) { names.add(m[1].split('.')[0]); continue; }
    m = /^from\s+([A-Za-z_][\w.]*)\s+import\s/.exec(raw);
    if (m) names.add(m[1].split('.')[0]);
  }
  return names;
}

console.log('Image sources: every module-scope import must be in the image.\n');

for (const relative of DOCKERFILES) {
  const path = join(REPO_ROOT, relative);
  if (!existsSync(path)) { fail(`${relative} is listed here but does not exist -- update the list`); continue; }

  const text = readFileSync(path, 'utf8');
  const copied = copiedPythonFiles(text);
  if (copied.length === 0) { pass(`${relative} ships no Python`); continue; }

  // Generated modules are not missing ones: `sparkplug_b_pb2` is produced inside the image by
  // protoc from the `.proto` the Dockerfile copies. Derived from the Dockerfile rather than waived
  // by name.
  const generatesProto = /\bprotoc\b/.test(text);

  const shipped = new Set(copied.map((p) => basename(p, '.py')));
  const missing = [];

  for (const file of copied) {
    const full = join(REPO_ROOT, file);
    if (!existsSync(full)) {
      fail(`${relative} copies ${file}, which does not exist -- a rename that will fail the build`);
      continue;
    }
    const siblings = new Set(
      readdirSync(dirname(full)).filter((f) => f.endsWith('.py')).map((f) => basename(f, '.py'))
    );

    for (const name of moduleScopeImports(readFileSync(full, 'utf8'))) {
      if (shipped.has(name)) continue;
      if (generatesProto && name.endsWith('_pb2')) continue;
      // Only a name that resolves to a file BESIDE the importer can be left behind by a COPY --
      // everything else is a third-party package and pip's problem, loudly, at build time.
      if (!siblings.has(name)) continue;
      missing.push(`${basename(file)} imports \`${name}\` at module scope and ${relative} does not COPY it`);
    }
  }

  if (missing.length > 0) {
    fail(`${relative} is missing ${missing.length} module(s) its own sources import`);
    for (const m of missing) note(m);
    note('A module-scope import is a CRASH LOOP on start, not a degraded feature: the container');
    note('restarts forever and the stack reports the dependency, not the missing file.');
  } else {
    pass(`${relative}: all ${copied.length} copied module(s) can import what they name`);
    if (verbose) note(`ships: ${[...shipped].sort().join(', ')}`);
  }
}

console.log(
  failed
    ? '\nAn image is missing a source its own code imports. It builds, and it will not start.'
    : '\nEvery image carries the modules its sources import at module scope.'
);
process.exit(failed ? 1 : 0);

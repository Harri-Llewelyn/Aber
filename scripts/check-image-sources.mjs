#!/usr/bin/env node
/**
 * Assert that every Python module an image's sources import at module scope is COPIED into it.
 *
 * =================================================================================================
 * THE FAILURE THIS EXISTS FOR, WHICH A FULL GREEN RUN DID NOT SEE
 *
 * `ingestion/directory_publish.py` was added, unit-tested (20 tests), documented, given a broker
 * ACL rule with its own guard, wired into docker-compose and the Helm chart -- and left out of
 * `ingestion/Dockerfile`. Every suite passed. Every guard passed. The daemon then crash-looped on
 * the first boot that actually ran it:
 *
 *     ModuleNotFoundError: No module named 'directory_publish'
 *
 * NOTHING IN THE REPOSITORY COULD HAVE CAUGHT IT. The Python suites import from the source tree,
 * where the file plainly exists. check-docs-drift.mjs asserts that every image built here has a
 * documented build command, not what is inside one. check-image-tag-parity.mjs compares pins across
 * the two targets. The image contents were checked by nothing at all, and the only thing that
 * reports the gap is running the container.
 *
 * SO THE INVARIANT IS THE ONE THE DOCKERFILES ALREADY STATE IN PROSE, three times over -- next to
 * `metrics.py`, next to `capture_worker.py`/`capture.py`, and now next to `directory_publish.py`:
 * "imported at module scope, so a missing COPY here is a crash loop on start". A comment restating
 * a rule three times is a rule worth checking.
 *
 * =================================================================================================
 * WHY MODULE SCOPE, AND WHY THAT IS THE RIGHT LINE TO DRAW
 *
 * An import inside a function fails when that function is first called, which may be never. An
 * import at column 0 fails at interpreter start, before the daemon connects to anything -- which is
 * why these modules are deliberately imported there (see ingestion.py's own comment on
 * `import directory_publish`). This checks the imports whose absence is a startup failure, because
 * those are the ones a build must satisfy and the ones a container cannot work around.
 *
 * =================================================================================================
 * DIRECTORY-LOCAL, DELIBERATELY
 *
 * A copied module's local imports are resolved against ITS OWN source directory and must be copied
 * by the SAME Dockerfile. That is exactly what the flat `WORKDIR /app` layout of these images
 * means, it needs no model of how each COPY rewrites paths, and it is the whole of the failure
 * mode: `import capture` inside `capture_worker.py` finds a sibling or it finds nothing.
 *
 * Third-party imports (`paho`, `psycopg2`) are not this script's business -- requirements.txt is,
 * and pip fails loudly at build time. Only a name that resolves to a `.py` file sitting beside the
 * importer is checked, because only that one can be silently left behind.
 *
 * Usage:
 *   node scripts/check-image-sources.mjs
 *   node scripts/check-image-sources.mjs --verbose   # also list what each image ships
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

/**
 * The Dockerfiles that ship Python. Listed rather than globbed so a new one is a decision somebody
 * makes here, with the chance to say why if it is genuinely exempt -- the same arrangement
 * check-image-tag-parity.mjs uses for the images built from this repository.
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
 * Physical lines joined on a trailing backslash, comments dropped.
 *
 * test-harness/Dockerfile copies four pairs of files across continuations, so a line-at-a-time
 * reader would see three of every four COPY arguments as free-standing text and silently ignore
 * them -- a checker that misses what it cannot parse is worse than none.
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
 * Every `.py` path a Dockerfile copies, repo-relative.
 *
 * The last argument of a COPY is the DESTINATION and is skipped. `--from=` and other flags are
 * skipped too: a stage-to-stage copy moves a build artefact, not a source file this can resolve
 * against the working tree.
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
 * Module-scope imports: `import x`, `import x as y`, `from x import ...`, at column 0 only.
 *
 * `import a.b` yields `a`, which never resolves to a sibling file and is therefore ignored below --
 * these images have no packages, only flat modules.
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

  // GENERATED MODULES ARE NOT MISSING ONES. `sparkplug_b_pb2` is produced INSIDE the image by
  // protoc from the `.proto` the Dockerfile copies, so it is importable while existing in no COPY.
  // Derived from the Dockerfile rather than waived by name, so an image that stops running protoc
  // stops being granted the exemption in the same edit.
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

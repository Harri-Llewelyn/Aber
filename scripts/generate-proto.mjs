#!/usr/bin/env node
/**
 * Produce ingestion/sparkplug_b_pb2.py, the compiled Sparkplug B protobuf module that
 * ingestion/validate.py imports.
 *
 *   npm run proto
 *
 * Running validate.py from the host previously required protobuf-compiler installed system-wide,
 * which is a package manager away on Linux and an awkward manual download on Windows -- so in
 * practice the end-to-end validation only ever ran in CI. Since the stack itself requires Docker,
 * and the ingestion image already compiles this file with the exact protoc the pinned
 * protobuf==4.25.3 expects, the compiler that is guaranteed to be present is the one in the image.
 *
 * Order of preference:
 *   1. protoc on PATH          -- fastest, and what CI uses.
 *   2. the built ingestion image -- no host install, and version-matched by construction.
 *
 * The output is gitignored: it is generated, and regenerating it is this script's job.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'ingestion');
const OUT_FILE = join(OUT_DIR, 'sparkplug_b_pb2.py');
const PROTO = 'sparkplug_b.proto';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', ...opts });

const quiet = (cmd, args) => {
  try {
    run(cmd, args);
    return true;
  } catch {
    return false;
  }
};

if (!existsSync(join(ROOT, PROTO))) {
  console.error(`Cannot find ${PROTO} in ${ROOT}`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------- 1. protoc on PATH ----
if (quiet('protoc', ['--version'])) {
  run('protoc', [`--python_out=ingestion`, PROTO]);
  console.log(`Compiled with system protoc -> ${OUT_FILE}`);
  process.exit(0);
}

console.log('protoc not on PATH; falling back to the ingestion image.');

// ------------------------------------------------------ 2. the built ingestion image ----
if (!quiet('docker', ['info'])) {
  console.error(
    'Neither protoc nor a running Docker daemon is available.\n' +
    'Install protobuf-compiler, or start Docker and run `docker compose build ingestion` first.'
  );
  process.exit(1);
}

// `docker compose images -q` names the image compose actually built, rather than guessing at the
// project-prefixed name, which varies with the directory the stack was brought up from.
let image;
try {
  image = run('docker', ['compose', 'images', '-q', 'ingestion']).trim().split(/\s+/)[0];
} catch {
  image = '';
}

if (!image) {
  console.log('Ingestion image not built yet; building it (this is a one-off).');
  run('docker', ['compose', 'build', 'ingestion'], { stdio: 'inherit' });
  image = run('docker', ['compose', 'images', '-q', 'ingestion']).trim().split(/\s+/)[0];
}

if (!image) {
  console.error('Could not resolve the ingestion image. Try `docker compose build ingestion`.');
  process.exit(1);
}

// A stopped container is enough to copy a file out of; it is never started.
const scratch = `fp-proto-extract-${process.pid}`;
try {
  run('docker', ['create', '--name', scratch, image]);
  rmSync(OUT_FILE, { force: true });
  run('docker', ['cp', `${scratch}:/app/sparkplug_b_pb2.py`, OUT_FILE]);
} finally {
  quiet('docker', ['rm', '-f', scratch]);
}

if (!existsSync(OUT_FILE)) {
  console.error('Copy reported success but the file is missing.');
  process.exit(1);
}
console.log(`Extracted from the ingestion image -> ${OUT_FILE}`);

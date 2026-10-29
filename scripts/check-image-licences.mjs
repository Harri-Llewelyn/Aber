#!/usr/bin/env node
/**
 * Every third-party image Aber runs or builds on is named in NOTICE.md, and every licence text in
 * licenses/ is the file licenses/SHA256SUMS pins.
 *
 * The images are the tags deploy/helm/aber/values.yaml pins, the literal `image:` lines in the
 * chart's templates, and every Dockerfile's FROM. An image this repository builds (under
 * ghcr.io/harri-llewelyn/aber/, or a values tag left empty for Chart.AppVersion) is not third-party.
 * A Dockerfile that copies from the named context `licenses` must be handed it by every build that
 * names it: a workflow's matrix entry, the dev loop's IMAGES and every documented `docker build`.
 *
 * Static: reads the tree and starts nothing. Usage: node scripts/check-image-licences.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OWN = 'ghcr.io/harri-llewelyn/aber/';
export const NAMED_CONTEXT = 'licenses=./licenses';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'backups']);

/** Every file under `dir`, repository-relative with forward slashes, build output skipped. */
export function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(full.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

/** A Dockerfile's instructions: continuation lines joined, comments and blank lines dropped. */
export function instructions(text) {
  const out = [];
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!current && (line === '' || line.startsWith('#'))) continue;
    if (line.endsWith('\\')) { current += `${line.slice(0, -1)} `; continue; }
    out.push((current + line).trim());
    current = '';
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Each `repository:` in a values file with the `tag:` beside it, as `repo:tag`. `built` is a tag
 * left empty: the chart resolves it from Chart.AppVersion, so the image is one built here.
 */
export function valuesImages(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  lines.forEach((line, i) => {
    const repo = /^(\s*)repository:\s*["']?([^\s"'#]+)/.exec(line);
    if (!repo) return;
    const indent = repo[1];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim() || next.trim().startsWith('#')) continue;
      const own = /^\s*/.exec(next)[0];
      if (own.length < indent.length) break;
      if (own.length !== indent.length) continue;
      const tag = /^tag:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]*))/.exec(next.slice(own.length));
      if (!tag) continue;
      const value = tag[1] ?? tag[2] ?? tag[3] ?? '';
      out.push({ image: value ? `${repo[2]}:${value}` : repo[2], line: i + 1, built: !value });
      return;
    }
    out.push({ image: repo[2], line: i + 1, built: false });
  });
  return out;
}

/** Literal images a chart template names (`image: alpine:3.24`), not ones it renders from values. */
export function templateImages(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*(?:-\s+)?image:\s*["']?([a-z0-9][^\s"'{}]*)["']?\s*$/.exec(line);
    if (m) out.push({ image: m[1], line: i + 1 });
  });
  return out;
}

/** The images a Dockerfile's FROM lines name, with ARG defaults substituted and earlier stages skipped. */
export function dockerfileBases(text) {
  const args = {};
  const stages = new Set();
  const out = [];
  for (const line of instructions(text)) {
    const arg = /^ARG\s+(\w+)(?:=(\S*))?/i.exec(line);
    if (arg) {
      if (arg[2] !== undefined && !(arg[1] in args)) args[arg[1]] = arg[2];
      continue;
    }
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!from) continue;
    const ref = from[1].replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, a, b) => args[a || b] ?? whole);
    if (!stages.has(ref.toLowerCase())) out.push(ref);
    if (from[2]) stages.add(from[2].toLowerCase());
  }
  return out;
}

/** A reference without its digest: NOTICE.md names `python:3.12-slim`, a Dockerfile pins it by digest too. */
export const withoutDigest = (ref) => ref.split('@')[0];

/** Every backticked image-shaped reference NOTICE.md names. */
export function noticeImages(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    if (/^[a-z0-9][\w./-]*(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?$/.test(m[1])) out.add(withoutDigest(m[1]));
  }
  return out;
}

/** The third-party images NOTICE.md does not name, each with where it is pinned. */
export function unlisted(pinned, notice) {
  const listed = noticeImages(notice);
  return pinned.filter((p) => !listed.has(withoutDigest(p.image)));
}

/**
 * licenses/ against licenses/SHA256SUMS: every file pinned, every pin a file with that SHA-256.
 * README.md and SHA256SUMS itself are the folder's own.
 */
export function manifestProblems(dir) {
  const problems = [];
  const pinned = new Map();
  const manifest = join(dir, 'SHA256SUMS');
  if (!existsSync(manifest)) return { problems: ['licenses/SHA256SUMS does not exist'], pinned };
  readFileSync(manifest, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const m = /^([0-9a-f]{64}) [ *]([^\s].*)$/.exec(line);
    if (!m || m[2].split('/').some((s) => s === '..' || s === '') || m[2].startsWith('/')) {
      problems.push(`licenses/SHA256SUMS:${i + 1} is not "<sha256>  <path inside licenses/>"`);
      return;
    }
    if (pinned.has(m[2])) problems.push(`licenses/SHA256SUMS pins ${m[2]} twice`);
    pinned.set(m[2], m[1]);
  });
  for (const file of walk(dir).filter((f) => f !== 'SHA256SUMS' && f !== 'README.md')) {
    if (!pinned.has(file)) problems.push(`licenses/${file} is not pinned in licenses/SHA256SUMS`);
  }
  for (const [file, sha] of pinned) {
    const full = join(dir, file);
    if (!existsSync(full) || !statSync(full).isFile()) {
      problems.push(`licenses/SHA256SUMS pins licenses/${file}, which does not exist`);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(full)).digest('hex');
    if (actual !== sha) problems.push(`licenses/${file} is sha256:${actual}, pinned to sha256:${sha}`);
  }
  return { problems, pinned };
}

/**
 * The licence sets a Dockerfile copies: `COPY --from=licenses <set>/ <dest>` through the named
 * context, or `COPY licenses/<set>/ <dest>` from a repository-root context.
 */
export function licenceCopies(text) {
  const out = [];
  for (const line of instructions(text)) {
    if (!/^COPY\s/i.test(line)) continue;
    const words = line.split(/\s+/).slice(1);
    const named = words.some((w) => w.toLowerCase() === '--from=licenses');
    const sources = words.filter((w) => !w.startsWith('--')).slice(0, -1);
    for (const src of sources) {
      if (named) out.push({ named: true, set: src.replace(/\/+$/, '') });
      else if (src.startsWith('licenses/')) out.push({ named: false, set: src.slice('licenses/'.length).replace(/\/+$/, '') });
    }
  }
  return out;
}

/** `docker build` commands in a text, continuation lines joined and a continued comment's `#` dropped. */
export function buildCommands(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  lines.forEach((line, i) => {
    if (!/\bdocker (?:buildx )?build\b/.test(line)) return;
    let command = line;
    for (let j = i; j + 1 < lines.length && /\\\s*$/.test(lines[j]); j += 1) {
      command += ` ${lines[j + 1].replace(/^\s*(?:#\s*)?/, '')}`;
    }
    out.push({ line: i + 1, command });
  });
  return out;
}

const passesContext = (command) => /--build-context[ =]licenses=\.\/licenses(?![\w./-])/.test(command);

/**
 * Where a build of `dockerfile` is not handed the `licenses` context: a workflow matrix entry
 * without it, a build-push-action step that drops the entry's contexts, the dev loop's IMAGES
 * entry, a documented `docker build`, or docker-bake.hcl.
 */
export function namedContextProblems(dockerfile, { workflows, devCluster, texts, bake }) {
  const problems = [];
  for (const { path, text } of workflows) {
    const chunks = text.split(/\n(?=\s*- name: )/);
    const entry = chunks.find((c) => c.split('\n').some((l) => l.trim() === `dockerfile: ${dockerfile}`));
    if (entry) {
      const contexts = entry.split('\n').map((l) => l.trim()).find((l) => l.startsWith('build_contexts:')) || '';
      if (!contexts.split(/[\s,]+/).includes(NAMED_CONTEXT)) problems.push(`${path}'s matrix entry for ${dockerfile} passes no ${NAMED_CONTEXT} in build_contexts`);
    }
    for (const step of chunks.filter((c) => /uses: docker\/build-push-action@/.test(c))) {
      const file = /^\s*file:\s*(.+?)\s*$/m.exec(step)?.[1];
      const contexts = /^\s*build-contexts:\s*(.+?)\s*$/m.exec(step)?.[1] || '';
      const name = /- name: (.*)/.exec(step)?.[1];
      if (file === dockerfile && !contexts.split(/[\s,]+/).includes(NAMED_CONTEXT)) {
        problems.push(`${path}: the step "${name}" builds ${dockerfile} without ${NAMED_CONTEXT}`);
      }
      if (file === '${{ matrix.dockerfile }}' && entry && contexts !== '${{ matrix.build_contexts }}') {
        problems.push(`${path}: the step "${name}" does not pass its matrix entry's build_contexts`);
      }
    }
  }
  const devEntry = devCluster.split('\n').find((l) => l.includes(`file: '${dockerfile}'`));
  if (!devEntry) problems.push(`scripts/dev-cluster.mjs's IMAGES has no entry for ${dockerfile}`);
  else if (!devEntry.includes(`'${NAMED_CONTEXT}'`)) problems.push(`scripts/dev-cluster.mjs's IMAGES entry for ${dockerfile} names no '${NAMED_CONTEXT}' in contexts`);
  for (const { path, text } of texts) {
    for (const c of buildCommands(text)) {
      if (c.command.split(/\s+/).includes(dockerfile) && !passesContext(c.command)) {
        problems.push(`${path}:${c.line} builds ${dockerfile} without --build-context ${NAMED_CONTEXT}`);
      }
    }
  }
  if (bake.includes(dockerfile) && !/contexts\s*=\s*\{[^}]*"licenses"\s*=/.test(bake)) {
    problems.push(`docker-bake.hcl builds ${dockerfile} with no "licenses" context`);
  }
  return problems;
}

function main() {
  let failed = false;
  const fail = (m) => { failed = true; console.log(`  FAIL  ${m}`); };
  const pass = (m) => console.log(`  ok    ${m}`);
  const read = (f) => readFileSync(join(REPO, f), 'utf8');
  const files = walk(REPO);

  // 1. Every third-party image is named in NOTICE.md.
  const VALUES = 'deploy/helm/aber/values.yaml';
  const pinned = [];
  for (const v of valuesImages(read(VALUES))) {
    if (!v.built && !v.image.startsWith(OWN)) pinned.push({ image: v.image, at: `${VALUES}:${v.line}` });
  }
  for (const t of files.filter((f) => /^deploy\/helm\/aber\/templates\/.+\.(?:ya?ml|tpl)$/.test(f))) {
    for (const i of templateImages(read(t))) pinned.push({ image: i.image, at: `${t}:${i.line}` });
  }
  const dockerfiles = files.filter((f) => /(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/.test(f));
  for (const d of dockerfiles) {
    for (const ref of dockerfileBases(read(d))) {
      if (ref.includes('$')) fail(`${d}: FROM ${ref} names no image this check can resolve`);
      else if (!ref.startsWith(OWN)) pinned.push({ image: ref, at: d });
    }
  }
  const missing = unlisted(pinned, read('NOTICE.md'));
  for (const m of missing) fail(`${m.image} (${m.at}) is not named in NOTICE.md`);
  if (!missing.length) pass(`NOTICE.md names all ${new Set(pinned.map((p) => withoutDigest(p.image))).size} third-party images pinned in values.yaml, the templates and ${dockerfiles.length} Dockerfiles`);

  // 2. The vendored texts are the ones SHA256SUMS pins.
  const { problems, pinned: texts } = manifestProblems(join(REPO, 'licenses'));
  for (const p of problems) fail(p);
  if (!problems.length) pass(`licenses/ holds the ${texts.size} files SHA256SUMS pins, each at its SHA-256`);

  // 3. Each licence set a Dockerfile copies exists, and a named-context copy is handed the context.
  const sets = new Set([...texts.keys()].map((f) => f.split('/')[0]));
  const context = {
    workflows: files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).map((path) => ({ path, text: read(path) })),
    devCluster: read('scripts/dev-cluster.mjs'),
    texts: files
      .filter((f) => /\.(?:md|ya?ml|sh|mjs|js|hcl|txt|tpl)$/.test(f) && !/^scripts\/check-image-licences(?:\.test)?\.mjs$/.test(f))
      .map((path) => ({ path, text: read(path) })),
    bake: existsSync(join(REPO, 'docker-bake.hcl')) ? read('docker-bake.hcl') : '',
  };
  let copying = 0;
  const wrong = [];
  for (const d of dockerfiles) {
    const copies = licenceCopies(read(d));
    if (!copies.length) continue;
    copying += 1;
    for (const c of copies) if (!sets.has(c.set)) wrong.push(`${d} copies the licence set ${c.set}/, which licenses/ does not pin`);
    if (copies.some((c) => c.named)) wrong.push(...namedContextProblems(d, context));
  }
  for (const w of wrong) fail(w);
  if (!wrong.length) pass(`${copying} Dockerfiles copy pinned licence sets, and every build of one through the named context passes it`);

  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main();

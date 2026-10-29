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
 * Every image built on supabase/postgres carries the written offers of its GPL extensions' source.
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

/**
 * The written offers of source for the GPL extensions the base ships, under licenses/. Every image
 * built on OFFER_BASE copies them, and each names that base and the version and tag of its row in
 * NOTICE.md's extension table, which was read from the image.
 */
export const OFFER_BASE = 'supabase/postgres';
export const OFFERS = [
  { file: 'supabase-postgres/postgis/SOURCE', extension: 'postgis' },
  { file: 'supabase-postgres/pgrouting/SOURCE', extension: 'pgrouting' },
];

const escapeRe = (s) => s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

/**
 * The NOTICE.md extension-table row whose first named extension is `name`: its version, and the
 * project's repository and tag (`[`postgis/postgis`](https://github.com/postgis/postgis) `3.3.7``).
 */
export function noticeExtension(notice, name) {
  for (const line of notice.split(/\r?\n/)) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4 || /`([^`]+)`/.exec(cells[0])?.[1] !== name) continue;
    const repo = /\]\((https:\/\/github\.com\/[^)\s]+)\)/.exec(cells[3])?.[1];
    const tag = [...cells[3].matchAll(/`([^`]+)`/g)].pop()?.[1];
    return repo && tag ? { version: cells[1], repo, tag } : null;
  }
  return null;
}

/**
 * Where the written offers fall short: an offer missing or unpinned, an image built on OFFER_BASE
 * whose Dockerfile does not copy it, or an offer naming another base tag, or another version of
 * its extension, than the images and NOTICE.md do. `dockerfiles` is every Dockerfile, as
 * { path, text }.
 */
export function offerProblems(dir, pinned, notice, dockerfiles) {
  const problems = [];
  const built = dockerfiles
    .map(({ path, text }) => ({ path, text, bases: dockerfileBases(text).map(withoutDigest).filter((b) => b.startsWith(`${OFFER_BASE}:`)) }))
    .filter((d) => d.bases.length);
  if (!built.length) return [`no Dockerfile builds on ${OFFER_BASE}, so the check of its written offers reads nothing`];
  const bases = new Set(built.flatMap((d) => d.bases));

  for (const { file, extension } of OFFERS) {
    const full = join(dir, file);
    if (!existsSync(full)) {
      problems.push(`licenses/${file} does not exist, so the images built on ${OFFER_BASE} carry no written offer of ${extension}'s source`);
      continue;
    }
    if (!pinned.has(file)) problems.push(`licenses/${file}, the written offer of ${extension}'s source, is not pinned in licenses/SHA256SUMS`);
    const set = file.split('/')[0];
    for (const { path, text } of built) {
      if (!licenceCopies(text).some((c) => c.set === set)) problems.push(`${path} builds on ${OFFER_BASE} and does not copy licenses/${set}/, so its image carries no ${file}`);
    }

    const text = readFileSync(full, 'utf8');
    for (const base of bases) if (!text.includes(base)) problems.push(`licenses/${file} does not name ${base}, the base its images are built on`);
    for (const [, tag] of text.matchAll(new RegExp(`\\b${escapeRe(OFFER_BASE)}:([\\w.-]*\\w)`, 'g'))) {
      if (!bases.has(`${OFFER_BASE}:${tag}`)) problems.push(`licenses/${file} names ${OFFER_BASE}:${tag}, which no image builds on`);
    }
    const row = noticeExtension(notice, extension);
    if (!row) {
      problems.push(`NOTICE.md's extension table has no row for ${extension} naming its version and repository tag`);
      continue;
    }
    const link = `${row.repo}/tree/${row.tag}`;
    if (!text.includes(link)) problems.push(`licenses/${file} does not link ${link}, the ${extension} NOTICE.md says the image ships`);
    for (const [, tag] of text.matchAll(new RegExp(`${escapeRe(row.repo)}/tree/([^\\s/]+)`, 'g'))) {
      if (tag !== row.tag) problems.push(`licenses/${file} links ${extension} at ${tag}, not ${row.tag}`);
    }
    if (!new RegExp(`(?<![\\w.])${escapeRe(row.version)}(?![\\w]|\\.\\d)`).test(text)) problems.push(`licenses/${file} does not name ${extension} ${row.version}`);
  }
  return problems;
}

/** The NOTICE.md paragraph that opens the table of the libraries only PostGIS loads. */
export const LIBRARIES_HEADING = '**The libraries only PostGIS loads.**';

/** That table's rows as { name, version, licence }; `name` is the library cell's first word. */
export function noticeLibraries(notice) {
  const start = notice.indexOf(LIBRARIES_HEADING);
  if (start === -1) return [];
  const rows = [];
  let inTable = false;
  for (const line of notice.slice(start).split(/\r?\n/)) {
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3 || cells[0] === 'Library' || /^:?-+/.test(cells[0])) continue;
    rows.push({ name: cells[0].split(/[\s,]/)[0], version: cells[1], licence: cells[2] });
  }
  return rows;
}

/**
 * Where the copyleft libraries NOTICE.md lists and the PostGIS offer disagree: a library the
 * offer does not name at the listed version, one with no licence folder in `set` (its name in
 * lower case), or a folder in `set` beside `own` that is no listed library.
 */
export function libraryProblems(notice, offer, folders, own) {
  const copyleft = noticeLibraries(notice).filter((l) => /GPL/.test(l.licence));
  if (!copyleft.length) return [`NOTICE.md has no copyleft row under "${LIBRARIES_HEADING}"; the parse has stopped matching it`];
  const problems = [];
  for (const { name, version } of copyleft) {
    if (!new RegExp(`(?<![\\w.])${escapeRe(`${name} ${version}`)}(?![\\w]|\\.\\d)`).test(offer)) {
      problems.push(`licenses/${OFFERS[0].file} does not name ${name} ${version}, which NOTICE.md lists`);
    }
    if (!folders.includes(name.toLowerCase())) problems.push(`NOTICE.md lists ${name}, and licenses/supabase-postgres/${name.toLowerCase()}/ holds no licence text for it`);
  }
  const listed = new Set(copyleft.map((l) => l.name.toLowerCase()));
  for (const f of folders) {
    if (!own.includes(f) && !listed.has(f)) problems.push(`licenses/supabase-postgres/${f}/ is no copyleft library NOTICE.md lists`);
  }
  return problems;
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

  // 4. The written offers of the GPL extensions' source travel with every image built on their base.
  const onBase = dockerfiles.map((path) => ({ path, text: read(path) }));
  const offers = offerProblems(join(REPO, 'licenses'), texts, read('NOTICE.md'), onBase);
  for (const o of offers) fail(o);
  if (!offers.length) {
    const count = onBase.filter((d) => dockerfileBases(d.text).some((b) => b.startsWith(`${OFFER_BASE}:`))).length;
    pass(`the ${count} images built on ${OFFER_BASE} copy the pinned written offers of ${OFFERS.map((o) => o.extension).join(' and ')}'s source, `
      + 'each naming the base and the version NOTICE.md says the image ships');
  }

  // 5. The copyleft libraries only PostGIS loads: NOTICE.md, the offer and the vendored texts agree.
  const setDir = join(REPO, 'licenses', 'supabase-postgres');
  const folders = readdirSync(setDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const offer = existsSync(join(REPO, 'licenses', OFFERS[0].file)) ? read(`licenses/${OFFERS[0].file}`) : '';
  const libraries = libraryProblems(read('NOTICE.md'), offer, folders, ['supabase-postgres', 'postgresql', 'postgis', 'pgrouting']);
  for (const l of libraries) fail(l);
  if (!libraries.length) {
    const named = noticeLibraries(read('NOTICE.md')).filter((l) => /GPL/.test(l.licence)).map((l) => l.name);
    pass(`the ${named.length} copyleft libraries only PostGIS loads (${named.join(', ')}) are in NOTICE.md, the offer and licenses/ alike`);
  }

  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main();

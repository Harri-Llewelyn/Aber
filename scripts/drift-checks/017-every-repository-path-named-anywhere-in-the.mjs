import { existsSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { allFiles, fail, gitignored, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 17. Every repository path named anywhere in the tree names a path that exists.
//
// A comment citing a deleted script is the shape #339 went looking for: internally coherent,
// naming a real-looking path, and false. A reader auditing a coupling follows the pointer, finds
// nothing, and cannot tell whether the guard moved or was dropped. Seven live files named
// `scripts/check-image-tag-parity.mjs` when this check was written; it had gone with the second
// deployment target, and four of the seven were the only statement of a coupling that still
// mattered. Two comments went on citing migrations by their path after the chain was archived.
//
// WHAT IS A CITATION: a script path however it is rooted, and a path under one of the repository's
// top-level directories that ends in a file extension or `/`. A bare two-part name such as
// `supabase/postgres` or `deploy/ingestion` is an image or a kubectl resource more often than a
// directory, so it is not read. A gitignored path (`values-local.yaml`, `frontend/dist/`) is
// absent from the tree by design, so it is neither checked when cited nor read for citations.
//
// A DELIBERATE MENTION OF A DEAD PATH IS ALLOWED, and has to say so on its own line: a line
// carrying "deleted", "retired", "removed", "replaced", "gone", "former" or "proposed" is history
// rather than a pointer. That is the whole exemption, so a stale citation cannot hide behind a
// file's reputation. Exempt wholesale: `docs/incidents.md`, where naming the path an incident
// happened to is the point; `docs/roadmap.md`, the record of what retired;
// `supabase/migrations/archive/`, which is never executed; and
// `supabase/config.toml`, the Supabase CLI's stock file.
//
// A CITATION IS RESOLVED THE WAY A READER WOULD RESOLVE IT: a leading `../` against the citing
// file's own directory; anything else against it, the repository root and each directory above
// the citing file, because a path can be written relative to a root that is not this repository's
// -- a Helm template names `files/scripts/...` relative to the chart. Last, as the tail of a path
// in the tree: a layout drawn relative to `templates/` names `supabase/realtime-service.yaml`.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const PAST = /\b(deleted|retired|removed|replaced|gone|superseded|former|formerly|proposed)\b/i;
  // The two tests of the fold build a throwaway repository, and name the paths in it.
  const EXEMPT = ['docs/incidents.md', 'docs/roadmap.md', 'supabase/config.toml',
    'scripts/fold-unreleased.test.mjs', 'scripts/lib/unreleased-notes.test.mjs'];
  const scanned = allFiles.filter(
    (f) =>
      !EXEMPT.includes(f) &&
      !gitignored(f) &&
      !/(^|\/)\.(?:git|docker)ignore$/.test(f) &&
      !f.startsWith('supabase/migrations/archive/') &&
      !f.startsWith('frontend/dist/') &&
      !f.startsWith('.claude/') &&
      !f.startsWith('backups/') &&
      !/\.(png|jpe?g|gif|ico|svg|woff2?|ttf|zip|gz|pdf|glb)$/i.test(f)
  );

  const TOP = readdirSync(REPO, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !['.git', 'node_modules'].includes(e.name))
    .map((e) => e.name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'));
  const REPO_PATH = new RegExp(String.raw`(?<![\w./@:$~-])((?:\.{1,2}/)*(?:${TOP.join('|')})/[\w.@/-]*)`, 'g');
  const SCRIPT_PATH = /((?:\.{1,2}\/)*(?:[\w.-]+\/)*scripts\/[\w.-]+\.(?:mjs|js|sh|py))/g;

  const dead = [];
  let citations = 0;
  for (const file of scanned) {
    let text;
    try { text = read(file); } catch { continue; }
    if (text.includes('\0')) continue;
    // A check module resolves a citation from scripts/, where the one script that held it stood.
    const here = /^scripts\/(?:drift|mirror)-checks\/\d/.test(file) ? 'scripts' : posix.dirname(file);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const cited = new Set([...lines[i].matchAll(SCRIPT_PATH)].map((m) => m[1]));
      for (const m of lines[i].matchAll(REPO_PATH)) {
        const path = m[1].replace(/\.+$/, '');
        if (path.endsWith('/') || /\.\w+$/.test(path.split('/').pop())) cited.add(path);
      }
      for (const path of cited) {
        citations += 1;
        const bare = posix.normalize(path).replace(/\/$/, '');
        if (gitignored(bare)) continue;
        const candidates = [posix.normalize(posix.join(here, path))];
        if (!path.startsWith('../')) {
          candidates.push(bare);
          for (let d = here; d !== '.' && d !== '/'; d = posix.dirname(d)) {
            candidates.push(posix.normalize(posix.join(d, path)));
          }
        }
        if (candidates.some((c) => existsSync(join(REPO, c)))) continue;
        if (allFiles.some((f) => `/${f}`.endsWith(`/${bare}`) || `/${f}`.includes(`/${bare}/`))) continue;
        if (PAST.test(lines[i])) continue;
        dead.push(`${file}:${i + 1} cites ${path}, which does not exist`);
      }
    }
  }

  if (dead.length) {
    fail(
      'a comment or document cites a path that is not in the tree:\n' +
        [...new Set(dead)].map((d) => `        ${d}`).join('\n') +
        '\n        (if the path is deliberately gone, say so on the same line)'
    );
  } else {
    pass(`all ${citations} repository path citation(s) name a path that exists`);
  }
}

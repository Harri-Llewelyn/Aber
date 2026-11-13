import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fail, MARKDOWN, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 1. Every local markdown link resolves, and every #anchor names a heading in the file it points
// at. Moving a section between documents breaks anchors and nothing else, so the anchor is checked
// too: GitHub's slug rule, a -N suffix for repeated headings, and explicit <a name|id>.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const anchorCache = new Map();
  const anchorsOf = (path) => {
    if (anchorCache.has(path)) return anchorCache.get(path);
    const anchors = new Set();
    const seen = new Map();
    let fence = false;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      const heading = line.match(/^#{1,6}\s+(.*?)\s*$/);
      if (heading) {
        const slug = heading[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
        const n = seen.get(slug) || 0;
        seen.set(slug, n + 1);
        anchors.add(n ? `${slug}-${n}` : slug);
      }
      for (const m of line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(m[1]);
    }
    anchorCache.set(path, anchors);
    return anchors;
  };

  const docs = MARKDOWN;
  let broken = 0;
  let anchored = 0;
  for (const doc of docs) {
    const body = read(doc);
    for (const [, , target] of body.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [clean, anchor] = target.split('#');
      const p = clean ? normalize(join(REPO, dirname(doc), clean)) : join(REPO, doc);
      if (!existsSync(p)) {
        fail(`${doc}: broken link -> ${target}`);
        broken += 1;
        continue;
      }
      if (!anchor || !p.endsWith('.md')) continue;
      anchored += 1;
      if (!anchorsOf(p).has(decodeURIComponent(anchor))) {
        fail(`${doc}: link -> ${target} names no heading in ${clean || doc}`);
        broken += 1;
      }
    }
  }
  if (!broken) pass(`all local links resolve across ${docs.length} markdown files, ${anchored} of them to a heading`);
}

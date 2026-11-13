import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { allFiles, fail, gitignored, OPERATOR_PAIRS, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 116. A pointer at a reference page of OPERATOR_PAIRS names a section that page still has. Check 1
// follows links; this reads words, a sentence at a time (comment markers and backticks off, wrapped
// lines joined). A title in italics or quotes, after `→`, or after a comma or `;` that follows a
// file's name belongs to the nearest file named before it, else after it, unless it is the text of
// a link to a heading of its own page, which check 1 resolves. A bare "runbook" is
// deploy/k8s/README.md, and a reference page that names no file names itself. It fails when the
// title heads a section of a help page of a pair and none of that file's; so does a `§N` just after
// the name (or alone in the page itself), or a `#anchor` on it. Records and mirrors are skipped.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const pairs = OPERATOR_PAIRS.filter((p) => p.moved !== false && existsSync(join(REPO, p.design)) && existsSync(join(REPO, p.help)));
  /** A page's headings below its title, outside code fences, with their numbers and anchors. */
  const headingsOf = (file) => {
    const out = [];
    const seen = new Map();
    let fence = false;
    for (const line of read(file).split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      const h = !fence && line.match(/^(#{1,6})\s+(.*?)\s*$/);
      if (!h) continue;
      const slug = h[2].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
      const n = seen.get(slug) || 0;
      seen.set(slug, n + 1);
      const [, number, title] = h[2].replace(/`/g, '').match(/^(?:(\d+)\.\s+)?(.*)$/);
      if (h[1].length > 1) out.push({ title, number, id: n ? `${slug}-${n}` : slug });
    }
    return out;
  };
  const moved = pairs.flatMap((p) => headingsOf(p.help).map((h) => ({ ...h, page: p.help })));
  // For each reference page, the help headings it does not have, by title, by number and by anchor;
  // where two help pages share one, its own pair's is the one named.
  const lacks = new Map(pairs.map(({ design, help }) => {
    const mine = headingsOf(design);
    const ours = [...moved.filter((h) => h.page === help), ...moved.filter((h) => h.page !== help)];
    const by = (key) => {
      const has = new Set(mine.map((h) => h[key]).filter(Boolean));
      const out = new Map();
      for (const h of ours) if (h[key] && !has.has(h[key]) && !out.has(h[key])) out.set(h[key], h);
      return out;
    };
    return [design, { title: by('title'), number: by('number'), id: by('id') }];
  }));
  const RUNBOOK = 'deploy/k8s/README.md';
  const titles = [...new Set(moved.map((h) => h.title))];
  // A reference page is named by its path, relative or from the root, or, for the runbook, by the word.
  const names = [...lacks.keys()].map((t) => ({ dir: posix.dirname(t), base: posix.basename(t), tail: t.split('/').slice(-2).join('/') }));
  const mayName = (file, text) => /runbook/i.test(text) ||
    names.some((n) => text.includes(n.tail) || ((n.base !== 'README.md' || posix.dirname(file) === n.dir) && text.includes(n.base)));
  const MENTION = /(?:\.{1,2}\/)*(?:[\w.-]+\/)*[\w.-]+\.md\b|\b[Rr]unbook\b/g;
  const exists = new Map();
  const targetOf = (file, m) => {
    if (/^[Rr]unbook$/.test(m)) return RUNBOOK;
    const local = posix.normalize(posix.join(posix.dirname(file), m));
    if (!exists.has(local)) exists.set(local, existsSync(join(REPO, local)));
    const path = exists.get(local) ? local : posix.normalize(m.replace(/^(?:\.{1,2}\/)+/, ''));
    return lacks.has(path) ? path : null;
  };
  const closes = (after) => /^(?:[*"”)\],.;:]|\s+(?:→|and\b)|$)/.test(after);

  /** A file's sentences, with a line lookup: comment markers and backticks off, wrapped lines joined. */
  const sentencesOf = (file, body) => {
    const md = file.endsWith('.md');
    const out = [];
    let para = [];
    const flush = () => {
      const joined = para.map((p) => p.text).join(' ');
      const starts = [];
      para.reduce((at, p) => { starts.push(at); return at + p.text.length + 1; }, 0);
      const lines = para.map((p) => p.line);
      let start = 0;
      for (const end of [...[...joined.matchAll(/[.!?]\s+(?=[A-Z*_"“([])/g)].map((m) => m.index + 1), joined.length]) {
        const text = joined.slice(start, end).trimStart();
        const from = end - text.length;
        out.push({ text, lineAt: (at) => lines[starts.findLastIndex((s) => s <= from + at)] });
        start = end;
      }
      para = [];
    };
    let fence = false;
    body.split('\n').forEach((raw, i) => {
      const isFence = /^\s*(```|~~~)/.test(raw);
      if (isFence) fence = !fence;
      if (md && !fence && /^#{1,6}\s/.test(raw)) { flush(); return; }
      const text = raw.replace(/^\s*(?:\{\{-?\s*)?(?:\/\*+|\*+\/?|\/\/+|#+|--|;+|<!--)(?=\s|$)/, '')
        .replace(/\\"/g, '"').replace(/`/g, '').trim();
      if (!text || isFence || /^(?:\||[-+]\s|\d+\.\s)/.test(text) || (md && /^\s*\*\s/.test(raw))) flush();
      if (text && !isFence) para.push({ text, line: i + 1 });
    });
    flush();
    return out;
  };

  // Records keep the names of their day, and a mirror or a generated copy is its source's.
  const SKIP = /^(?:docs\/incidents\.md$|supabase\/migrations\/archive\/|frontend\/dist\/|\.claude\/|backups\/|deploy\/helm\/aber\/files\/)|\.generated\.[jt]s$|(?:^|\/)package-lock\.json$/;
  const TEXT = /\.(?:md|mjs|cjs|js|jsx|ts|tsx|py|sh|ya?ml|tpl|txt|ini|conf|toml|sql|json|hcl)$|(?:^|\/)Dockerfile[^/]*$/;
  const wrong = [];
  let named = 0;
  for (const file of allFiles.filter((f) => TEXT.test(f) && !SKIP.test(f) && !gitignored(f))) {
    const self = lacks.has(file) ? file : null;
    const body = read(file);
    if (!self && !mayName(file, body)) continue;
    for (const { text, lineAt } of sentencesOf(file, body)) {
      if (!self && !mayName(file, text)) continue;
      const mentions = [...text.matchAll(MENTION)].map((m) => ({ at: m.index, end: m.index + m[0].length, target: targetOf(file, m[0]) }));
      if (mentions.some((m) => m.target)) named += 1;
      else if (!self) continue;
      const blame = (at) => {
        const near = mentions.filter((m) => m.end <= at).pop() || mentions.find((m) => m.at >= at);
        return near ? near.target : self;
      };
      const report = (at, target, h, as) => wrong.push(`${file}:${lineAt(at)} names ${target} with ${as}, which is a section of ${h.page}, not of ${target}`);
      for (const title of titles) {
        for (let at = text.indexOf(title); at >= 0; at = text.indexOf(title, at + 1)) {
          if (/^[*"”]?\]\(#/.test(text.slice(at + title.length))) continue;
          const lead = text.slice(Math.max(0, at - 4), at);
          const listed = mentions.some((m) => m.end <= at && /^[)\]"']*[,;]\s+$/.test(text.slice(m.end, at)));
          if (!(/[*"“[]$|→\s+$/.test(lead) || listed) || !closes(text.slice(at + title.length, at + title.length + 8))) continue;
          const target = blame(at);
          const h = target && lacks.get(target).title.get(title);
          if (h) report(at, target, h, `"${title}"`);
        }
      }
      for (const m of text.matchAll(/§\s?(\d+)(?![.\d])/g)) {
        const before = mentions.filter((x) => x.end <= m.index).pop();
        const target = before && /^[\s'"\]]*$/.test(text.slice(before.end, m.index)) ? before.target : mentions.length ? null : self;
        const h = target && lacks.get(target).number.get(m[1]);
        if (h) report(m.index, target, h, `§${m[1]}`);
      }
      for (const m of mentions.filter((x) => x.target)) {
        const anchor = text.slice(m.end).match(/^#([\p{L}\p{N}_-]+)/u)?.[1];
        const h = anchor && lacks.get(m.target).id.get(anchor);
        if (h) report(m.at, m.target, h, `#${anchor}`);
      }
    }
  }
  if (wrong.length) {
    fail('a pointer names a reference page with a section that moved into a help page of help/site/:\n' +
      wrong.map((w) => `        ${w}`).join('\n') + '\n        Name the help page that holds the section now.');
  } else {
    pass(`the ${named} sentence(s) that name one of the ${pairs.length} reference page(s) split into help/site/, and those pages themselves, name none of the ${moved.length} section(s) that moved`);
  }
}

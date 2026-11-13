import { fail, HELP_PAGES, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 117. A pointer inside a help page names a section of that page, where the panel can scroll to it.
// A title in italics or quotes followed by "above" or "below" (wrapped lines joined, code blocks
// skipped) is a heading on that side of it: its words, its number or letter, or a path of those
// joined by →. A `§N` anywhere on the page, code blocks included, needs a heading numbered N there.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const plain = (s) => s.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  // Inside a code span, `*` and quotes are code, not emphasis or a quoted title.
  const unquote = (s) => s.replace(/`[^`]*`/g, (c) => c.replace(/[*"“”]/g, '\u0001'));
  const POINTER = /(?<![*\w])\*(?![*\s])([^*]+?)\*(?![*\w])[,;]?\s+(above|below)\b|["“]([^"“”]+)["”][,;]?\s+(above|below)\b/g;
  const wrong = [];
  let pointers = 0;
  for (const file of HELP_PAGES) {
    const lines = read(file).split('\n');
    const headings = [];
    const numbered = new Set();
    const sections = [];
    const paragraphs = [];
    let para = null;
    let fence = false;
    lines.forEach((raw, i) => {
      for (const m of raw.matchAll(/§\s?(\d+)/g)) sections.push({ n: m[1], line: i + 1 });
      if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; para = null; return; }
      if (fence) return;
      const h = raw.match(/^#{1,6}\s+(.*?)\s*$/);
      if (h) {
        const label = h[1].match(/^(\d+|[A-Z])\.\s+(.*)$/);
        headings.push({ line: i + 1, names: [h[1], ...(label ? label.slice(1) : [])].map(plain) });
        if (label && /^\d+$/.test(label[1])) numbered.add(label[1]);
        para = null;
        return;
      }
      const text = raw.replace(/^\s*(?:>\s?)*/, '').trim();
      if (!text) { para = null; return; }
      if (!para) { para = { text: '', starts: [], lines: [] }; paragraphs.push(para); }
      para.starts.push(para.text.length);
      para.lines.push(i + 1);
      para.text += `${text} `;
    });
    for (const s of sections.filter((x) => !numbered.has(x.n))) {
      wrong.push(`${file}:${s.line} has §${s.n}, and the page has no heading numbered ${s.n}`);
    }
    for (const p of paragraphs) {
      for (const m of unquote(p.text).matchAll(POINTER)) {
        pointers += 1;
        const title = m[1] ?? m[3];
        const side = m[2] ?? m[4];
        const line = p.lines[p.starts.findLastIndex((s) => s <= m.index)];
        const parts = title.split(/\s*→\s*/).map(plain);
        const named = headings.some((h) => (side === 'above' ? h.line < line : h.line > line) &&
          h.names.includes(parts[parts.length - 1])) && parts.every((t) => headings.some((h) => h.names.includes(t)));
        if (!named) wrong.push(`${file}:${line} points at "${title.replace(/\s+/g, ' ')}" ${side}, which is no heading ${side} it on this page`);
      }
    }
  }
  if (wrong.length) {
    fail('a pointer in a help page names a section the page does not hold where it says:\n' +
      wrong.map((w) => `        ${w}`).join('\n') +
      '\n        The help panel shows one page at a time: link to the section, named by its title, on the page that holds it.');
  } else {
    pass(`the ${pointers} above/below pointer(s) in the ${HELP_PAGES.length} help page(s) name a heading on that side of them, and every § names a numbered heading of its page`);
  }
}

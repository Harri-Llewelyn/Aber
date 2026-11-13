import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 193. Every list filter is the shared one, as frontend/README.md says. A `<select>` in a page's
// toolbar (`.filter-bar`, the Filters panel inside it included) takes one value, which is what the
// shared FilterChecklist replaced; System › Logs' Service and Level are the two left, each a value
// service-logs takes one of and records. The README's search threshold is the component's.
// -------------------------------------------------------------------------------------------------
export default function check() {
  /** file -> the aria-label of each select its toolbar may keep, and why. */
  const KEPT_SELECTS = {
    'frontend/src/components/tabs/SystemLogs.jsx': {
      Service: 'the one service whose lines are read, a source rather than a filter over a list',
      Level: 'one level, which service-logs takes and 0225 records with each read',
    },
  };
  /** The end of the JSX tag that opens at `from`, past attribute braces and quotes. */
  const tagEnd = (src, from) => {
    let depth = 0;
    let quote = null;
    for (let i = from; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) return i;
    }
    return -1;
  };
  /** The source of the element `<div` opening at `from` up to its matching `</div>`. */
  const divBlock = (src, from) => {
    let depth = 0;
    let i = from;
    while (i < src.length) {
      const open = src.indexOf('<div', i);
      const close = src.indexOf('</div>', i);
      if (close < 0) return src.slice(from);
      if (open >= 0 && open < close && /[\s>]/.test(src[open + 4])) {
        const end = tagEnd(src, open);
        if (end < 0) return src.slice(from);
        if (src[end - 1] !== '/') depth++;
        i = end + 1;
      } else {
        depth--;
        i = close + 6;
        if (depth === 0) return src.slice(from, i);
      }
    }
    return src.slice(from);
  };

  const problems193 = [];
  const files = allFiles.filter((f) => /^frontend\/src\/components\/(tabs|common)\/[^/]+\.jsx$/.test(f));
  let bars = 0;
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/<div className="filter-bar"/g)) {
      bars += 1;
      const block = divBlock(src, m.index);
      for (const sel of block.matchAll(/<select\b/g)) {
        const end = tagEnd(block, sel.index);
        const label = block.slice(sel.index, end).match(/aria-label="([^"]+)"/)?.[1] ?? '(no aria-label)';
        if (!KEPT_SELECTS[file]?.[label]) {
          const line = src.slice(0, m.index + sel.index).split('\n').length;
          problems193.push(`${file}:${line} has a select "${label}" in its toolbar; use FilterDropdown or FilterList (common/FilterChecklist.jsx)`);
        }
      }
    }
  }
  const checklist = read('frontend/src/components/common/FilterChecklist.jsx');
  const searchAt = Number(checklist.match(/export const SEARCH_AT = (\d+)/)?.[1]);
  const WORDS = { 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 12: 'twelve' };
  const readme = read('frontend/README.md').replace(/\s+/g, ' ');
  if (!Number.isFinite(searchAt)) {
    problems193.push('could not read SEARCH_AT out of frontend/src/components/common/FilterChecklist.jsx');
  } else if (!readme.includes(`Over ${WORDS[searchAt] ?? searchAt} values it has a search box`)) {
    problems193.push(`frontend/README.md does not say "Over ${WORDS[searchAt] ?? searchAt} values it has a search box", the threshold SEARCH_AT holds`);
  }
  for (const phrase of ['common/FilterChecklist.jsx', 'never a `<select>`', '`useUrlList`']) {
    if (!readme.includes(phrase)) problems193.push(`frontend/README.md's toolbar rules do not name ${phrase}`);
  }
  if (bars === 0) problems193.push('found no `.filter-bar` in the components; the shape this check reads has changed');
  if (problems193.length) {
    fail('a list filter is not the shared one, or the README states it otherwise:\n'
      + problems193.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`no toolbar among ${bars} holds a select but System › Logs' Service and Level, and the README states the shared filter's search at ${searchAt} values`);
  }
}

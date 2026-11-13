import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 203. A Filters panel has one scroller, its own. Its lists are sections at full height, so App.css
// may cap or scroll a list's parts (a `max-height`, or an `overflow` of auto or scroll) only under
// `.filter-dropdown-panel`, the one-list toolbar dropdown, which FilterDropdown alone draws. The
// panel finds its lists among its own children, so every list in a FiltersPopover is a FilterList
// written straight into it: not a FilterChecklist or a FilterDropdown, and not inside a `<div>`.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const CSS_FILE = 'frontend/src/App.css';
  const CHECKLIST = 'frontend/src/components/common/FilterChecklist.jsx';
  const PARTS = ['filter-sections', 'filter-section', 'filter-section-head', 'filter-section-body', 'filter-list',
    'filter-checklist', 'filter-checklist-options', 'filter-checklist-section'];
  const css = read(CSS_FILE).replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  /** Every style rule as [selectors, declarations], walking into @media, @supports and the like. */
  const rules = [];
  const walkCss = (src) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) return;
      const head = src.slice(i, open);
      const selector = head.slice(head.lastIndexOf(';') + 1).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
      }
      const body = src.slice(open + 1, j - 1);
      if (!selector.startsWith('@')) rules.push([selector, body]);
      else if (/^@(media|supports|layer|container)\b/.test(selector)) walkCss(body);
      i = j;
    }
  };
  walkCss(css);
  const splitSelectors = (s) => {
    const out = [];
    let depth = 0;
    let from = 0;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '(') depth++;
      else if (s[k] === ')') depth--;
      else if (s[k] === ',' && depth === 0) { out.push(s.slice(from, k).trim()); from = k + 1; }
    }
    out.push(s.slice(from).trim());
    return out;
  };
  /** Whether `selector` names the class `name` itself, not one it begins (`.filter-list-head`). */
  const hasClass = (selector, name) => {
    for (let at = selector.indexOf(`.${name}`); at >= 0; at = selector.indexOf(`.${name}`, at + 1)) {
      if (!/[\w-]/.test(selector[at + name.length + 1] ?? '')) return true;
    }
    return false;
  };
  const scrolls = (body) => /(?:^|[;\s])max-height\s*:/.test(body) || /(?:^|[;\s])overflow(?:-y)?\s*:[^;]*\b(?:auto|scroll)\b/.test(body);

  const problems203 = [];
  let partRules = 0;
  for (const [selectorList, body] of rules) {
    for (const selector of splitSelectors(selectorList)) {
      if (!PARTS.some((p) => hasClass(selector, p))) continue;
      partRules += 1;
      if (scrolls(body) && !hasClass(selector, 'filter-dropdown-panel')) {
        problems203.push(`${CSS_FILE}: "${selector}" caps or scrolls a list's parts outside a toolbar dropdown, a scroller inside the Filters panel's`);
      }
    }
  }
  if (!rules.some(([s, body]) => splitSelectors(s).includes('.filters-popover-controls') && /overflow-y\s*:\s*auto/.test(body))) {
    problems203.push(`${CSS_FILE}: .filters-popover-controls no longer scrolls (overflow-y: auto), so a long panel cannot be read to its end`);
  }
  if (!rules.some(([s, body]) => splitSelectors(s).includes('.filter-dropdown-panel .filter-checklist-options') && scrolls(body))) {
    problems203.push(`${CSS_FILE}: a toolbar dropdown's list (.filter-dropdown-panel .filter-checklist-options) no longer scrolls under its search box`);
  }

  // The dropdown's class is drawn by FilterDropdown and nothing else.
  const jsx = allFiles.filter((f) => /^frontend\/src\/components\/.+\.jsx$/.test(f));
  for (const file of jsx) {
    const src = read(file);
    let at = src.indexOf('filter-dropdown-panel');
    while (at >= 0) {
      const owner = [...src.slice(0, at).matchAll(/export function (\w+)\(/g)].pop()?.[1];
      if (file !== CHECKLIST || owner !== 'FilterDropdown') {
        problems203.push(`${file}: ${owner ?? 'its top level'} draws .filter-dropdown-panel, which App.css lets scroll inside a Filters panel`);
      }
      at = src.indexOf('filter-dropdown-panel', at + 1);
    }
  }

  // Each Filters panel's lists, as the panel finds them.
  let panels = 0;
  let lists = 0;
  for (const file of jsx) {
    const src = read(file);
    for (const m of src.matchAll(/<FiltersPopover\b/g)) {
      const end = src.indexOf('</FiltersPopover>', m.index);
      // A usage example in a doc comment is not a panel.
      if (end < 0 || /^\s*(\*|\/\/)/.test(src.slice(src.lastIndexOf('\n', m.index) + 1, m.index))) continue;
      panels += 1;
      const block = src.slice(m.index, end);
      const line = src.slice(0, m.index).split('\n').length;
      lists += (block.match(/<FilterList\b/g) || []).length;
      for (const [pattern, what] of [[/<FilterChecklist\b/, 'a bare FilterChecklist'], [/<FilterDropdown\b/, 'a FilterDropdown'], [/<div\b/, 'a <div>']]) {
        if (pattern.test(block)) {
          problems203.push(`${file}:${line}'s Filters panel holds ${what}; write each list as a FilterList straight into the panel, which makes it a section`);
        }
      }
    }
  }
  if (panels === 0) problems203.push('found no <FiltersPopover> in the components; the shape this check reads has changed');
  if (partRules === 0) problems203.push(`found no rule on a list's parts in ${CSS_FILE}; the shape this check reads has changed`);
  if (problems203.length) {
    fail('a list in a Filters panel scrolls on its own, or the panel cannot make it a section:\n' +
      problems203.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`a Filters panel is its lists' one scroller: ${partRules} App.css rules on their parts cap none, and ${panels} panels hold ${lists} FilterList sections`);
  }
}

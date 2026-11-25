import { posix } from 'node:path';
import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 610. frontend/README.md's *What the dashboard already has* names every file of components/common
// once and none that has gone, so a feature can look for what exists before it is built. A row says
// what its file is for in few words, and the rows of a group are in order: two branches that each add
// one then seldom meet on a line.
//
// A file one page uses is under *Used by one page*, with that page, and no other file is. A page is an
// entry of navigation.jsx's TABS, whose own file is components/tabs/<Name>Tab.jsx: a file's importers are
// followed, through the components, dialogs and hooks between, up to the pages' files. The sign-in
// screens are one page. App.jsx draws round every page, so what it reaches is no one page's. The hooks'
// table names every hook two pages or more reach without a component of common between.
// -------------------------------------------------------------------------------------------------

const SRC = 'frontend/src/';
const COMMON = 'components/common/';
const HOOKS = 'hooks/';
const README = 'frontend/README.md';
const SECTION = '### What the dashboard already has';
const ONE_PAGE = 'Used by one page';
const HOOK_GROUP = 'Hooks a page is built with';
const SIGN_IN = 'Sign-in';
const MAX_WORDS = 15;

const stem = (file) => posix.basename(file).replace(/\.jsx?$/, '');
const code = (src) => src.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const list = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
/** The order of a group's rows: by name, whatever the case. */
const before = (a, b) => a.toLowerCase() < b.toLowerCase();

export default function check() {
  const problems610 = [];

  const files = allFiles.filter((f) => /^frontend\/src\/.*\.jsx?$/.test(f) && !f.includes('/__tests__/') && !f.startsWith(`${SRC}test/`)).map((f) => f.slice(SRC.length));
  const known = new Set(files);
  const sources = new Map(files.map((f) => [f, code(read(SRC + f))]));

  // Who imports each file, as `from './x'`, `import './x'` or `import('./x')`.
  const importers = new Map(files.map((f) => [f, new Set()]));
  for (const [file, src] of sources) {
    for (const [, spec] of src.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s+)['"](\.[^'"?]+)['"]/g)) {
      const at = posix.normalize(posix.join(posix.dirname(file), spec));
      const target = [at, `${at}.jsx`, `${at}.js`, `${at}/index.js`].find((f) => known.has(f));
      if (target) importers.get(target).add(file);
    }
  }

  // The pages, each with its own file.
  const pageOf = new Map();
  const tabs = /\nexport const TABS = \[\n([\s\S]*?)\n\]/.exec(read(`${SRC}navigation.jsx`).replace(/\r\n/g, '\n'))?.[1] ?? '';
  for (const [, id, label] of tabs.matchAll(/^ {2}\{ id: '([a-z-]+)',\s+label: '([^']+)'/gm)) {
    const file = `components/tabs/${id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('')}Tab.jsx`;
    if (known.has(file)) pageOf.set(file, label);
    else problems610.push(`navigation.jsx lists the page ${label}, and ${SRC}${file} is not there: this check finds a page's own file by that name`);
  }
  if (!pageOf.size) problems610.push(`${SRC}navigation.jsx has no TABS this check can read`);

  /** The pages a file is drawn on, and `frame`: whether App.jsx reaches it. `past` says which importers are followed. */
  const usedBy = (file, past = () => true) => {
    const pages = new Set();
    const seen = new Set([file]);
    let frame = false;
    for (const queue = [file]; queue.length;) {
      for (const by of importers.get(queue.pop())) {
        if (seen.has(by) || !past(by)) continue;
        seen.add(by);
        if (by === 'App.jsx') frame = true;
        else if (pageOf.has(by)) pages.add(pageOf.get(by));
        else if (by.startsWith('components/auth/') || by.startsWith('pages/')) pages.add(SIGN_IN);
        else queue.push(by);
      }
    }
    return { pages: [...pages].sort(), frame };
  };

  // The section's tables: `{ group, page, name, what, rest }` for each row, in order.
  const readme = read(README).replace(/\r\n/g, '\n');
  const from = readme.indexOf(`\n${SECTION}\n`);
  const section = from < 0 ? '' : readme.slice(from + SECTION.length + 2).split(/\n(?:---|#{2,3} .*)\n/)[0];
  if (!section) {
    fail(`check 610: ${README} has no section "${SECTION}", which lists what components/common and hooks hold`);
    return;
  }
  const rows = [];
  for (const part of section.split(/\n#### /).slice(1)) {
    const group = part.slice(0, part.indexOf('\n'));
    for (const line of part.split('\n').filter((l) => l.startsWith('| ') && l.includes('`'))) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const page = group === ONE_PAGE ? cells.shift() : null;
      rows.push({ group, page, name: cells[0].replaceAll('`', ''), what: cells[1] ?? '', rest: cells.slice(1).join(' ') });
    }
  }

  const common = files.filter((f) => f.startsWith(COMMON));
  const hooks = files.filter((f) => f.startsWith(HOOKS));
  const components = rows.filter((r) => r.group !== HOOK_GROUP);
  const hookRows = rows.filter((r) => r.group === HOOK_GROUP);

  // Each file once, where it belongs.
  for (const file of common) {
    const name = stem(file);
    const { pages, frame } = usedBy(file);
    const one = !frame && pages.length === 1 ? pages[0] : null;
    const found = components.filter((r) => r.name === name);
    if (!frame && !pages.length) {
      problems610.push(`${SRC}${file} is drawn on no page: draw it, or take the file and its row out`);
      continue;
    }
    const belongs = one ? `under "${ONE_PAGE}", with ${one}` : 'in the group a person building one would look in';
    if (!found.length) {
      problems610.push(`${SRC}${file} is in no table: give it a row ${belongs}`);
    } else if (found.length > 1) {
      problems610.push(`\`${name}\` has ${found.length} rows: keep the one ${belongs}`);
    } else if (one && found[0].group !== ONE_PAGE) {
      problems610.push(`\`${name}\` is used by ${one} alone and is in "${found[0].group}": its row goes ${belongs}`);
    } else if (!one && found[0].group === ONE_PAGE) {
      problems610.push(`\`${name}\` is under "${ONE_PAGE}" and is used by ${frame ? 'App.jsx, so round every page' : list(pages)}: its row goes ${belongs}`);
    } else if (one && found[0].page !== one) {
      problems610.push(`\`${name}\` is under "${ONE_PAGE}" with ${found[0].page}, and ${one} is the page that uses it`);
    }
  }
  const commonNames = new Set(common.map(stem));
  for (const r of components.filter((row) => !commonNames.has(row.name))) {
    problems610.push(`the table names \`${r.name}\`, which ${SRC}${COMMON} does not have: take its row out`);
  }

  // Each hook a page calls itself.
  for (const file of hooks) {
    const { pages } = usedBy(file, (by) => by !== 'App.jsx' && !by.startsWith(COMMON));
    const found = hookRows.filter((r) => r.name === stem(file)).length;
    if (pages.length > 1 && !found) problems610.push(`${SRC}${file} is called by ${list(pages)} and is not under "${HOOK_GROUP}": give it a row`);
    if (found > 1) problems610.push(`\`${stem(file)}\` has ${found} rows under "${HOOK_GROUP}": keep one`);
  }
  for (const r of hookRows.filter((row) => !hooks.some((f) => stem(f) === row.name))) {
    problems610.push(`the hooks' table names \`${r.name}\`, which ${SRC}${HOOKS} does not have: take its row out`);
  }

  // What a row says: short, and of things that are there.
  const exported = new Set([...sources.values()].flatMap((src) => [...src.matchAll(/^export (?:default )?(?:async )?(?:function|const|class) (\w+)/gm)].map((m) => m[1])));
  for (const r of rows) {
    const words = r.what.split(/\s+/).filter(Boolean).length;
    if (!words || words > MAX_WORDS) problems610.push(`\`${r.name}\` is described in ${words} words: say what it is for in 1 to ${MAX_WORDS}`);
    for (const [, named] of r.rest.matchAll(/`([A-Z]\w+|use[A-Z]\w+|requires\w+)`/g)) {
      if (!exported.has(named) && !commonNames.has(named)) problems610.push(`\`${r.name}\`'s row names \`${named}\`, which nothing under ${SRC} exports`);
    }
  }
  const order = (r) => (r.page ? `${r.page} ${r.name}` : r.name);
  for (const [i, r] of rows.entries()) {
    const last = rows[i - 1];
    if (last?.group === r.group && before(order(r), order(last))) problems610.push(`\`${r.name}\` comes after \`${last.name}\` in "${r.group}": a group's rows are in order of ${r.page ? 'page, then name' : 'name'}`);
  }

  if (problems610.length) {
    fail(`${README}'s "${SECTION.slice(4)}" is not what components/common and hooks hold:\n` + problems610.map((p) => `        ${p}`).join('\n'));
  } else {
    const alone = components.filter((r) => r.group === ONE_PAGE).length;
    pass(`${README} lists the ${common.length} files of components/common once each, ${alone} of them under "${ONE_PAGE}" with the page (${pageOf.size} pages read), and the ${hookRows.length} hooks that two pages or more call`);
  }
}

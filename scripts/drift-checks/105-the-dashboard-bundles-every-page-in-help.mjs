import { posix } from 'node:path';
import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 105. The dashboard bundles every page in help/, and nothing outside frontend/ but help/.
// frontend/src/help/index.js's glob is the door: every Markdown file in help/ matches it, or the
// panel's contents, search and links never reach that page. No import in the bundle's source
// reaches outside frontend/ except into help/, so a contributor document under docs/ cannot ship
// by accident.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const INDEX = 'frontend/src/help/index.js';
  const PAGES = 'help';
  const GLOB = /import\.meta\.glob\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g;
  const quoted = (s) => [...s.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const globs = [...read(INDEX).matchAll(GLOB)].flatMap((m) => quoted(m[1])).filter((g) => !g.startsWith('!'));
  const resolved = globs.map((g) => posix.normalize(posix.join(posix.dirname(INDEX), g)));
  const matcher = (glob) => new RegExp(`^${glob.split('**').map((part) => part.split('*')
    .map((s) => s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
  const wrong = [];
  if (!resolved.length) wrong.push(`${INDEX} has no import.meta.glob, so the help panel bundles no page`);
  for (const r of resolved.filter((g) => !g.startsWith('help/'))) wrong.push(`${INDEX} globs ${r}, which is outside help/`);
  const pages = allFiles.filter((f) => f.startsWith(`${PAGES}/`) && f.endsWith('.md')).sort();
  // `**/` matches no folder as well as any, as Vite's glob does.
  const globbed = (p) => resolved.some((g) => matcher(g).test(p) || matcher(g.replace('**/', '')).test(p));
  for (const f of pages.filter((p) => !globbed(p))) {
    wrong.push(`${f} is not matched by ${INDEX}'s glob, so the dashboard never shows it`);
  }

  const SOURCE = allFiles.filter((f) => f.startsWith('frontend/src/') && /\.(?:jsx?|mjs)$/.test(f)
    && !/\/(?:__tests__|test)\//.test(f) && !/\.test\.[mc]?jsx?$/.test(f));
  const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  let specifiers = 0;
  for (const file of SOURCE) {
    const text = read(file);
    const specs = [...text.matchAll(SPECIFIER)].map((m) => m[1]).concat([...text.matchAll(GLOB)].flatMap((m) => quoted(m[1])));
    for (const spec of specs.filter((s) => /^!?\.{1,2}\//.test(s))) {
      specifiers += 1;
      const at = posix.normalize(posix.join(posix.dirname(file), spec.replace(/^!/, '').split('?')[0]));
      if (!at.startsWith('frontend/') && !at.startsWith('help/')) wrong.push(`${file} imports ${spec}, which is outside frontend/ and help/`);
    }
  }
  if (wrong.length) {
    fail('the dashboard bundle does not take its help from help/ alone:\n' + wrong.map((w) => `        ${w}`).join('\n'));
  } else {
    pass(`all ${pages.length} Markdown file(s) in ${PAGES}/ are in the help glob, and none of ${specifiers} relative import(s) in frontend/src leaves frontend/ but for help/`);
  }
}

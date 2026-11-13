import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fail, OPERATOR_PAIRS, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 111. A reference page whose operator steps moved into help/site/, or that a page there sums up,
// and that help page link to each other in their opening lines, before the first `## `: the design
// stayed where the code cites it, and a reader of either half has to find the other. A page that
// moved whole leaves a stub at its old path (`back: false`): the stub points on, and the help page
// owes it nothing.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const opening = (file) => read(file).split(/\n## /)[0];
  const linksTo = (file) => [...opening(file).matchAll(/\[[^\]]+\]\(([^)\s#]+)[^)\s]*\)/g)]
    .filter((m) => !/^[a-z][a-z0-9+.-]*:/i.test(m[1]))
    .map((m) => posix.normalize(posix.join(posix.dirname(file), m[1])));
  const wrong = [];
  for (const { design, help, back = true } of OPERATOR_PAIRS) {
    const missing = [design, help].filter((f) => !existsSync(join(REPO, f)));
    if (missing.length) { wrong.push(`${missing.join(' and ')} missing`); continue; }
    if (!linksTo(design).includes(help)) wrong.push(`${design} does not link to ${help}, where its operator steps are, before its first section`);
    if (back && !linksTo(help).includes(design)) wrong.push(`${help} does not link back to ${design}, where the design behind its steps is, before its first section`);
  }
  if (wrong.length) {
    fail('a reference page and the help page its steps moved to do not point at each other:\n' + wrong.map((w) => `        ${w}`).join('\n'));
  } else {
    pass(`all ${OPERATOR_PAIRS.length} reference page(s) split into help/site/ and their help pages link to each other at the top`);
  }
}

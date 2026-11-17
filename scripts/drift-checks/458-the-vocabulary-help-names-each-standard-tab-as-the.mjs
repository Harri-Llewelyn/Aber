import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 458. The Vocabulary help names the standard tabs as the page draws them: how many (the controls
// bullet and the heading under it say it in words), which, in the order of VOCABULARY_TABS, and a
// section of its own for each, since the tab's tooltip sends a reader there.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const problems458 = [];
  const { STANDARDS } = await import(pathToFileURL(join(REPO, 'frontend/src/utils/standards.js')).href);
  const tabs = read('frontend/src/navigation.jsx').match(/export const VOCABULARY_TABS = \[([^\]]+)\]/)?.[1]
    .split(',').map((t) => t.trim().replace(/^STANDARDS\./, '')) ?? [];
  const labels = tabs.map((key) => STANDARDS[key]);
  if (labels.length === 0 || labels.some((label) => !label)) {
    fail('458: found no VOCABULARY_TABS in navigation.jsx -- the file\'s shape changed, so this check is no longer checking anything');
    return;
  }

  const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const count = words[labels.length];
  const joined = `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
  const help = read('help/pages/vocabulary.md');

  if (!help.includes(`- **The ${count} standard tabs**, ${joined}, each show`)) {
    problems458.push(`help/pages/vocabulary.md does not say "The ${count} standard tabs", naming ${joined} in the page's order`);
  }
  if (!help.includes(`## The ${count} standards\n`)) problems458.push(`help/pages/vocabulary.md has no "## The ${count} standards" heading`);
  if (!help.includes(`is under **The ${count} standards** below.`)) problems458.push('the controls bullet does not send the reader to the heading by its name');
  for (const label of labels) {
    if (!help.includes(`\n### ${label}\n`)) problems458.push(`help/pages/vocabulary.md has no "### ${label}" section`);
  }
  const headings = [...help.matchAll(/\n### ([^\n]+)\n/g)].map((m) => m[1]);
  if (headings.join('|') !== labels.join('|')) {
    problems458.push(`the sections under the heading are ${headings.join(', ')}, and the tabs are ${labels.join(', ')}`);
  }

  if (problems458.length) {
    fail('the Vocabulary help and the page\'s tabs disagree:\n' + problems458.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the Vocabulary help names the ${count} standard tabs (${labels.join(', ')}) as the page draws them, each with a section`);
  }
}

import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 600. A group that opens and closes is headed by GroupHeading, with its count, on every page: only that
// component draws the button (`table-group-button`), and each list of rows that uses it passes a count and
// the count in words. A list whose groups start closed keeps them with useOpenGroups(). frontend/README.md
// states the rule under Counts; the Entities help says how many rows an open group draws at a time, as the
// page does, and the metrics help that a heading says how many it holds.
// -------------------------------------------------------------------------------------------------
const HEADING = 'frontend/src/components/common/GroupHeading.jsx';
const README = 'frontend/README.md';
// The lists whose groups start closed, and where the state of each is kept.
const LISTS = [
  ['frontend/src/components/tabs/EntitiesTab.jsx', ['frontend/src/components/tabs/EntitiesTab.jsx']],
  ['frontend/src/components/tabs/MetricsTab.jsx', ['frontend/src/components/tabs/MetricsTab.jsx']],
  ['frontend/src/components/common/VocabularySections.jsx', [
    'frontend/src/components/common/VocabularyPanel.jsx', 'frontend/src/components/common/SiteVocabularyPanel.jsx',
  ]],
];

export default function check() {
  const problems600 = [];
  const components = allFiles.filter((f) => /^frontend\/src\/components\/.+\.jsx$/.test(f));
  if (!read(HEADING).includes('table-group-button')) problems600.push(`${HEADING} no longer draws the button, so this check reads nothing`);
  for (const file of components) {
    if (file !== HEADING && read(file).includes('table-group-button')) problems600.push(`${file} draws a group's heading of its own: use GroupHeading`);
  }
  for (const [file, keepers] of LISTS) {
    const source = read(file);
    const at = source.search(/<GroupHeading\s/);
    if (at < 0) { problems600.push(`${file} no longer heads its groups with GroupHeading`); continue; }
    // The heading's own props, past any element one of them holds.
    const props = source.slice(at).split(/\n\s*\/>/)[0];
    for (const prop of ['count', 'countLabel', 'controls']) {
      if (!props.includes(` ${prop}={`)) problems600.push(`${file}'s group heading passes no ${prop}`);
    }
    for (const keeper of keepers) {
      if (!read(keeper).includes('useOpenGroups(')) problems600.push(`${keeper} keeps which groups are open without useOpenGroups()`);
    }
  }

  const readme = read(README).replace(/\s+/g, ' ');
  const rule = readme.slice(readme.indexOf('- **Counts.** None'), readme.indexOf('- **Queues are tabs.**'));
  if (!rule.includes('A group that opens and closes says how many rows it holds')) problems600.push(`${README} does not say under Counts that a group that opens and closes says how many rows it holds`);

  const page = read('frontend/src/components/tabs/EntitiesTab.jsx').match(/^export const GROUP_PAGE = (\d+)$/m)?.[1];
  const entities = read('help/pages/archives.md');
  if (!page) problems600.push('could not read GROUP_PAGE out of EntitiesTab.jsx');
  else if (!entities.includes(`draws ${page} rows at a time`)) problems600.push(`help/pages/archives.md does not say a group "draws ${page} rows at a time"`);
  if (!entities.includes('how many rows it holds')) problems600.push("help/pages/archives.md does not say a group's heading says how many rows it holds");
  if (!read('help/pages/metrics.md').includes('how many metrics it holds')) problems600.push("help/pages/metrics.md does not say a group's heading says how many metrics it holds");

  if (problems600.length) {
    fail(`a group that opens and closes is not headed by GroupHeading, or a document says otherwise:\n${problems600.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`every group that opens and closes is headed by GroupHeading, the ${LISTS.length} lists whose groups start closed say their counts and keep them alike, and the README and the help say so`);
  }
}

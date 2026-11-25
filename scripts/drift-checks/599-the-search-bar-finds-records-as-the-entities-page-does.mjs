import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 599. The search bar finds records by the reads the Entities page makes, find_entities() and
// useLocalEntities(), so a kind added to entity_directory is in both. The help and the README say what the bar
// does with them: how many of a kind it lists, from how many characters it asks, and the two rows an id adds,
// in the order they are drawn.
// -------------------------------------------------------------------------------------------------
const BAR = 'frontend/src/components/common/GlobalSearch.jsx';
const PAGE = 'frontend/src/components/tabs/EntitiesTab.jsx';
const HELP = 'help/pages/archives.md';
const README = 'frontend/README.md';
const NUMBERS = { 2: 'two', 3: 'three', 4: 'four' };

export default function check() {
  const problems599 = [];
  const bar = read(BAR);
  const page = read(PAGE);
  for (const [file, source] of [[BAR, bar], [PAGE, page]]) {
    if (!source.includes('api.findEntities(')) problems599.push(`${file} does not ask find_entities()`);
    if (!/\buseLocalEntities\(userRole\b/.test(source)) problems599.push(`${file} does not read people by useLocalEntities()`);
    if (/api\.(listPeople|listUserAccounts)\(/.test(source)) problems599.push(`${file} reads people itself, not by useLocalEntities()`);
  }
  if (!bar.includes('{ share: RECORD_KIND_LIMIT, kinds: DIRECTORY_KINDS }')) problems599.push(`${BAR} does not ask for each kind's share, so one kind can fill the answer`);
  for (const file of allFiles.filter((f) => /^frontend\/src\/(?!__tests__\/).+\.jsx?$/.test(f))) {
    const gone = read(file).match(/\b(resolveId|searchAssets)\b/)?.[1];
    if (gone) problems599.push(`${file} names ${gone}, which read five tables and is gone`);
  }

  const help = read(HELP);
  const paragraph = help.split('\n').find((line) => line.startsWith('**The search bar finds entities from any page.**')) ?? '';
  if (!paragraph) problems599.push(`${HELP} has no paragraph on the search bar`);
  const readme = read(README).split('\n\n').find((text) => text.startsWith("**Its records are `find_entities()`'s**"))?.replace(/\s+/g, ' ') ?? '';
  if (!readme) problems599.push(`${README} has no paragraph on the search bar's records`);

  const number = (name) => bar.match(new RegExp(`const ${name} = (\\d+)\\n`))?.[1];
  const [limit, least, settle] = ['RECORD_KIND_LIMIT', 'RECORD_SEARCH_MIN', 'SETTLE_MS'].map(number);
  for (const [value, name] of [[limit, 'RECORD_KIND_LIMIT'], [least, 'RECORD_SEARCH_MIN'], [settle, 'SETTLE_MS']]) {
    if (!value) problems599.push(`could not read ${name} out of ${BAR}`);
  }
  for (const [where, text, phrases] of [
    [HELP, paragraph, [`${limit} of a kind at most`, `${NUMBERS[least]} or more characters of a name`]],
    [README, readme, [`keeps ${limit} of a kind`, `from ${NUMBERS[least]} characters`, `rested ${settle} ms`]],
  ]) for (const phrase of phrases) if (text && !text.includes(phrase)) problems599.push(`${where} does not say "${phrase}" of the search bar`);

  const idRows = [...bar.matchAll(/kind: 'id',\n\s+label: '([^']+)'/g)].map((m) => m[1]);
  if (idRows.length !== 2) problems599.push(`read ${idRows.length} rows that an id adds out of ${BAR}, not two`);
  for (const [where, text, mark] of [[HELP, paragraph, '**'], [README, readme, '*']]) {
    const at = idRows.map((label) => text.indexOf(`${mark}${label}${mark}`));
    if (at.some((i) => i < 0) || at.join() !== [...at].sort((a, b) => a - b).join()) problems599.push(`${where} does not name ${idRows.join(', then ')}`);
  }

  if (problems599.length) {
    fail(`the search bar and the Entities page find records differently, or the docs say so:\n${problems599.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the search bar finds records by the Entities page's reads, and the help and the README say its ${limit} of a kind, its ${least} characters and the ${idRows.length} rows an id adds`);
  }
}

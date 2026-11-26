import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 606. The Gateways page leaves the Playback gateway off its list by the database's flag, after the
// filters have counted, so no count changes. Its check is in the Filters panel, under Lifecycle and Type.
// The help and the README name the check and Release waiting as the page draws them, and the README's
// address table lists every key the page reads.
// -------------------------------------------------------------------------------------------------
const TAB = 'frontend/src/components/tabs/GatewaysTab.jsx';
const WORDS = 'frontend/src/utils/playbackGateway.js';
const HELP = 'help/pages/gateways.md';
const README = 'frontend/README.md';

export default function check() {
  const problems606 = [];
  const tab = read(TAB).replace(/\r\n/g, '\n');
  const constant = (name) => read(WORDS).split(`export const ${name} = '`)[1]?.split("'")[0];
  const label = constant('PLAYBACK_GATEWAY_LABEL');
  const param = constant('PLAYBACK_GATEWAY_PARAM');
  const release = /<IconGitBranch size=\{13\} \/> ([A-Z][a-z ]+) \(\{releasesWaiting\}\)/.exec(tab)?.[1];
  for (const [name, value] of [['the Playback check\'s label', label], ['its query key', param], ['the waiting release\'s label', release]]) {
    if (!value) problems606.push(`could not read ${name} out of ${WORDS} or ${TAB}`);
  }

  const start = tab.indexOf('applyFacets(gateways, [');
  const facets = start < 0 ? '' : tab.slice(start, tab.indexOf('\n  })\n', start));
  if (!facets) problems606.push(`${TAB} no longer filters its rows with applyFacets`);
  if (facets.includes('isShadowGateway')) problems606.push(`${TAB} takes the Playback gateway out before the filters count, so the counts leave it out`);
  if (!tab.includes('facetRows.filter(g => !isShadowGateway(g) || showPlayback || playbackReason(g))')) {
    problems606.push(`${TAB} no longer leaves the Playback gateway off by isShadowGateway(), after the filters have counted`);
  }

  const from = tab.indexOf('<FiltersPopover ');
  const panel = from < 0 ? '' : tab.slice(from, tab.indexOf('</FiltersPopover>', from));
  const drawn = [...panel.matchAll(/<Filter(?:List|Check)\n\s+label=(?:"([^"]+)"|\{(\w+)\})/g)].map((m) => m[1] ?? m[2]);
  if (drawn.join() !== 'Lifecycle,Type,PLAYBACK_GATEWAY_LABEL') {
    problems606.push(`${TAB}'s Filters panel holds ${drawn.join(', ') || 'nothing this check can read'}, not Lifecycle and Type over the Playback check`);
  }

  for (const name of [label, release]) {
    for (const file of [HELP, README]) if (name && !read(file).includes(`**${name}**`)) problems606.push(`${file} does not name **${name}**, as the Gateways page does`);
  }
  if (!read(HELP).includes('**1 showing**')) problems606.push(`${HELP} does not say what the check says while the Playback gateway shows by itself`);
  if (!read(HELP).includes(`**${label}**, under **Filters**, lists it.`)) problems606.push(`${HELP} does not say that the check is under Filters`);

  const keys = [...tab.matchAll(/useUrl(?:State|List)\(('[a-z]+'|PLAYBACK_GATEWAY_PARAM)/g)]
    .map((m) => (m[1].startsWith('\'') ? m[1].slice(1, -1) : param));
  const row = read(README).split('\n').find((line) => line.startsWith('| Gateways | |')) ?? '';
  if (!row) problems606.push(`${README}'s address table has no row for the Gateways page`);
  for (const key of keys) if (row && !row.includes(`\`${key}\``)) problems606.push(`${README}'s address table does not list \`${key}\` for the Gateways page`);

  if (problems606.length) {
    fail('The Gateways page and what says how it lists differ:\n' + problems606.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the Gateways page leaves the Playback gateway off by its flag after the filters count, and the help and the README name ${label} and ${release}, and its ${keys.length} query keys`);
  }
}

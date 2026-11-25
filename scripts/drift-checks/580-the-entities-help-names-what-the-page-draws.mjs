import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 580. The Entities help names the page as it is drawn: its tabs, as navigation.jsx lists them, with a
// section for each; the search's placeholder; the Active table's columns; the marks a row can carry that it
// explains; and the drawer's actions. The help's file keeps the path it had (help/pages/archives.md), which
// navigation.jsx's `help` says, and the sidebar, the card and the help call the page the same thing.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HELP = 'help/pages/archives.md';
  const TAB = 'frontend/src/components/tabs/EntitiesTab.jsx';
  const help = read(HELP);
  const tab = read(TAB);
  const nav = read('frontend/src/navigation.jsx');
  const problems580 = [];

  const entry = nav.match(/\{ id: 'entities',\s+label: '([^']+)',[^\n]*\bhelp: '([a-z-]+)' \}/);
  if (!entry) problems580.push("navigation.jsx has no Entities page whose help it names");
  else {
    if (`help/pages/${entry[2]}.md` !== HELP) problems580.push(`navigation.jsx names ${entry[2]} as the Entities page's help, not ${HELP}`);
    if (!tab.includes(`title="${entry[1]}"`)) problems580.push(`${TAB}'s card is not titled ${entry[1]}, as the sidebar names the page`);
    if (!help.includes(`Open **${entry[1]}** in the sidebar`)) problems580.push(`${HELP} does not say to open ${entry[1]} in the sidebar`);
    if (!read('help/README.md').includes(`[${entry[1]}](pages/${entry[2]}.md)`)) problems580.push(`help/README.md does not list ${entry[1]} by that name`);
  }

  const block = nav.match(/export const ENTITIES_TABS = \[([\s\S]*?)\n\]/)?.[1] ?? '';
  const tabs = [...block.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  if (tabs.length !== 3) problems580.push(`read ${tabs.length} tabs out of ENTITIES_TABS, not three`);
  for (const label of tabs) {
    if (!help.includes(`\n## ${label} entities\n`)) problems580.push(`${HELP} has no section for the ${label} tab ("## ${label} entities")`);
    if (!help.includes(`The **${label}** tab lists`)) problems580.push(`${HELP} does not say what the ${label} tab lists`);
  }

  const placeholder = tab.match(/placeholder="([^"]+)"/)?.[1];
  if (!placeholder) problems580.push(`could not read the search's placeholder out of ${TAB}`);
  else if (!help.includes(`**${placeholder}**`)) problems580.push(`${HELP} does not name the search as the page does: ${placeholder}`);

  const columns = [...tab.matchAll(/sort=\{activeSort\}[^>]*>([^<]+)<\/SortHeader>/g)].map((m) => m[1]);
  if (columns.length !== 4) problems580.push(`read ${columns.length} columns of the Active table, not four`);
  for (const name of columns) if (!help.includes(`- **${name}** `)) problems580.push(`${HELP} has no bullet for the Active table's ${name} column`);

  const badges = [...read('frontend/src/utils/entities.js').matchAll(/return \{ label: '([^']+)'/g)].map((m) => m[1]);
  for (const mark of [...help.matchAll(/marked \*\*([^*]+)\*\*/g)].map((m) => m[1]).filter((m) => m !== 'Never auto-purged')) {
    if (!badges.includes(mark)) problems580.push(`${HELP} says a row is marked ${mark}, and variantBadge() has no such mark`);
  }

  const drawer = read('frontend/src/components/tabs/EntityDrawer.jsx');
  for (const action of ['View in Audit Trail', 'View in Automations']) {
    if (!drawer.includes(`'${action}'`)) problems580.push(`the drawer no longer offers ${action}`);
    if (!help.includes(`- **${action}**`)) problems580.push(`${HELP} has no bullet for ${action}`);
  }

  if (problems580.length) {
    fail(`the Entities help and the page disagree:\n${problems580.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the Entities help names the page's ${tabs.length} tabs, its search, its ${columns.length} columns and its drawer's actions as it draws them`);
  }
}

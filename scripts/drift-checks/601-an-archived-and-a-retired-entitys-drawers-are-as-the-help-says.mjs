import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 601. An archived and a retired entity's acts and links are in EntityDrawer, not in their rows, and the
// Entities help names them in the drawer's order: Restore first and Permanent Delete last, then, for a retired
// one, what survives it. A row of the Entities page holds no button but the ones that copy an id.
// -------------------------------------------------------------------------------------------------
const HELP = 'help/pages/archives.md';
const TAB = 'frontend/src/components/tabs/EntitiesTab.jsx';
const DRAWER = 'frontend/src/components/tabs/EntityDrawer.jsx';

export default function check() {
  const problems601 = [];
  const help = read(HELP);
  const tab = read(TAB);
  const drawer = read(DRAWER);
  const part = (title) => {
    const from = help.indexOf(`\n## ${title} entities\n`);
    return from < 0 ? '' : help.slice(from, help.indexOf('\n## ', from + 4));
  };
  /** Every text of `wanted` is in `text`, in that order. */
  const inOrder = (text, wanted, where) => {
    let at = -1;
    for (const one of wanted) {
      const next = text.indexOf(one, at + 1);
      if (next < 0) { problems601.push(`${where} does not have "${one}"${at < 0 ? '' : ' after what comes before it'}`); return; }
      at = next;
    }
  };

  const acts = drawer.slice(drawer.indexOf('actions={'));
  inOrder(acts, ["label: 'Restore'", 'label: `View in ${entityPage.page}`', "label: 'View in Audit Trail'", "label: 'Export Bundle…'", "label: 'Permanent Delete'"], DRAWER);
  inOrder(part('Archived'), ['- **Restore** ', '- **View in** ', '- **Export Bundle…** ', '- **Permanent Delete** ', '- **Auto-purge** ', '- **Held** '], `${HELP}, Archived`);
  inOrder(drawer, ['>What Survives<', '/> View in Audit Trail', '/> Forge Repository ', '/> Bundle {'], DRAWER);
  inOrder(part('Retired'), ['**What Survives**', '- **View in Audit Trail** ', '- **Forge Repository** ', '- **Bundle** ', '**Historian ID**'], `${HELP}, Retired`);
  for (const title of ['Active', 'Archived', 'Retired']) {
    if (!part(title).includes('Select a row to open its panel.')) problems601.push(`${HELP} does not say that a row of ${title} opens its panel`);
  }

  const rows = [...tab.matchAll(/^const (\w+Row) = memo\(function[\s\S]*?\n\}\)\n/gm)];
  if (rows.length !== 3) problems601.push(`read ${rows.length} rows out of ${TAB}, not three`);
  for (const [source, name] of rows) {
    if (!source.includes('opensDrawer(')) problems601.push(`${name} in ${TAB} does not open the drawer`);
    if (/<button|<ActionButton|row-actions/.test(source)) problems601.push(`${name} in ${TAB} has a button: an entity's acts are in its drawer`);
  }

  if (problems601.length) {
    fail(`the drawers of the Entities page and its help disagree:\n${problems601.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`each of the ${rows.length} rows of the Entities page opens the drawer and has no act of its own, and the help names an archived and a retired entity's in the drawer's order`);
  }
}

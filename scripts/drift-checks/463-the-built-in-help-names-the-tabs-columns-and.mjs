import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 463. The Built-in help names the tab's columns, its three states and the drawer's actions as the
// page words them. The help is written to be followed: "select **View Help**" on a drawer whose action
// says Read More sends a reader looking for a control that is not there. And the tab never says a rule
// is OK, in the help or in the code: Aber cannot see that Grafana evaluated it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HELP = 'help/pages/built-in-alerts.md';
  const help = read(HELP);
  const TAB = 'frontend/src/components/tabs/BuiltInAlerts.jsx';
  const BADGE = 'frontend/src/components/common/BuiltInStateBadge.jsx';
  const DRAWER = 'frontend/src/components/tabs/BuiltInAlertDrawer.jsx';
  const NAV = 'frontend/src/navigation.jsx';
  const tab = read(TAB);
  const problems463 = [];

  const columns = ['Alert', 'Group', 'Severity', 'Subject', 'Hold', 'Fires when', 'Evaluated by', 'State'];
  for (const column of columns) {
    if (!help.includes(`- **${column}**`)) problems463.push(`${HELP} does not name the column **${column}**`);
    if (!new RegExp(`>${column}</(SortHeader|ColumnHeader)>`).test(tab)) problems463.push(`${TAB} no longer has a column headed ${column}, which ${HELP} names`);
  }
  for (const label of ['Firing', 'Could not be evaluated', 'Not firing']) {
    if (!help.includes(`**${label}**`)) problems463.push(`${HELP} does not name the state **${label}**`);
    // "N firing" is the badge's text, so Firing is checked as the word.
    if (!read(BADGE).toLowerCase().includes(label.toLowerCase())) problems463.push(`${BADGE} no longer says ${label}, which ${HELP} names`);
  }
  for (const action of ['View Help', 'View in Grafana']) {
    if (!help.includes(`**${action}**`)) problems463.push(`${HELP} does not name the drawer's **${action}**`);
    if (!read(DRAWER).includes(`label: '${action}'`)) problems463.push(`${DRAWER} no longer has an action ${action}, which ${HELP} names`);
  }
  if (!help.includes('**View rule**') || !read('frontend/src/components/common/ContextPanel.jsx').includes('View rule')) {
    problems463.push(`${HELP} and ContextPanel.jsx do not both name the alert banner's link View rule`);
  }
  for (const label of ['Built-in', 'Automations']) {
    if (!help.includes(`**${label}**`)) problems463.push(`${HELP} does not name the tab **${label}**`);
    if (!new RegExp(`label: '${label}'`).test(read(NAV))) problems463.push(`${NAV} no longer has a tab ${label}, which ${HELP} names`);
  }
  for (const file of [TAB, BADGE, DRAWER]) {
    // Comments are blanked first: one says what the tab never says.
    const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    if (/>\s*OK\s*</.test(source) || /['"`]OK['"`]/.test(source)) problems463.push(`${file} says OK: a rule that is not firing is "Not firing", because Aber cannot see that Grafana evaluated it`);
  }

  if (problems463.length) {
    fail(`the Built-in help does not name the tab's words as the code does:\n${problems463.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the Built-in help names the tab's ${columns.length} columns, its 3 states, the drawer's 2 actions and the banner's link as the page words them, and nothing says OK`);
  }
}

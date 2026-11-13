import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 323. The Automations help names each control as the page labels it, and each column of the list.
// The help is written to be followed: "select **Save**" in a page whose button says Save Changes
// sends a reader looking for a control that is not there.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HELP = 'help/pages/automations.md';
  const help = read(HELP);
  const PAGE = 'frontend/src/components/tabs/AutomationsTab.jsx';
  const DETAIL = 'frontend/src/components/tabs/AutomationDetail.jsx';
  const DEVICES = 'frontend/src/components/tabs/DevicesTab.jsx';
  const problems323 = [];
  const labels = [
    ['New Automation', PAGE], ['Upload', PAGE], ['Export', PAGE],
    ['Automation', PAGE], ['Watches', PAGE], ['Enabled', PAGE], ['Firing now', PAGE], ['Last fired', PAGE], ['Applies because', PAGE],
    ['Save', DETAIL], ['Delete', DETAIL], ['Disable', DETAIL], ['Enable', DETAIL], ['Recent firings', DETAIL], ['View Audit Trail', DETAIL],
    ['View in Automations', DEVICES],
  ];
  for (const [label, file] of labels) {
    if (!help.includes(`**${label}**`)) problems323.push(`${HELP} does not name **${label}**`);
    if (!read(file).includes(label)) problems323.push(`${file} no longer has a control or column called ${label}, which ${HELP} names`);
  }
  for (const status of ['New', 'Changed', 'Unchanged', 'Refused']) {
    if (!help.includes(`**${status}**`)) problems323.push(`${HELP} does not name the preview's **${status}**`);
  }
  for (const word of ['Named', 'Site-wide']) {
    if (!help.includes(`**${word}**`) || !read('frontend/src/utils/automations.js').includes(`label: '${word}'`)) {
      problems323.push(`${HELP} and utils/automations.js do not both say **${word}** for why an automation applies`);
    }
  }
  if (problems323.length) {
    fail(`the Automations help does not name the page's controls as the code does:\n${problems323.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the Automations help names ${labels.length} controls and columns, the 4 preview statuses and the 2 reasons, as the page labels them`);
  }
}

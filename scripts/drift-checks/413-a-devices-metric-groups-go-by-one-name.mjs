import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 413. A device's metric groups go by one name on the Devices page, Metric groups: the roster's
// column, the toolbar filter, the drawer's row and the edit form's line. The help and the dashboard
// README use the same name, and neither the page nor the help calls them Type, Classification or
// Device Type, since "type" is kept free for an AAS assetType. The filter's address key is `group`,
// and an old `?type=` link is rewritten by utils/devicesAddress.js. The two findings (Unmodelled,
// Out of vocabulary) are not groups: the page draws them as badges and offers them in Status.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const PAGE = 'frontend/src/components/tabs/DevicesTab.jsx';
  const HELP = 'help/pages/devices.md';
  const README = 'frontend/README.md';
  const page = read(PAGE);
  const help = read(HELP);
  const readme = read(README);
  const problems413 = [];
  const wording = [
    ['the Metric groups filter', 'label="Metric groups"'],
    ['the roster column', '>Metric groups</SortHeader>'],
    ['the drawer row', "label: 'Metric groups'"],
    ["the edit form's static field", '<StaticField label="Metric Groups"'],
  ];
  for (const [what, text] of wording) {
    if (!page.includes(text)) problems413.push(`${PAGE} does not name ${what} as Metric groups (${text})`);
  }
  for (const old of ['Classification', 'Device Type', 'label="Type"', '>Type</SortHeader>']) {
    if (page.includes(old)) problems413.push(`${PAGE} still has "${old}", an old name for the metric groups`);
  }
  if (!page.includes("useUrlList('group')")) problems413.push(`${PAGE} does not hold the Metric groups filter in ?group=`);
  if (page.includes("useUrlList('type')")) problems413.push(`${PAGE} still holds a filter in ?type=`);
  if (!page.includes('oldDevicesLinkChanges')) problems413.push(`${PAGE} does not rewrite an old ?type= link`);
  if (!read('frontend/src/utils/devicesAddress.js').includes('export function oldDevicesLinkChanges')) {
    problems413.push('frontend/src/utils/devicesAddress.js has no oldDevicesLinkChanges()');
  }
  if (!help.includes('**Metric groups**')) problems413.push(`${HELP} does not name **Metric groups**`);
  for (const old of ['Classification', 'Device Type']) {
    if (help.includes(old)) problems413.push(`${HELP} still says "${old}"`);
  }
  if (/\btype\b, schema/.test(help)) problems413.push(`${HELP} still lists the filter as "type"`);
  for (const finding of ['**Publishing unmodelled metrics**', '**Out of vocabulary**']) {
    if (!help.includes(finding)) problems413.push(`${HELP} does not name the Status filter's ${finding}`);
  }
  if (!readme.includes('### What sits where in a drawer') || !readme.includes('**A finding is a badge in the subtitle, not a row.**')) {
    problems413.push(`${README} does not state, in "What sits where in a drawer", that a finding is a badge in the subtitle`);
  }
  if (problems413.length) {
    fail(`a device's metric groups do not go by one name:\n${problems413.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass("a device's metric groups are Metric groups on the roster, the filter, the drawer and the edit form, in the help and the README, and an old ?type= link is rewritten");
  }
}

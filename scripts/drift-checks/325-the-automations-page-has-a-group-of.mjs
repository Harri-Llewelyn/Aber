import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 325. The Automations page has a group of its own in the sidebar, right after the Modelling group,
// which ends with Vocabulary, and the help's contents list it there. Pages in help/README.md are "in
// the order the sidebar lists them"; a page filed elsewhere in one of them is a contents list that
// disagrees with the rail.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const nav = read('frontend/src/navigation.jsx');
  const readme = read('help/README.md');
  const problems325 = [];
  const filed = [...nav.matchAll(/id: '([a-z-]+)',\s+label: '[^']+',\s+group: '([a-z-]+)'/g)].map((m) => ({ id: m[1], group: m[2] }));
  const inGroup = (group) => filed.filter((t) => t.group === group).map((t) => t.id);
  const model = inGroup('model');
  const automation = inGroup('automation');
  if (model.join(',') !== 'schemas,metrics,vocabulary') {
    problems325.push(`the sidebar's Modelling group is ${model.join(', ')}, not schemas, metrics, vocabulary`);
  }
  if (automation.join(',') !== 'automations') {
    problems325.push(`the sidebar's Automation group is ${automation.join(', ') || 'empty'}, not the Automations page alone`);
  }
  const groupsAt = nav.indexOf('export const NAV_GROUPS');
  const groups = [...nav.slice(groupsAt, nav.indexOf('\n]', groupsAt)).matchAll(/\{ id: '([a-z-]+)' \}/g)].map((m) => m[1]);
  if (groups.indexOf('automation') < 0 || groups.indexOf('automation') !== groups.indexOf('model') + 1) {
    problems325.push(`NAV_GROUPS is ${groups.join(', ')}: the automation group is not right after model`);
  }
  const rail = [...model, ...automation];
  const listed = [...readme.matchAll(/\]\(pages\/([a-z-]+)\.md\)/g)].map((m) => m[1]).filter((id) => rail.includes(id));
  if (listed.join(',') !== rail.join(',')) {
    problems325.push(`help/README.md lists these pages as ${listed.join(', ')}, and the sidebar as ${rail.join(', ')}`);
  }
  if (!/export const VALID_TABS = \[[^\]]*'automations'/.test(read('frontend/src/constants.js'))) {
    problems325.push("constants.js's VALID_TABS does not hold automations, so the router would send its address to the Site Map");
  }
  if (problems325.length) {
    fail(`the Automations page's place is not the same in the sidebar and the help's contents:\n${problems325.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the sidebar's Modelling group (${model.join(', ')}) is followed by Automations in a group of its own, and help/README.md lists them in that order, and the router accepts it`);
  }
}

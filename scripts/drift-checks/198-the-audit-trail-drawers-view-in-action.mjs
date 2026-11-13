import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 198. The Audit Trail drawer's "View in" action is offered for the kinds the help page names. The
// tab's ENTITY_PAGES decides which kinds have a page and what it is called, and each must be a kind
// routes.js's entityUrl() opens; the help lists the button's wordings. A page added on one side
// only is a button the help does not mention, or one it promises that never appears.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const TAB = 'frontend/src/components/tabs/AuditTrailTab.jsx';
  const block = read(TAB).match(/^const ENTITY_PAGES = \{\n([\s\S]*?)\n\}/m)?.[1] ?? '';
  const pages = [...block.matchAll(/type: '(\w+)',\s*page: '([^']+)'/g)].map((m) => ({ type: m[1], page: m[2] }));
  const routed = (read('frontend/src/routes.js').match(/export const entityUrl = [\s\S]*?\{ ([^}]*) \}\[type\]/)?.[1] ?? '')
    .split(',').map((p) => p.split(':')[0].trim()).filter(Boolean);
  const help = read('help/pages/audit-trail.md');
  const said = [...(help.match(/^- \*\*View in Devices\*\*.*$/m)?.[0] ?? '').matchAll(/\*\*View in (\w+)\*\*/g)].map((m) => m[1]);
  const problems198 = [];
  if (!pages.length) problems198.push(`could not read ENTITY_PAGES out of ${TAB}`);
  if (!routed.length) problems198.push('could not read the kinds entityUrl() opens out of routes.js');
  for (const { type } of pages.filter((p) => !routed.includes(p.type))) {
    problems198.push(`ENTITY_PAGES offers ${type}, which entityUrl() does not open`);
  }
  if (!said.length) problems198.push('help/pages/audit-trail.md has no "View in Devices" bullet');
  for (const { page } of pages.filter((p) => !said.includes(p.page))) {
    problems198.push(`help/pages/audit-trail.md does not name "View in ${page}"`);
  }
  for (const page of said.filter((s) => !pages.some((p) => p.page === s))) {
    problems198.push(`help/pages/audit-trail.md names "View in ${page}", which the drawer never offers`);
  }
  if (problems198.length) {
    fail('the Audit Trail drawer\'s View in action is described otherwise than the code offers it:\n' +
      problems198.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the help names the Audit Trail drawer's ${pages.length} View in pages, each one entityUrl() opens`);
  }
}

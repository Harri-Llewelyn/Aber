import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 623. A link to an Audit Trail event opens its drawer whatever the page has loaded, as the help says.
// Under All time the page holds the newest 200 events, and a toast read later or a bookmark can name an
// older one. The page reads such an event on its own, through the page's own read so the drawer has
// what a loaded row has; a filter in the address that leaves it out is cleared on arrival; and an event
// nobody may read opens the drawer to say so. The Backups page does the same for a run (check 618).
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems623 = [];
  const flat = (text) => text.replace(/\s+/g, ' ');
  const page = flat(read('frontend/src/components/tabs/AuditTrailTab.jsx'));
  const api = flat(read('frontend/src/api.js'));
  const help = flat(read('help/pages/audit-trail.md'));

  const at = api.indexOf('auditTrailEvent: async (id) =>');
  if (at < 0) problems623.push('api.js has no auditTrailEvent(id)');
  else {
    const end = api.indexOf('return event ?', at);
    const body = end < 0 ? '' : api.slice(at, end);
    if (!body.includes(".from('audit_trail')")) problems623.push("api.js's auditTrailEvent() does not find the row in audit_trail, under its policies");
    if (!body.includes('api.get(lane)') || !body.includes('include_purged=true')) {
      problems623.push("api.js's auditTrailEvent() does not read the event's entity through the page's own read, deleted entities included");
    }
  }
  if (!page.includes('api.auditTrailEvent(id)')) problems623.push('AuditTrailTab.jsx does not read an event the address names on its own');
  if (!page.includes('useArrivalSelection(selectedEventId,')) {
    problems623.push('AuditTrailTab.jsx does not clear a filter that leaves out the event it arrives on');
  }
  const absent = 'No audit event has this id, or you may not read it.';
  if (!page.includes(absent)) problems623.push(`AuditTrailTab.jsx's drawer does not say "${absent}"`);

  const said = [
    '**A link to one event** opens its drawer, even when the event is older than the events loaded.',
    'A filter in the link that leaves the event out is cleared.',
    'A link to an event that does not exist, or that you may not read, opens the drawer to say so.',
  ];
  for (const s of said) if (!help.includes(s)) problems623.push(`help/pages/audit-trail.md does not say "${s}"`);

  if (problems623.length) {
    fail(`A link to an Audit Trail event is not opened as the help says:\n${problems623.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('a link to an Audit Trail event opens it alone, through the page\'s read, clearing a filter that hides it, and the help says so');
  }
}

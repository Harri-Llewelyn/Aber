import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 625. A registered device held again in Quarantine is archived from its row, as the help says, and
// then deleted from Entities, since the database refuses its delete until it is archived (617). The
// row offers Archive Device only where it offers no Reject, through the dialog the details panel uses;
// its sentence says to archive it; an archived device leaves the queue, whose births it no longer holds.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems625 = [];
  const flat = (text) => text.replace(/\s+/g, ' ');
  const page = flat(read('frontend/src/components/tabs/DevicesTab.jsx'));
  const hold = flat(read('frontend/src/utils/quarantineHold.js')).split("' + '").join('');
  const api = flat(read('frontend/src/api.js'));
  const help = flat(read('help/pages/devices.md'));

  // The row: Archive Device for a held registered device, in the dialog the drawer's archive opens.
  const archive = page.indexOf('onClick={() => setArchiveTarget(q)}');
  if (archive < 0 || !page.slice(Math.max(0, archive - 400), archive).includes('{isHeldAgain(q) && (')) {
    problems625.push("DevicesTab.jsx's Quarantine row offers no Archive Device for a device isHeldAgain(q) names");
  }
  if (!page.includes('permitted={canArchive}') || !page.includes('{archiveTarget && <ArchiveModal type="device"')) {
    problems625.push("the Quarantine row's Archive Device is not gated on canArchive, or does not open ArchiveModal");
  }
  if (!hold.includes('archive it, then delete it from Entities')) {
    problems625.push("quarantineHold.js's HELD_AGAIN_ROW does not say to archive it, then delete it from Entities");
  }

  // The queue: an archived device is not read into it, and the page lists it with the archived.
  if (!api.includes("const held = (data || []).filter(d => !d.is_archived);")) {
    problems625.push("api.js's /api/v1/quarantine reads an archived device into the queue");
  }
  if (!hold.includes('export const isInQueue = (device) => Boolean(device?.is_quarantined) && !device?.is_archived')) {
    problems625.push('quarantineHold.js has no isInQueue() that leaves an archived device out');
  }
  if (page.includes('if (a.is_quarantined) return false') || !page.includes('if (isInQueue(a)) return false')) {
    problems625.push("DevicesTab.jsx's Registered list leaves out an archived device held again");
  }

  for (const said of ['**To be rid of a registered device that is held again**', 'use **Archive Device** on its row',
    'Then delete it with **Permanent Delete** on the Entities page']) {
    if (!help.includes(said)) problems625.push(`help/pages/devices.md does not say "${said}"`);
  }

  if (problems625.length) {
    fail(`A registered device held again is not archived as the help says:\n${problems625.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('a registered device held again is archived from its Quarantine row, leaves the queue, and is deleted from Entities, as the help says');
  }
}

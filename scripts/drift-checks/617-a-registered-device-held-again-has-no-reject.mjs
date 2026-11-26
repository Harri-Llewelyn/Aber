import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 617. A registered device held again in Quarantine has no Reject, as the help says, and the database
// refuses its delete. A Reject would take its schemas, nameplate and links, and the hold can come from
// another gateway's message. The Quarantine row offers Reject only for a device nobody registered; the
// row and the approval dialog say why; the trigger refuses a delete of a held registered device that is
// not archived, from any caller but the owner, in a sentence that names the same things as the page.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems617 = [];
  const flat = (text) => text.replace(/\s+/g, ' ');
  const page = flat(read('frontend/src/components/tabs/DevicesTab.jsx'));
  const hold = flat(read('frontend/src/utils/quarantineHold.js'));
  const dialog = flat(read('frontend/src/components/modals/ApproveQuarantineModal.jsx'));
  const help = flat(read('help/pages/devices.md'));
  const kept = 'keeps its schemas, nameplate and links';

  // The page: no Reject for such a device, and a sentence in its row and in the dialog.
  const reject = page.indexOf('onClick={() => setRejectTarget(q)}');
  if (reject < 0 || !page.slice(Math.max(0, reject - 400), reject).includes('{!isHeldAgain(q) && (')) {
    problems617.push("DevicesTab.jsx's Quarantine row offers Reject without asking isHeldAgain(q)");
  }
  if (!page.includes('<span>{HELD_AGAIN_ROW}</span>')) problems617.push('the Quarantine row does not say why it has no Reject');
  if (!dialog.includes('isHeldAgain(item) && <p className="form-hint">{HELD_AGAIN_APPROVAL}</p>')) {
    problems617.push('Approve & Onboard does not say why a registered device held again has no Reject');
  }
  // Each sentence as one string, its concatenated parts joined.
  const joined = hold.split("' + '").join('');
  for (const name of ['HELD_AGAIN_ROW', 'HELD_AGAIN_APPROVAL']) {
    const from = joined.indexOf(`export const ${name} = '`);
    const start = from + `export const ${name} = '`.length;
    const said = from < 0 ? '' : joined.slice(start, joined.indexOf("'", start));
    if (!said.includes(kept) || !said.includes('no Reject')) problems617.push(`quarantineHold.js's ${name} does not say it ${kept} and has no Reject`);
  }

  // The database: the last file that declares the trigger's function refuses as the page says.
  const declared = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_.*\.sql$/.test(f)).sort()
    .filter((f) => read(f).includes('FUNCTION public.refuse_deleting_a_registered_held_device()')).at(-1);
  if (!declared) problems617.push('no migration declares refuse_deleting_a_registered_held_device()');
  else {
    const sql = flat(read(declared));
    for (const reads of ['OLD.is_quarantined IS TRUE', 'OLD.requarantined_at IS NOT NULL', 'OLD.is_archived IS NOT TRUE']) {
      if (!sql.includes(reads)) problems617.push(`${declared} does not refuse on ${reads}`);
    }
    if (!sql.includes('BEFORE DELETE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.refuse_deleting_a_registered_held_device()')) {
      problems617.push(`${declared} does not run the refusal before a device's delete`);
    }
    if (!sql.includes('Approve it on the Quarantine tab') || !sql.includes('with its schemas, nameplate and links')) {
      problems617.push(`${declared}'s refusal does not say to approve it, and that approving keeps its schemas, nameplate and links`);
    }
  }

  for (const said of ['**A registered device that is held again has no Reject.**', 'unless it is archived first']) {
    if (!help.includes(said)) problems617.push(`help/pages/devices.md does not say "${said}"`);
  }

  if (problems617.length) {
    fail(`A registered device held again is not kept as the help says:\n${problems617.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('a registered device held again has no Reject on its row, the row and the dialog say why, the database refuses its delete until it is archived, and the help says so');
  }
}

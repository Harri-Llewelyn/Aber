import { allFiles, fail, pass, read } from './lib.mjs';
import { dialogsIn, propAt, propText } from '../lib/jsx-dialogs.mjs';

// -------------------------------------------------------------------------------------------------
// 573. Accept Match asks before it merges, and says what carries over as the database does it. The
// merge is approve_quarantined_device()'s merge path, read from its latest definition: the columns it
// writes on the device it keeps, the recorded birth values it re-keys onto that device, and the
// quarantined row it deletes. A column it writes is named in the question, or is one a person is not
// told of (UNSAID, with why); a column the question says is not carried over is one it does not write.
// A change to either side fails here, so the question never promises what the merge does not do.
// -------------------------------------------------------------------------------------------------

const MODAL = 'frontend/src/components/modals/ApproveQuarantineModal.jsx';
const HELP = 'help/pages/devices.md';

/** What the merge writes on the device it keeps, in the question's words. */
const CARRIED = {
  reported_identity: 'the ID it publishes under',
  status: 'its status',
  first_dbirth_at: 'the time of its first birth',
};

/** What it writes and the question leaves out, with why. */
const UNSAID = {
  identity_source: 'how the published ID was recognised, which goes with the ID',
  quarantine_reason: 'cleared, because the kept device is not held',
  is_quarantined: 'false, because the kept device is not held',
};

/** Columns the question says are the kept device's own. */
const KEPT = ['name', 'gateway_id', 'cell_id', 'area_id', 'location_scope'];

export default function check() {
  const problems573 = [];
  const lf = (path) => read(path).replace(/\r\n/g, '\n');

  const file = allFiles
    .filter((f) => /^supabase\/migrations\/[0-9]{4}_.*\.sql$/.test(f))
    .sort()
    .filter((f) => read(f).includes('CREATE OR REPLACE FUNCTION public.approve_quarantined_device('))
    .at(-1);
  const sql = file ? lf(file) : '';
  const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.approve_quarantined_device('));
  const merge = body.match(/IF p_merge_into_device_id IS NOT NULL THEN([\s\S]*?)RETURN jsonb_build_object\(\s*'merged', true,/)?.[1] ?? '';
  const update = merge.match(/UPDATE public\.devices\s+SET ([\s\S]*?)\s+WHERE id = v_candidate\.id/)?.[1] ?? '';
  const written = [...update.matchAll(/^\s*([a-z_]+)\s*=/gm)].map((m) => m[1]);
  if (!written.length) problems573.push(`could not read what approve_quarantined_device() writes on the device it keeps (${file ?? 'no migration defines it'}), so this check is no longer checking anything`);
  const rekeyed = /UPDATE public\.asset_config\s+SET asset_id = v_candidate\.sparkplug_id\s+WHERE asset_id = v_quarantined\.sparkplug_id;/.test(merge);
  const deleted = /DELETE FROM public\.devices WHERE id = v_quarantined\.id;/.test(merge);

  const src = lf(MODAL);
  const dialog = dialogsIn(src).find((d) => !d.problem && d.kind === 'ConfirmModal' && propText(d.tag, 'title') === 'Accept match');
  if (!dialog) problems573.push(`${MODAL} holds no ConfirmModal titled "Accept match"`);
  const said = (dialog ? `${dialog.tag} ${dialog.body}` : '').replace(/\s+/g, ' ');

  for (const column of written) {
    if (CARRIED[column]) {
      if (dialog && !said.includes(CARRIED[column])) problems573.push(`the question does not say ${column} carries over ("${CARRIED[column]}")`);
    } else if (!UNSAID[column]) problems573.push(`the merge writes ${column} (${file}), and the question does not say so: name it in CARRIED with the question's words, or in UNSAID with why not`);
  }
  for (const column of [...Object.keys(CARRIED), ...Object.keys(UNSAID)]) {
    if (written.length && !written.includes(column)) problems573.push(`the merge no longer writes ${column} (${file}), which this check takes it to`);
  }
  for (const column of KEPT) {
    if (written.includes(column)) problems573.push(`the merge writes ${column} (${file}), which the question says is not carried over`);
  }
  if (dialog) {
    if (rekeyed !== said.includes('the values its birth announced')) problems573.push(`the question and the merge disagree on whether the recorded birth values carry over (${file})`);
    if (deleted !== said.includes('is kept, and the quarantined device is deleted')) problems573.push(`the question and the merge disagree on whether the quarantined device is deleted (${file})`);
    if (!said.includes('its name, gateway, location and schemas')) problems573.push('the question does not say the name, gateway, location and schemas are not carried over');
    if (!propText(dialog.tag, 'onConfirm').includes('onMerge(')) problems573.push("the question's confirm does not run the merge");
    if (propAt(dialog.tag, 'requireTyped') !== -1) problems573.push('the question asks for typed text, and it is a merge into a device the person can see');
  }
  // The one call, so nothing else in the dialog merges.
  if (src.split('onMerge(').length !== 2) problems573.push(`${MODAL} calls onMerge() other than once, from the question`);
  if (!lf(HELP).includes('**Accept Match** asks first')) problems573.push(`${HELP} does not say Accept Match asks first`);

  if (problems573.length) {
    fail('Accept Match does not say what the merge does:\n' + problems573.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`Accept Match asks first, and says what carries over as approve_quarantined_device() writes it (${file}): ${Object.keys(CARRIED).join(', ')} and the birth values, with the quarantined device deleted`);
  }
}

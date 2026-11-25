import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 597. A match is offered for a held device exactly when the database would merge it. suggestMatches()
// offers one for a device with no requarantined_at, to a candidate isNeverSeen() accepts, and
// approve_quarantined_device()'s merge (its latest definition) refuses the rest: a device that is not
// held or has that time, and a target that is archived, held or seen. Each refusal is raise_exception,
// which is the one code approve-quarantine answers with the database's own sentence. The queue's read
// carries the time, and the trigger that writes it fires as the flag is turned on.
// -------------------------------------------------------------------------------------------------

const MATCHING = 'frontend/src/utils/quarantineMatching.js';
const NEVER_SEEN = 'frontend/src/utils/deviceProvisioning.js';
const API = 'frontend/src/api.js';
const FUNCTION = 'supabase/functions/approve-quarantine/refusals.ts';
const DECLARES = 'CREATE OR REPLACE FUNCTION public.approve_quarantined_device(';

/** What the merge refuses, as its condition is written, and what it says. */
const REFUSED = {
  'v_quarantined.is_quarantined IS NOT TRUE': 'is not in Quarantine, so it was not merged.',
  'v_quarantined.requarantined_at IS NOT NULL': 'was registered before it was held in Quarantine, so it was not merged.',
  'v_candidate.is_archived IS TRUE': 'is archived, so nothing was merged into it.',
  'v_candidate.is_quarantined IS TRUE': 'is in Quarantine itself, so nothing was merged into it.',
  'v_candidate.first_dbirth_at IS NOT NULL': 'has already sent its first birth, so nothing was merged into it.',
};

/** What each says where a person reads it. */
const SAID = {
  'help/pages/devices.md': ['A device that was registered before and is held again is offered no match.'],
  'supabase/functions/approve-quarantine/README.md': [
    '`device_id` is not in Quarantine, or was registered before it was held (`requarantined_at`).',
    '`merge_into_device_id` is archived, is in Quarantine itself, or has sent its first birth.',
  ],
};

export default function check() {
  const problems597 = [];
  const lf = (path) => read(path).replace(/\r\n/g, '\n');

  const migrations = allFiles.filter((f) => /^supabase\/migrations\/[0-9]{4}_.*\.sql$/.test(f)).sort();
  const file = migrations.filter((f) => read(f).includes(DECLARES)).at(-1);
  const sql = file ? lf(file) : '';
  const body = sql.slice(sql.indexOf(DECLARES));
  const merge = body.match(/IF p_merge_into_device_id IS NOT NULL THEN([\s\S]*?)UPDATE public\.asset_config/)?.[1] ?? '';
  const refusals = [...merge.matchAll(/IF (v_[a-z_.]+ IS [A-Z ]+) THEN\s+RAISE EXCEPTION '([^']*)',\s+v_(\w+)\.name USING ERRCODE = '(\w+)';/g)];
  if (!refusals.length) problems597.push(`could not read what the merge refuses (${file ?? 'no migration declares approve_quarantined_device()'}), so this check is no longer checking anything`);
  for (const [condition, sentence] of Object.entries(REFUSED)) {
    const refusal = refusals.find((r) => r[1] === condition);
    if (!refusal) problems597.push(`the merge does not refuse ${condition} (${file})`);
    else {
      if (!refusal[2].startsWith(`"%" ${sentence}`)) problems597.push(`the refusal of ${condition} does not say: "%" ${sentence}`);
      if (refusal[4] !== 'raise_exception') problems597.push(`the refusal of ${condition} is ${refusal[4]}, which approve-quarantine does not answer with its sentence`);
    }
  }
  for (const [, condition] of refusals) {
    if (!REFUSED[condition]) problems597.push(`the merge refuses ${condition} (${file}), which this check does not know: name it here, and where the dashboard offers a match`);
  }

  // The candidate side: what the merge refuses of a target is what isNeverSeen() leaves out.
  const neverSeen = lf(NEVER_SEEN).match(/export function isNeverSeen\(device\) \{\s*return ([^\n]*)\n/)?.[1] ?? '';
  for (const column of ['is_quarantined', 'is_archived', 'first_dbirth_at']) {
    if (!neverSeen.includes(`!device.${column}`)) problems597.push(`isNeverSeen() in ${NEVER_SEEN} does not leave out a candidate by ${column}, which the merge refuses`);
  }
  const matching = lf(MATCHING);
  if (!/export function suggestMatches\([^\n]*\{\n {2}if \(quarantineItem\?\.requarantined_at\) return \[\]\n/.test(matching)) {
    problems597.push(`suggestMatches() in ${MATCHING} does not offer nothing for a device that has requarantined_at, first`);
  }
  if (!matching.includes('.filter(isNeverSeen)')) problems597.push(`suggestMatches() in ${MATCHING} does not choose its candidates with isNeverSeen()`);
  const api = lf(API);
  const queue = api.slice(api.indexOf("path.startsWith('/api/v1/quarantine')"), api.indexOf("path.startsWith('/api/v1/links')"));
  if (!queue.includes('requarantined_at: d.requarantined_at || null')) problems597.push(`the Quarantine read in ${API} does not carry requarantined_at`);

  const fn = lf(FUNCTION);
  if (!/case "P0001":\s+return \{ status: 409, error: message \};/.test(fn)) {
    problems597.push(`${FUNCTION} does not answer raise_exception (P0001) as a 409 with the database's sentence`);
  }

  const trigger = migrations.map((f) => lf(f).match(/CREATE TRIGGER trg_devices_requarantined BEFORE UPDATE OF is_quarantined ON public\.devices FOR EACH ROW WHEN \(\(\(new\.is_quarantined IS TRUE\) AND \(old\.is_quarantined IS NOT TRUE\)\)\)/)).find(Boolean);
  if (!trigger) problems597.push('no migration writes requarantined_at as is_quarantined goes from not true to true (trg_devices_requarantined)');

  for (const [path, sentences] of Object.entries(SAID)) {
    for (const sentence of sentences) if (!lf(path).includes(sentence)) problems597.push(`${path} does not say: ${sentence}`);
  }

  if (problems597.length) {
    fail('the dashboard offers a match the database would refuse, or the reverse:\n' + problems597.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`a match is offered only for a device nobody registered, and the merge refuses the ${refusals.length} others (${file}), each in the sentence approve-quarantine answers`);
  }
}

import { allFiles, fail, pass, read, supabaseReadme, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 598. A 3D model's file goes once no device names it, at once or within the hour. uploadDeviceModel()
// deletes the file it replaced once the row names the new one, and never rolls back a file the row still
// names. What a failed delete leaves, the device-model sweep takes: the worker asks the gate 0329
// declares, of the bucket the gate and the policies name, for what has gone the gate's default age
// untouched; the chart runs it, at a minute of its own, and lets it reach the gateway. What counts as
// named is one list in is_unclaimed_device_model_object(), which the upgrade guide's query repeats.
// -------------------------------------------------------------------------------------------------

const MIGRATION = /^supabase\/migrations\/[0-9]{4}_.*\.sql$/;
const NAMED_BY = ['public.devices d', 'public.retired_entities r', 'public.change_proposals p'];

export default function check() {
  const problems598 = [];
  const lf = (path) => read(path).replace(/\r\n/g, '\n');
  const body = (name) => {
    const declares = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const file = allFiles.filter((f) => MIGRATION.test(f)).sort().filter((f) => read(f).includes(declares)).at(-1);
    if (!file) return { file: null, text: '' };
    const sql = lf(file);
    const start = sql.indexOf(declares);
    return { file, text: sql.slice(start, sql.indexOf('\n$$;', start)) };
  };

  const named = body('is_unclaimed_device_model_object');
  const gate = body('ingest_unclaimed_device_model_objects');
  for (const [what, fn] of [['is_unclaimed_device_model_object()', named], ['ingest_unclaimed_device_model_objects()', gate]]) {
    if (!fn.text) problems598.push(`no migration declares ${what}`);
  }
  const guide = upgradingGuide();
  for (const table of NAMED_BY) {
    if (!named.text.includes(`FROM ${table}`)) problems598.push(`is_unclaimed_device_model_object() does not read ${table} (${named.file})`);
    if (!guide.includes(`FROM ${table}`)) problems598.push(`the upgrade guide's query for what the first run deletes does not read ${table}`);
  }
  if ([...named.text.matchAll(/FROM (public\.[a-z_]+ [a-z])\b/g)].some((m) => !NAMED_BY.includes(m[1]))) {
    problems598.push(`is_unclaimed_device_model_object() reads a table this check does not know (${named.file}): name it here and in the upgrade guide's query`);
  }
  const bucket = gate.text.match(/o\.bucket_id = ''([a-z0-9-]+)''/)?.[1];
  const age = gate.text.match(/p_min_age_seconds integer DEFAULT (\d+)/)?.[1];

  const worker = lf('ingestion/device_model_sweep.py');
  const compare = (what, got, want) => { if (got !== want) problems598.push(`${what} is ${got ?? 'not found'}, not ${want}`); };
  compare("the worker's bucket", worker.match(/^BUCKET = "([^"]+)"/m)?.[1], bucket);
  compare("the worker's gate", worker.match(/^GATE = "([^"]+)"/m)?.[1], 'ingest_unclaimed_device_model_objects');
  compare('the age the worker asks for', worker.match(/DEVICE_MODEL_SWEEP_MIN_AGE_SECONDS", "(\d+)"/)?.[1], age);
  if (Number(age) < 24 * 60 * 60) problems598.push(`the gate lists a model ${age} seconds old, which may be an upload in flight: the notes say a day`);

  const policies = lf('supabase/storage-policies.sql');
  for (const name of ['asset_3d_models_select_privileged', 'asset_3d_models_delete_privileged']) {
    const at = policies.indexOf(`CREATE POLICY "${name}" ON storage.objects`);
    const policy = at < 0 ? '' : policies.slice(at, policies.indexOf('\n  );\n', at));
    if (!policy.includes(`bucket_id = '${bucket}'`) || !/\(public\.is_ingestion_caller\(\)\s+AND public\.is_unclaimed_device_model_object\(storage\.objects\.name\)\)/.test(policy)) {
      problems598.push(`${name} in storage-policies.sql does not admit the ingestion principal to an object of ${bucket} that nothing names`);
    }
  }

  const cron = 'deploy/helm/aber/templates/jobs/device-model-sweep-cronjob.yaml';
  if (!lf(cron).includes('command: ["python", "-m", "device_model_sweep"]')) problems598.push(`${cron} does not run python -m device_model_sweep`);
  const values = lf('deploy/helm/aber/values.yaml');
  const schedule = values.match(/^deviceModelSweep:\n[\s\S]*?^ {2}schedule: "([^"]+)"/m)?.[1];
  if (!/^\d+ \* \* \* \*$/.test(schedule ?? '')) problems598.push(`deviceModelSweep.schedule is ${schedule ?? 'not found'}, not once an hour`);
  else if ([...values.matchAll(/^ +schedule: "([^"]+)"/gm)].filter((m) => m[1].split(' ')[0] === schedule.split(' ')[0]).length !== 1) {
    problems598.push(`deviceModelSweep.schedule shares its minute with another default job (${schedule})`);
  }
  if (!guide.includes(`runs every hour at ${schedule?.split(' ')[0]} minutes past`)) problems598.push(`the upgrade guide does not say the device-model sweep runs at ${schedule?.split(' ')[0]} minutes past`);
  if (!/"from" "device-model-sweep"\s+"to" \$gw\s+"port" 8000/.test(lf('deploy/helm/aber/templates/networkpolicy.yaml'))) {
    problems598.push('networkpolicy.yaml does not let the device-model sweep reach the gateway');
  }
  if (!lf('.github/workflows/ci.yml').includes("('device-model-sweep', 'supabase-envoy', 8000,")) problems598.push("ci.yml's required flows do not name the device-model sweep's");

  const api = lf('frontend/src/api.js');
  const upload = api.slice(api.indexOf('uploadDeviceModel: async'), api.indexOf('removeDeviceModel: async'));
  const write = upload.indexOf('.update({ model_3d_path: path })');
  const removes = upload.indexOf('remove([previous]).catch(() => {})');
  if (write < 0 || removes < write || !upload.includes('if (previous && previous !== path) {')) {
    problems598.push('uploadDeviceModel() does not delete the file it replaced once the row names the new one, without failing on it');
  }
  if (!upload.includes('if (!beforeError && previous !== path) await supabase.storage.from(MODEL_3D_BUCKET).remove([path]);')) {
    problems598.push("uploadDeviceModel()'s rollback may delete a file the row still names");
  }
  if (!supabaseReadme().includes('### A 3D model no device names is swept from storage (0329)')) problems598.push('supabase/README.md has no section for 0329');

  if (problems598.length) {
    fail('a 3D model no device names is not swept as the docs say:\n' + problems598.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`a replaced 3D model's file is deleted once the row names the new one, and the device-model sweep takes what is left in ${bucket} after ${age} seconds, hourly at ${schedule}`);
  }
}

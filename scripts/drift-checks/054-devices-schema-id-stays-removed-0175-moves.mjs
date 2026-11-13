import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 54. devices.schema_id stays removed. 0175 moves what the column held into device_submodels rows
// and drops it with its foreign key and trigger. db-init replays every file on every boot, so any
// other file that declares the column, the key or the trigger, or a device_schemas view that reads
// devices, would bring it back or fail the replay. The API spec documents neither the column nor
// the view's old arm, whose `source` value is gone.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DROPPER = '0175_a_device_s_schemas_are_its_submodels.sql';
  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const offences = [];
  if (!files.includes(DROPPER)) offences.push(`${dir}/${DROPPER} is missing`);

  for (const f of files.filter((name) => name !== DROPPER)) {
    const sql = read(`${dir}/${f}`);
    for (const m of sql.matchAll(/(?:CREATE TABLE IF NOT EXISTS|ALTER TABLE(?: ONLY)?) public\.devices\b[\s\S]*?;/g)) {
      if (/\bschema_id\b/.test(m[0])) offences.push(`${f} declares a schema_id column or constraint on public.devices`);
    }
    if (/devices_schema_id_fkey/.test(sql)) offences.push(`${f} names devices_schema_id_fkey`);
    if (/CREATE TRIGGER trg_devices_reject_archived_schema\b/.test(sql)) {
      offences.push(`${f} creates trg_devices_reject_archived_schema`);
    }
    for (const m of sql.matchAll(/CREATE OR REPLACE VIEW public\.device_schemas\b[\s\S]*?;/g)) {
      if (/\bpublic\.devices\b/.test(m[0])) offences.push(`${f} declares a device_schemas view that reads public.devices`);
    }
  }

  const spec = read('docs/openapi.yaml');
  // A component schema's body: the lines after its 4-space key, up to the next 4-space key.
  const components = {
    Device: spec.match(/^ {4}Device:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? null,
    DeviceWrite: spec.match(/^ {4}DeviceWrite:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? null,
  };
  for (const [name, body] of Object.entries(components)) {
    if (body === null) offences.push(`docs/openapi.yaml has no ${name} schema`);
    else if (/^ {8}schema_id:/m.test(body)) offences.push(`docs/openapi.yaml's ${name} still documents schema_id`);
  }
  const deviceSchema = spec.match(/^ {4}DeviceSchema:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? '';
  if (!/^ {8}source: \{ type: string, enum: \[device_submodels\]/m.test(deviceSchema)) {
    offences.push("docs/openapi.yaml's DeviceSchema.source is not the one value device_submodels");
  }

  if (offences.length) {
    fail(`devices.schema_id must stay removed (0175):\n  ${offences.join('\n  ')}`);
  } else {
    pass(`devices.schema_id stays removed: no file but 0175 names the column, its key or its trigger, and the API spec documents neither it nor the view's old arm`);
  }
}

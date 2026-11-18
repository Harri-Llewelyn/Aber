import { readdirSync } from 'node:fs';
import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 443. Nothing but the trigger writes a schema's lineage. trg_schemas_take_their_lineage sets
// lineage_root_id and lineage_name on every insert, from the parent's, so fork_schema(),
// apply_device_schemas() and a direct insert all name theirs without any of them being redeclared. A
// later migration that names either column in an INSERT INTO public.schemas or in a SET of an UPDATE
// would write one a second way, which the trigger derives again and the writer believes it kept.
// Only the fill in 0298 may, with the lineage trigger switched off.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems443 = [];
  const dir = 'supabase/migrations';
  const files = readdirSync(new URL(`../../${dir}/`, import.meta.url)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  let inserts = 0;
  for (const name of files) {
    if (name.startsWith('0298_')) continue;
    const sql = read(`${dir}/${name}`);
    for (const m of sql.matchAll(/INSERT INTO public\.schemas\s*\(([^)]*)\)/g)) {
      inserts += 1;
      if (/lineage_/.test(m[1])) problems443.push(`${name} writes a lineage column in an INSERT INTO public.schemas: the trigger sets it`);
    }
    for (const m of sql.matchAll(/UPDATE public\.schemas\b[^;]*?\bSET\b([^;]*);/gs)) {
      if (/\blineage_(root_id|name)\s*=/.test(m[1])) problems443.push(`${name} sets a lineage column in an UPDATE of public.schemas: the trigger sets it`);
    }
  }
  const mine = read(`${dir}/0298_a_submodel_s_id_follows_its_schema_s_lineage.sql`);
  const fill = mine.slice(mine.indexOf('DO $fill$'), mine.indexOf('END $fill$'));
  if (!/DISABLE TRIGGER trg_schemas_take_their_lineage[\s\S]*SET lineage_root_id[\s\S]*ENABLE TRIGGER trg_schemas_take_their_lineage/.test(fill)) {
    problems443.push('0298\'s fill writes a lineage with the lineage trigger on, or does not turn it back on');
  }
  if (inserts === 0) problems443.push('check 443 found no INSERT INTO public.schemas in the other migrations: the pattern no longer matches how they are written');

  if (problems443.length) {
    fail('a schema\'s lineage is written outside the trigger:\n' + problems443.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`no applied migration but 0298's fill writes a schema's lineage_root_id or lineage_name, across ${inserts} INSERT INTO public.schemas; the trigger sets them`);
  }
}

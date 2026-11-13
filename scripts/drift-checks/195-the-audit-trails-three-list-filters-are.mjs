import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 195. The Audit Trail's three list filters are arrays in every place that states them (0227).
// 0001 and 0168 declare audit_trail_page() with p_entity_type text[], p_action text[] and
// p_changed_by uuid[], and audit_trail_matching() (0228) matches each with = ANY; 0001's sweep of
// stale overloads names that form, or it would drop it on every boot; 0227 drops the single-value
// form; the API reference documents the three as arrays; and api.js sends each as an array from
// listParam() or null. A copy left on one value either brings a second form back or sends a string
// the function refuses.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const LISTS = { p_entity_type: 'text[]', p_action: 'text[]', p_changed_by: 'uuid[]' };
  const COLUMN = { p_entity_type: 't.entity_type', p_action: 't.action', p_changed_by: 't.changed_by' };
  const LIST_IDENT = 'audit_trail_page(integer, boolean, text[], text[], uuid[], timestamp with time zone, '
    + 'timestamp with time zone, timestamp with time zone, bigint, text, uuid[], text[], boolean)';
  // The rows the lists select are audit_trail_matching()'s, which the page calls once per class.
  const m0228 = 'supabase/migrations/0228_the_audit_trail_sorts_events_into_classes_in_the_database.sql';
  const helperSql = allFiles.includes(m0228) ? read(m0228) : '';
  const helperAt = helperSql.indexOf('CREATE OR REPLACE FUNCTION public.audit_trail_matching(');
  const helper = helperAt < 0 ? '' : helperSql.slice(helperAt, helperSql.indexOf('$$;', helperSql.indexOf('AS $$', helperAt)));
  const problems195 = [];

  const declaring = ['0001_baseline_schema.sql', '0168_every_schema_attached_to_a_device_counts.sql'];
  for (const name of declaring) {
    const sql = read(`supabase/migrations/${name}`);
    const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.audit_trail_page(');
    const body = at < 0 ? '' : sql.slice(at, sql.indexOf('$_$;', at));
    if (!body) { problems195.push(`${name} no longer declares audit_trail_page`); continue; }
    const args = body.slice(0, body.indexOf(') RETURNS'));
    for (const [arg, type] of Object.entries(LISTS)) {
      if (!args.includes(`${arg} ${type} DEFAULT NULL::${type}`)) {
        problems195.push(`${name} declares audit_trail_page without ${arg} ${type}`);
      }
      if (!new RegExp(`${COLUMN[arg].replace('.', '\\.')}\\s+= ANY \\(${arg}\\)`).test(helper)) {
        problems195.push(`audit_trail_matching() does not match ${COLUMN[arg]} against any value of ${arg}`);
      }
    }
  }
  if (!read('supabase/migrations/0001_baseline_schema.sql').includes(`'${LIST_IDENT}'`)) {
    problems195.push("0001's sweep of stale overloads does not name the list form, so it drops it on every boot");
  }
  const m0227 = 'supabase/migrations/0227_an_audit_trail_filter_takes_several_values.sql';
  const migration = allFiles.includes(m0227) ? read(m0227) : '';
  if (!/DROP FUNCTION public\.audit_trail_page\(integer, boolean, text, text, uuid\[\],[^)]*bigint, text, uuid\)/.test(migration)) {
    problems195.push(`${m0227} does not drop the single-value form`);
  }

  const spec = read('docs/openapi.yaml');
  const specAt = spec.indexOf('\n  /rest/v1/rpc/audit_trail_page:');
  const entry = specAt < 0 ? '' : spec.slice(specAt, spec.indexOf('\n  /', specAt + 1));
  for (const arg of Object.keys(LISTS)) {
    if (!new RegExp(`\\n\\s+${arg}: \\{ type: array, nullable: true, items: \\{ type: string`).test(entry)) {
      problems195.push(`docs/openapi.yaml's audit_trail_page entry does not document ${arg} as an array`);
    }
  }

  const api = read('frontend/src/api.js');
  const apiAt = api.indexOf("supabase.rpc('audit_trail_page'");
  const branch = apiAt < 0 ? '' : api.slice(api.lastIndexOf("path.includes('/audit-trail')", apiAt), apiAt + 2000);
  for (const arg of Object.keys(LISTS)) {
    const sent = branch.match(new RegExp(`\\n\\s+${arg}: (\\w+)\\.length\\s*\\?[\\s\\S]*?: null,`));
    if (!sent) {
      problems195.push(`frontend/src/api.js does not send ${arg} as an array or null`);
    } else if (!new RegExp(`const ${sent[1]} = listParam\\('`).test(branch)) {
      problems195.push(`frontend/src/api.js sends ${arg} from ${sent[1]}, which listParam() does not make`);
    }
  }

  if (problems195.length) {
    fail(`the Audit Trail's list filters are not arrays everywhere:\n` + problems195.map((p) => `        ${p}`).join('\n'));
  } else {
    pass("audit_trail_page()'s kinds, actions and people are arrays in 0001, 0168, the sweep, 0227, the API reference and api.js");
  }
}

import { compare, lastDefinition, need, problems, read } from './lib.mjs';

// 43. Which kinds each Audit Trail action is written for, and the classes such a row can be in.
// audit_trail_action_kinds() (0229) declares it and AUDIT_TRAIL_ACTION_KINDS mirrors it; the
// Entity, Action and class filters narrow each other by the mirror. A pair the database has and
// the dashboard lacks hides a value that can occur; one the dashboard has and the database lacks
// offers one that cannot. Compared as (action, kind, class) triples, so the grouping may differ.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.audit_trail_action_kinds(', '$$;',
    'audit_trail_action_kinds()');
  const js = need(read('frontend/src/constants.js'), /export const AUDIT_TRAIL_ACTION_KINDS = \[([\s\S]*?)\n\];/,
    'AUDIT_TRAIL_ACTION_KINDS in frontend/src/constants.js');
  const words = (list) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const triples = (rows) => rows
    .flatMap(([action, kinds, classes]) => kinds.flatMap((k) => classes.map((c) => `${action} ${k} ${c}`)))
    .sort();
  if (def && js) {
    const sqlRows = [...def.body.matchAll(/\('([A-Z_]+)',\s*ARRAY\[([^\]]*)\],\s*ARRAY\[([^\]]*)\]\)/g)]
      .map((m) => [m[1], words(m[2]), words(m[3])]);
    const jsRows = [...js[1].matchAll(/\['([A-Z_]+)',\s*\[([^\]]*)\],\s*\[([^\]]*)\]\]/g)]
      .map((m) => [m[1], words(m[2]), words(m[3])]);
    if (sqlRows.length === 0 || jsRows.length === 0) {
      problems.push(`auditTrailActionKinds: found no row in ${sqlRows.length ? 'AUDIT_TRAIL_ACTION_KINDS' : `audit_trail_action_kinds() (${def.file})`} -- its shape changed, so this check is no longer checking anything`);
    } else {
      compare('auditTrailActionKinds', `the ${triples(sqlRows).length} (action, kind, class) triples (${def.file})`,
        triples(jsRows).join('; '), triples(sqlRows).join('; '));
    }
  }
}

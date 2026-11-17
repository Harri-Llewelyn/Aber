import { need, ok, problems, read, SCHEMA } from './lib.mjs';

// 113. The readers of a lineage name fall back alike. Every schema version carries lineage_name,
// the first version's schema_name (0298), and a reader that finds none treats the row as its own
// lineage: the exporter's Submodel key (shell.ts), i3X's source type (address_space.py) and the
// dashboard's labels (schemaVersion.js) each take lineage_name, then schema_name, in that order. The
// trigger gives a first version its own schema_name as its lineage_name, so for a row that predates the
// columns the answer is the same as for one that has them. A reader with another order, or one that
// stops at schema_name, names two versions of a schema two things.
export default function check() {
  const before = problems.length;
  const orderOf = (source, re, what) => {
    const m = need(source, re, what);
    return m ? [m[1], m[2]].join(' then ') : null;
  };
  const readers = [
    ['shell.ts', orderOf(read('supabase/functions/_shared/aas/shell.ts'),
      /String\(schema\.(lineage_name) \|\| schema\.(schema_name) \|\| ""\)/, 'the Submodel key in shell.ts')],
    ['address_space.py', orderOf(read('i3x/address_space.py'),
      /row\.get\("(lineage_name)"\) or row\.get\("(schema_name)"\)/, 'schema_source_type_id() in address_space.py')],
    ['schemaVersion.js', orderOf(read('frontend/src/utils/schemaVersion.js'),
      /schema\?\.(lineage_name) \|\| schema\?\.(schema_name)/, 'lineageName() in schemaVersion.js')],
    ['the schema list in api.js', orderOf(read('frontend/src/api.js'),
      /lineage_name: s\.(lineage_name) \?\? s\.(schema_name)/, 'the schema list in api.js')]
  ];
  const wanted = 'lineage_name then schema_name';
  for (const [where, order] of readers) {
    if (order && order !== wanted) problems.push(`lineageName: ${where} falls back ${order}, not ${wanted}`);
  }
  // The database's half: a first version is its own lineage, carrying its own name.
  const trigger = SCHEMA.slice(SCHEMA.lastIndexOf('CREATE OR REPLACE FUNCTION public.schemas_take_their_lineage()'));
  const root = trigger.slice(0, trigger.indexOf('RETURN NEW;'));
  if (!/NEW\.lineage_root_id := NEW\.id;\s*NEW\.lineage_name := NEW\.schema_name;/.test(root)) {
    problems.push('lineageName: the trigger does not give a first version itself as its root and its own schema_name as its lineage_name, which is what the readers fall back to');
  }
  if (problems.length === before) ok.push('lineageName: the exporter, i3X, the dashboard\'s labels and its schema list each read lineage_name then schema_name, and the trigger gives a first version its own');
}

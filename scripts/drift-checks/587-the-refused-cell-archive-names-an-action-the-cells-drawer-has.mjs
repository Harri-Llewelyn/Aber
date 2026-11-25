import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 587. The HINT of refuse_archiving_an_occupied_cell() sends a script or an API client to an action of the
// cell's drawer, so the action it names is one the Cells page's drawer has. The HINT is the latest body's:
// the last migration that declares the function, which is the one a boot leaves. Check 562 holds what
// the drawers call their actions, and reads no migration.
// -------------------------------------------------------------------------------------------------
const FN = 'refuse_archiving_an_occupied_cell';
const PAGE = 'frontend/src/components/tabs/CellsTab.jsx';

export default function check() {
  const header = `CREATE OR REPLACE FUNCTION public.${FN}(`;
  const file = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort().findLast((f) => read(f).includes(header));
  const sql = file ? read(file) : '';
  const body = sql.slice(sql.lastIndexOf(header)).split('$$;')[0];
  // The HINT opens with the action's name, up to the first comma.
  const action = body.match(/HINT = '([^',]+), in the cell''s panel on the Cells page,/)?.[1];
  if (!action) {
    fail(`check 587 read no action from the HINT of ${FN}() (${file ?? 'no migration'}): its shape has changed, so it is checking nothing`);
  } else if (!read(PAGE).includes(`label: '${action}'`)) {
    fail(`${file}: the HINT of ${FN}() names ${action}, which ${PAGE} has no action called. Redeclare the function in a new migration with the name the drawer uses`);
  } else {
    pass(`the HINT of ${FN}() (${file.slice('supabase/migrations/'.length)}) names ${action}, as the Cells drawer does`);
  }
}

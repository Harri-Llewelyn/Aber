import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 3b. The restore rehearsal's failure issue names steps the workflow has. The table it files is
// the reader's map from a red step to a cause, and a renamed step silently orphans its row.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const wf = read('.github/workflows/restore-rehearsal.yml');
  const steps = new Set([...wf.matchAll(/^ {6}- name: (.+?)\s*$/gm)].map((m) => m[1].trim()));
  const rows = [...wf.matchAll(/^\s*'\| ([^|]+?) \| /gm)].map((m) => m[1].trim())
    .filter((r) => r !== 'Step' && !/^:?-+:?$/.test(r));
  const missing = rows.filter((r) => !steps.has(r));
  if (!rows.length) fail('restore-rehearsal.yml: the failure issue carries no step table');
  else if (missing.length) fail(`restore-rehearsal.yml: the failure issue names step(s) the workflow does not have: ${missing.join('; ')}`);
  else pass(`the restore rehearsal's failure table names ${rows.length} step(s) the workflow has`);
}

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 199. A change to the Audit Trail's classes rebuilds the indexes built on them (0228). Each class's
// partial index keeps the class audit_event_class() gave a row when the index was built, and CREATE
// OR REPLACE FUNCTION does not rebuild it. So a file after 0228 that redeclares the function also
// rebuilds every class index (REINDEX, a statement of its own), or each query naming a class reads
// the old answer. No file before 0228 declares it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const CLASSES_FILE = '0228_the_audit_trail_sorts_events_into_classes_in_the_database.sql';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const problems199 = [];
  const created = files.includes(CLASSES_FILE) ? read(`${dir}/${CLASSES_FILE}`) : '';
  const classes = [...created.matchAll(/CREATE INDEX IF NOT EXISTS idx_audit_trail_class_([a-z]+) ON public\.audit_trail/g)]
    .map((m) => m[1]);
  if (!classes.length) problems199.push(`${CLASSES_FILE} creates no class index, so this check is checking nothing`);
  for (const f of files.filter((name) => name !== CLASSES_FILE)) {
    const sql = read(`${dir}/${f}`);
    if (!/CREATE OR REPLACE FUNCTION public\.audit_event_class\(/.test(sql)) continue;
    if (f < CLASSES_FILE) {
      problems199.push(`${f} declares audit_event_class(), which 0228 declares first with its indexes`);
      continue;
    }
    for (const c of classes) {
      if (!sql.includes(`REINDEX INDEX public.idx_audit_trail_class_${c};`)) {
        problems199.push(`${f} redeclares audit_event_class() without REINDEX INDEX public.idx_audit_trail_class_${c};`);
      }
    }
  }
  if (problems199.length) {
    fail('a change to the Audit Trail\'s classes leaves an index built on the old ones:\n' +
      problems199.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`audit_event_class() comes with its ${classes.length} class indexes in 0228, and no later file changes it without rebuilding them`);
  }
}

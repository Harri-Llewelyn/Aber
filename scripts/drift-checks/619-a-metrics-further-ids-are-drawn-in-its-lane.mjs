import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 619. A metric's further semantic ids are drawn in the metric's lane on the Audit Trail, as 0299 and
// the help say. The timeline keys a lane by its table and its id, and a table it draws in another's
// lane (LANE_TABLES in AuditTrailTab.jsx) must be one whose audit trigger files its rows under that
// other's id: a trigger that filed under the row's own id would put strangers in one lane. The words
// each such row is said in are the ones the help gives.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems619 = [];
  const flat = (text) => text.replace(/\s+/g, ' ');
  const page = read('frontend/src/components/tabs/AuditTrailTab.jsx');
  const help = flat(read('help/pages/audit-trail.md'));

  const tables = page.match(/const LANE_TABLES = \{([^}]*)\}/)?.[1];
  const pairs = [...(tables ?? '').matchAll(/(\w+): '(\w+)'/g)].map((m) => [m[1], m[2]]);
  if (!pairs.length) problems619.push('could not read LANE_TABLES out of AuditTrailTab.jsx');

  // Every audit trigger a migration states: the file, the table and the column it files rows under.
  const AUDIT_TRIGGER = /CREATE TRIGGER \w+ AFTER [A-Z ]+ ON public\.(\w+) FOR EACH ROW EXECUTE FUNCTION public\.log_audit_trail_event\('(\w*)'\)/g;
  const triggers = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_.*\.sql$/.test(f)).sort()
    .flatMap((f) => [...read(f).matchAll(AUDIT_TRIGGER)].map((m) => ({ file: f, table: m[1], column: m[2] })));
  for (const [table, lane] of pairs) {
    // The last file that states the table's audit trigger decides what its entity_id is.
    const stated = triggers.filter((t) => t.table === table).at(-1);
    if (!stated) {
      problems619.push(`no migration states ${table}'s audit trigger, so its rows cannot be put in ${lane}'s lane`);
    } else if (!stated.column.endsWith('_id')) {
      problems619.push(`${stated.file} files ${table}'s rows under '${stated.column}', not the id of a ${lane} row`);
    }
  }

  const words = [...(page.match(/const FURTHER_ID_WORDS = \{([^}]*)\}/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (words.length !== 3) problems619.push('could not read the three FURTHER_ID_WORDS out of AuditTrailTab.jsx');
  for (const w of words) if (!help.includes(`**${w}**`)) problems619.push(`help/pages/audit-trail.md does not give "${w}"`);
  if (!help.includes("**A metric's further semantic IDs are in the metric's lane**")) {
    problems619.push("help/pages/audit-trail.md does not say a metric's further semantic IDs are in its lane");
  }

  if (problems619.length) {
    fail(`A metric's further semantic ids are not drawn as the help says:\n${problems619.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`${pairs.map(([t, l]) => `${t} is drawn in ${l}'s lane`).join(', ')}, filed under its id, and the help gives the ${words.length} words`);
  }
}

import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 103. The Realtime accepted risk in docs/security-model.md names every table the supabase_realtime
// publication carries. Its exposure is "an observer learns when these change", so a table added to
// the publication and not to the risk is a leak nobody accepted. The list is 0001's `intended`.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const BASELINE = 'supabase/migrations/0001_baseline_schema.sql';
  const DOC = 'docs/security-model.md';
  const intended = read(BASELINE).match(/intended CONSTANT text\[\] := ARRAY\[([^\]]*)\]/);
  const published = intended ? [...intended[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
  const doc = read(DOC);
  const start = doc.indexOf('### Realtime leaks the timing of changes');
  const risk = start === -1 ? '' : doc.slice(start, doc.indexOf('\n### ', start + 1));
  const named = new Set([...risk.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
  const missing = published.filter((t) => !named.has(t));
  if (!published.length) {
    fail(`check 103 found no "intended" publication list in ${BASELINE}, so it checks nothing`);
  } else if (!risk) {
    fail(`${DOC} has no "Realtime leaks the timing of changes" accepted risk`);
  } else if (missing.length) {
    fail(`${DOC}'s Realtime accepted risk does not name ${missing.join(', ')}, which the publication carries`);
  } else {
    pass(`the Realtime accepted risk names all ${published.length} published tables`);
  }
}

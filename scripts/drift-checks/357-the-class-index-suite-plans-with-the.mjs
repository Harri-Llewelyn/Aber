import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 357. The class-index suite plans with the pages visible, and says why when it fails. A count that
// names a class is an index-only scan only on pages the visibility map marks all-visible, and until
// autovacuum has been through the current month's partition the planner may read it through a
// bitmap scan whose recheck computes the class. So the test runs VACUUM (ANALYZE) first, outside its
// transaction, and a failure carries the plan, last_autovacuum and relallvisible against relpages.
// 0228's section says what a busy partition costs. A suite that dropped the VACUUM would fail on the
// runs autovacuum is late, though nothing it tests had changed.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems357 = [];
  const suite = read('supabase/migrations/test_the_audit_trail_sorts_events_into_classes_in_the_database.py').replace(/\r\n/g, '\n');
  const vacuum = suite.match(/ {4}def make_the_pages_visible\(self\):[\s\S]*?(?=\n {4}def )/)?.[0] ?? '';
  if (!vacuum.includes('conn.autocommit = True') || !vacuum.includes('VACUUM (ANALYZE) public.audit_trail;')) {
    problems357.push('the suite has no make_the_pages_visible() that runs VACUUM (ANALYZE) public.audit_trail on an autocommit connection');
  }
  const test = suite.match(/ {4}def test_each_class_has_a_valid_index_that_a_query_naming_it_uses\(self\):[\s\S]*?(?=\n {4}def )/)?.[0] ?? '';
  if (!test) problems357.push('the suite has no test_each_class_has_a_valid_index_that_a_query_naming_it_uses');
  else {
    const at = (needle) => test.indexOf(needle);
    if (at('self.make_the_pages_visible()') < 0 || at('self.make_the_pages_visible()') > at('EXPLAIN')) {
      problems357.push('test_each_class_has_a_valid_index_that_a_query_naming_it_uses does not make the pages visible before it explains');
    }
    if (!/assertRegex\(plan, r"Index Only Scan using \\S\+", why\)/.test(test)) problems357.push('its Index Only Scan assertion does not carry the planner state');
    if (!/assertNotIn\("CASE", plan, .*\+ why\)/.test(test)) problems357.push('its no-CASE assertion does not carry the planner state');
  }
  const state = suite.match(/ {4}def partition_state\(self\):[\s\S]*?(?=\n {4}def )/)?.[0] ?? '';
  for (const piece of ['last_autovacuum', 'last_vacuum', 'relallvisible', 'relpages']) {
    if (!state.includes(piece)) problems357.push(`partition_state() does not report ${piece}`);
  }
  const section = supabaseReadme().replace(/\s+/g, ' ');
  if (!section.includes('On a busy current partition the class counts may recheck rows until autovacuum catches up, which costs time and never changes an answer.')) {
    problems357.push("supabase/README.md's 0228 section does not say what a busy current partition costs the class counts");
  }
  if (problems357.length) {
    fail('the class-index suite and its documents disagree about the visibility map:\n' +
      problems357.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the class-index suite runs VACUUM (ANALYZE) before it explains and reports the planner\'s state on a failure, and the 0228 section says what a busy partition costs');
  }
}

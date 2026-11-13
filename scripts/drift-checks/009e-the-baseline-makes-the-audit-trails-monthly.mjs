import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 9e. The baseline makes the audit trail's monthly partitions before its default partition and
// before any trigger. On a first install the stack writes while db-init is still running; an
// audited row that reaches the default for a month with no partition stops that partition from
// ever being created, and every later boot fails.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const baseline = read('supabase/migrations/0001_baseline_schema.sql');
  const months = baseline.search(/^SELECT public\.ensure_audit_trail_partitions\(/m);
  const fallback = baseline.search(/^CREATE TABLE IF NOT EXISTS public\.audit_trail_default PARTITION OF/m);
  const trigger = baseline.search(/^CREATE TRIGGER /m);
  if (months < 0 || fallback < 0 || trigger < 0) {
    fail('check 9e could not find the monthly partitions call, the default partition or a trigger in 0001');
  } else if (!(months < fallback && fallback < trigger)) {
    fail(
      '0001 must call ensure_audit_trail_partitions() before it creates audit_trail_default, and both\n' +
        '      before its first trigger: an audited write that reaches the default partition first\n' +
        '      blocks that month\'s partition for good. generate-baseline-section.mjs emits this\n' +
        '      order (AROUND_PARTITION).'
    );
  } else {
    pass('0001 makes the audit trail\'s monthly partitions before its default partition and its triggers');
  }
}

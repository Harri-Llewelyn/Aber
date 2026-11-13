import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 15. The alert retention window is declared once and cited consistently. The number lives in
// the seeded `alerts.retention_days` setting; supabase/README.md quotes it, including its
// counter-example predicate.
// -------------------------------------------------------------------------------------------------
export default function check() {
  // The seeded value is DML, so it folded into 0002 and is still executed on every boot. The
  // counter-example is a comment in the archived 0030's header, which a generated baseline cannot
  // carry; it is read as documentation and nothing there is executed.
  const MIGRATION = 'supabase/migrations/archive/0030_platform_alerts_retention.sql';
  const SETTING = 'supabase/migrations/0002_seed_data.sql';

  // The source of truth is the seeded setting, not prune_platform_alerts()'s default argument,
  // which is NULL.
  const seeded = read(SETTING).match(
    /seed_setting\(\s*'alerts\.retention_days',\s*to_jsonb\((\d+)\)/
  );

  if (!seeded) {
    fail(
      `${SETTING}: no \`seed_setting('alerts.retention_days', to_jsonb(N)\` call. That seeded ` +
        'value IS the retention window now, and is the single source every other mention is ' +
        'checked against.'
    );
  } else {
    const declared = seeded;
    const days = declared[1];

    // Where the number is quoted, and what it would mean for each to be stale. Substring matches,
    // not regexes: the strings are full of reserved characters, and an escaping slip fails open.
    // Archived 0030's counter-example keeps 1.0's 7 days: the archive is the record of what each
    // file did, so it is held to mention 0032 below and not to the number now seeded.
    const CITATIONS = [
      {
        file: 'supabase/README.md',
        needle: `kept for ${days} days`,
        what: 'the retention section headline',
      },
      {
        file: 'supabase/README.md',
        needle: `interval '${days} days';  -- WRONG`,
        what: 'the counter-example in the retention section',
      },
    ];

    const stale = CITATIONS.filter(({ file, needle }) => !readDoc(file).includes(needle));

    // 0030 STILL CONTAINS THE OLD DEFAULT and must say so, or it reads as the live definition.
    // Its function body is replaced by 0032 on every boot, which is invisible from inside 0030.
    if (!read(MIGRATION).includes('0032')) {
      fail(
        `${MIGRATION} does not mention 0032. Its prune_platform_alerts() is superseded on every ` +
          'boot by the version that reads alerts.retention_days, so a reader who stops at 0030 ' +
          'takes its default argument for the live retention window.'
      );
    }

    if (stale.length) {
      for (const { file, what } of stale) {
        fail(
          `alert retention: alerts.retention_days is seeded at ${days} days, but ${file} does ` +
            `not state it where expected -- ${what}`
        );
      }
    } else {
      pass(
        `the ${days}-day alert retention window is declared once in 0032's seed_setting() and ` +
          `cited consistently in ${new Set(CITATIONS.map((c) => c.file)).size} files`
      );
    }
  }
}

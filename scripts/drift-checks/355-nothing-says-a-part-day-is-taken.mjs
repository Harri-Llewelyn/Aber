import { allFiles, fail, gitignored, pass, read, readDoc, supabaseReadme, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 355. Nothing says a part day is taken as it is, and the upgrade guide quotes the line 0285 logs.
// The suppression and export readers took a part day until 0285; the prose that said so is gone, the
// refusal no longer words a part day (no trim_scale in its redeclaration), and the guide's line,
// "0285: <key> held 1.5 and now holds 1", and the grep in its After-an-upgrade table are the
// NOTICE the file raises.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SQL = 'supabase/migrations/0285_a_number_setting_says_whether_it_counts_whole_things.sql';
  const sql = read(SQL);
  const problems355 = [];
  for (const file of allFiles.filter((f) => f.endsWith('.md') && !gitignored(f))) {
    if (readDoc(file).includes('part day is taken as it is')) problems355.push(file + ' still says a part day is taken as it is');
  }
  const fn = sql.indexOf('CREATE OR REPLACE FUNCTION public.check_alert_suppression_window_length(');
  if (fn < 0 || sql.slice(fn, sql.indexOf('$;', fn + 80)).includes('trim_scale')) {
    problems355.push(SQL + ' does not redeclare check_alert_suppression_window_length() without trim_scale');
  }
  const guide = upgradingGuide();
  if (!/RAISE NOTICE '0285: % held % and now holds %;/.test(sql)) {
    problems355.push(SQL + ' raises no NOTICE of the form "0285: <key> held <old> and now holds <new>"');
  } else {
    if (!guide.includes('`0285: <key> held 1.5 and now holds 1`')) problems355.push('the upgrade guide does not quote "0285: <key> held 1.5 and now holds 1"');
    if (!guide.includes("grep '0285:'")) problems355.push("the upgrade guide's After-an-upgrade table does not grep for '0285:'");
  }
  const readme = supabaseReadme();
  for (const [what, title, next] of [
    ['0240', '### An alert stays quiet during planned work (0240)', "### The Audit Trail files a suppression window's acts (0241)"],
    ['0278', '### The longest export is a setting (0278)', '### An export of readings is checked, bounded and recorded (0279)'],
  ]) {
    const zone = readme.slice(readme.indexOf(title), readme.indexOf(next));
    if (!zone.includes('whole days (`0285`)')) problems355.push("supabase/README.md's " + what + ' section does not say a part day is its whole days (0285)');
  }
  if (problems355.length) {
    fail('the part-day prose or the rounding line is stale against 0285:\n' + problems355.map((p) => '        ' + p).join('\n'));
  } else {
    pass('no document says a part day is taken as it is, the suppression refusal words whole days, and the guide quotes the NOTICE 0285 raises');
  }
}

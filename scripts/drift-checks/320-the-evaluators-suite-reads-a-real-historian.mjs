import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 320. The evaluator's suite reads a real historian when ABER_TEST_HISTORIAN names one, and the
// testing document and the migrations' README say how to name it. A variable nobody documents is a
// test nobody runs.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const VARIABLE = 'ABER_TEST_HISTORIAN';
  const suite = read('supabase/migrations/test_a_threshold_automation_raises_its_alert_from_the_database.py');
  const problems320 = [];
  if (!suite.includes(`os.getenv("${VARIABLE}"`)) problems320.push(`the evaluator's suite does not read ${VARIABLE}`);
  for (const doc of ['docs/testing.md', 'supabase/README.md']) {
    if (!readDoc(doc).includes(VARIABLE)) problems320.push(`${doc} does not name ${VARIABLE}`);
  }
  if (problems320.length) {
    fail(`the evaluator's historian variable is not documented where it is read:\n${problems320.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`${VARIABLE} is read by the evaluator's suite and named by the testing document and the migrations' README`);
  }
}

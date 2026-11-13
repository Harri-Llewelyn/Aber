import { auditSuites, LANES, SUITES, suitesInLane } from '../python-suites.mjs';
import { allFiles, fail, pass } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 4b. Every Python test suite has a runner, and every declared runner has a suite. Both directions.
// Suites are discovered from the tree and placed by the header at the top of each suite file, read
// by scripts/python-suites.mjs; this is the
// comparison. run-python-suites.mjs makes the same check and cannot be bypassed, but only fires
// in a job that runs Python; this fails earlier and names the file.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const { orphans, phantoms, badLanes, badRunners, unexplained, badHeaders } = auditSuites(allFiles);

  if (orphans.length) {
    fail(
      `${orphans.length} Python suite(s) have no header naming a lane, so they run ` +
        `nowhere: ${orphans.join(', ')}. Give each one a header at the top of its file (\`# suite:\`, with ` +
        `\`lanes:\` and \`why:\`) naming a lane -- unit (needs nothing), db (needs ` +
        `the migrated Postgres), stack (needs the composed stack) -- or 'manual' with a reason.`
    );
  }
  if (phantoms.length) {
    fail(
      `${phantoms.length} file(s) carry a suite header and are not Python suites in the tree: ` +
        `${phantoms.join(', ')}. A stale header makes the orphan count above read low.`
    );
  }
  if (badLanes.length) {
    fail(`the suite header declares no lane or an unknown one for: ${badLanes.join(', ')}`);
  }
  if (badRunners.length) {
    fail(
      `the suite header declares an unknown runner for: ${badRunners.join(', ')}. An ` +
        `unrecognised value falls back to \`python <file>\`, which for a pytest-style suite means ` +
        `running nothing and reporting success.`
    );
  }
  if (unexplained.length) {
    fail(
      `the suite header carries no reason for: ${unexplained.join(', ')}. The reason is ` +
        `the part a reader cannot reconstruct -- why the suite is worth a job's time, and what a ` +
        `regression in it would look like from outside.`
    );
  }
  if (badHeaders.length) {
    fail(`a suite header cannot be read: ${badHeaders.join('; ')}`);
  }
  if (!orphans.length && !phantoms.length && !badLanes.length && !badRunners.length && !unexplained.length && !badHeaders.length) {
    const counts = LANES.map((l) => `${suitesInLane(l).length} ${l}`).filter((c) => !c.startsWith('0 '));
    pass(`all ${Object.keys(SUITES).length} Python suites have a runner (${counts.join(', ')})`);
  }
}

import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 4. docs/testing.md says how to list the Python test suites. The list itself is the header at the
// top of each suite file, which `run-python-suites.mjs --list` prints; check 4b holds every suite
// in the tree to one.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const suites = allFiles.filter((f) => /(^|\/)test_[a-z0-9_]+\.py$/.test(f));
  const command = 'node scripts/run-python-suites.mjs --list';
  if (!read('docs/testing.md').includes(command)) fail(`docs/testing.md does not say how to list the Python suites: ${command}`);
  else if (!read('scripts/run-python-suites.mjs').includes("'--list'")) fail('scripts/run-python-suites.mjs has no --list, which docs/testing.md names to list the suites');
  else pass(`docs/testing.md says how to list the ${suites.length} Python test suites with the runner's --list, which prints each one's lanes and reason`);
}

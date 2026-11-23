import { auditLibTests, ELSEWHERE, FOLDERS, libTests, testFilesInTree } from '../lib-tests.mjs';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 519. Every *.test.mjs in the tree runs in `npm run test:lib`, or scripts/lib-tests.mjs names what
// runs it instead. test:lib finds its files only in the folders that module lists, so a test file
// anywhere else would run in no job. The runner refuses the same files, but only once it runs; this
// names them first. package.json's test:lib and CI's step must still go through the runner.
// -------------------------------------------------------------------------------------------------
const RUNNER = 'node scripts/run-lib-tests.mjs';

export default function check() {
  const inTree = testFilesInTree(REPO);
  const problems519 = auditLibTests(inTree);
  const script = JSON.parse(read('package.json')).scripts['test:lib'] ?? '';
  if (!script.startsWith(RUNNER)) {
    problems519.push(`package.json's test:lib is \`${script}\`, not \`${RUNNER}\`: a list written by hand leaves the next test file out`);
  }
  if (!/^\s*run: npm run test:lib\s*$/m.test(read('.github/workflows/ci.yml'))) {
    problems519.push('.github/workflows/ci.yml has no step that runs `npm run test:lib`');
  }

  if (problems519.length) {
    fail('a lib test runs nowhere:\n' + problems519.map((p) => `        ${p}`).join('\n'));
  } else {
    const elsewhere = Object.keys(ELSEWHERE).length;
    pass(`all ${libTests(inTree).length} *.test.mjs files in ${FOLDERS.map((f) => `${f}/`).join(', ')} run in test:lib, ` +
      `${elsewhere ? `${elsewhere} more run where ELSEWHERE in scripts/lib-tests.mjs says, ` : ''}and no other is in the tree`);
  }
}

import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 398. A dashboard test waits for what it checks, not for a time. A setTimeout or a setImmediate in
// the tests, or an import of timers/promises, is a wait for a fixed time: it passes on a quiet
// machine and fails on a busy one. A wait for a condition is a waitFor or a findBy, and a test
// about a delay fakes the timer and moves it on. A wait that can be neither is listed here with its
// file, how many it has and why. frontend/README.md's Testing section states the rule. A wait that
// is not listed fails, and so does a listing that no longer matches the file's count.
// -------------------------------------------------------------------------------------------------
const ALLOWED = [
  {
    file: 'frontend/src/__tests__/functionSessionRefusal.test.js',
    waits: 1,
    why: 'one turn of the event loop, once every call has reached the check they share: nothing more specific can be awaited',
  },
];

const WAIT = /\b(?:setTimeout|setImmediate)\s*\(|from\s+'(?:node:)?timers\/promises'/;

/** The lines of a file's code that wait for a fixed time: comments left out. */
const waitsIn = (text) => text.split('\n').filter((line) => {
  const code = line.replace(/(^|\s)\/\/.*$/, '').trim();
  return code && !code.startsWith('*') && !code.startsWith('/*') && WAIT.test(code);
}).length;

export default function check() {
  const tests = allFiles.filter((f) => /^frontend\/src\/(?:__tests__|test)\/.+\.(?:jsx?|mjs)$/.test(f));
  const found = new Map(tests.map((f) => [f, waitsIn(read(f))]).filter(([, n]) => n > 0));
  const problems398 = [];
  for (const [file, n] of found) {
    const listed = ALLOWED.find((a) => a.file === file);
    if (!listed) problems398.push(`${file} waits for a fixed time ${n} time(s) and is not listed`);
    else if (listed.waits !== n) problems398.push(`${file} waits for a fixed time ${n} time(s), and the list says ${listed.waits}`);
  }
  for (const listed of ALLOWED) {
    if (!found.has(listed.file)) problems398.push(`${listed.file} is listed with a wait for a fixed time, and has none: remove it from the list`);
    if (!listed.why) problems398.push(`${listed.file} is listed with no reason`);
  }
  const testing = read('frontend/README.md').replace(/\s+/g, ' ').match(/\n?## Testing ([\s\S]*?)(?= --- ## )/)?.[1] ?? '';
  if (!testing.includes('A test waits for the condition it checks, not for a time.')) {
    problems398.push("frontend/README.md's Testing section does not state the rule this check guards");
  }
  if (problems398.length) {
    fail('a dashboard test waits for a fixed time:\n' + problems398.map((p) => `        ${p}`).join('\n') +
      "\n      Wait for the condition with waitFor or a findBy, or fake the timer, as frontend/README.md's\n" +
      '      Testing section says. A wait that can be neither is listed in this check, with its reason.');
  } else {
    pass(`${tests.length} dashboard test file(s) wait for no fixed time but the ${ALLOWED.length} listed, each with its reason`);
  }
}

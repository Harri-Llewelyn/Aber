import { suitesInLane } from '../python-suites.mjs';
import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 591. A stack suite registers what removes its gateway before it makes one, and signs in before that.
// A class clean-up (addClassCleanup) runs when setUpClass raises, but only if it is registered by then: a
// line between the row and its clean-up that skips or fails leaves the gateway in service on the
// stack's Gateways page, and so does a sign-in after the row. Read from each setUpClass that makes a row
// itself, in the order the lines stand. Check 575 holds the rest of the rule.
// -------------------------------------------------------------------------------------------------
const MAKES = /"\/gateways",\s+method="POST"/;
/** A clean-up that names the gateway, not another thing the class made. */
const REMOVES = /addClassCleanup\([^\n]*gateway/i;
const SIGNS_IN = /\b(?:sign_in|password_grant|administrator)\(/;

/** The body of each setUpClass in a suite, with the line it starts on. */
function setUps(source) {
  const lines = source.split('\n');
  const found = [];
  lines.forEach((line, at) => {
    if (!line.startsWith('    def setUpClass(')) return;
    const body = [];
    for (const next of lines.slice(at + 1)) {
      if (next.trim() && !next.startsWith('     ')) break;
      body.push(next);
    }
    found.push({ line: at + 1, body: body.join('\n') });
  });
  return found;
}

export default function check() {
  const problems591 = [];
  let held = 0;
  for (const suite of suitesInLane('stack')) {
    for (const { line, body } of setUps(read(suite).replace(/\r\n/g, '\n'))) {
      const made = body.search(MAKES);
      if (made < 0) continue;
      held += 1;
      const registered = body.search(REMOVES);
      if (registered < 0 || registered > made) {
        problems591.push(`${suite}:${line}: setUpClass makes a gateway before it registers the class clean-up that removes it`);
      }
      if (SIGNS_IN.test(body.slice(made))) {
        problems591.push(`${suite}:${line}: setUpClass signs in after it has made a gateway, and a sign-in that fails skips`);
      }
    }
  }
  if (held < 6) problems591.push(`only ${held} setUpClass that make a gateway were found, so this check reads nothing`);

  if (problems591.length) {
    fail('a stack suite could leave a gateway of its own in service:\n' + problems591.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${held} stack-suite setUpClass that make a gateway sign in first and register what removes it before they make it`);
  }
}

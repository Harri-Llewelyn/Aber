import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 305. How long a desktop notification waits to name its subject. The notification names the device
// or gateway and where it is, which takes a read; frontend/README.md says it waits at most that many
// seconds before the Sparkplug id stands in, and SUBJECT_WAIT_MS holds the number. A README that says
// two while the code waits ten is a notification that arrives late and a page that says it cannot.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const code = read('frontend/src/utils/desktopNotifications.js');
  const wait = /export const SUBJECT_WAIT_MS = (\d+)/.exec(code)?.[1];
  const said = /for at most (one|two|three|four|five|six|seven|eight|nine|ten) seconds?, and the\s+Sparkplug id stands in/.exec(read('frontend/README.md'))?.[1];
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  if (!wait || !said) {
    fail('check 305: could not read how long a desktop notification waits for its subject from utils/desktopNotifications.js (SUBJECT_WAIT_MS) and frontend/README.md ("for at most N seconds, and the Sparkplug id stands in")');
  } else if (words[Number(wait) / 1000] !== said) {
    fail(`check 305: frontend/README.md says a desktop notification waits at most ${said} seconds for its subject, and SUBJECT_WAIT_MS is ${wait} ms`);
  } else {
    pass(`frontend/README.md says a desktop notification waits at most ${said} seconds for its subject, as SUBJECT_WAIT_MS holds it`);
  }
}

import { suitesInLane } from '../python-suites.mjs';
import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 575. A stack suite that skips or fails in setUpClass leaves the stack as it found it. Python runs
// tearDownClass only when setUpClass returned, and a skip raised there is an exception like any other;
// a class clean-up (addClassCleanup) runs either way. So a class with a setUpClass, its own or one it
// inherits in its file, has no tearDownClass that does more than close what it opened, unless the
// setUpClass calls it before it lets the exception go. The same for a module's pair. docs/testing.md
// states the rule. What this cannot say is whether a clean-up is registered early enough: it goes before
// what it undoes, after the sign-ins that can skip. Check 591 holds that for a gateway's row.
// -------------------------------------------------------------------------------------------------
const RULE = '**A suite that skips leaves the stack as it found it.**';

/** The lines indented further than the line at `at`: the body of a class or a function. */
function bodyOf(lines, at) {
  const indent = lines[at].match(/^ */)[0].length;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && line.match(/^ */)[0].length <= indent) break;
    body.push(line);
  }
  return body;
}

/** A definition's body by name at an indent, or null. */
function definition(lines, name, indent) {
  const at = lines.findIndex((line) => line.startsWith(`${' '.repeat(indent)}def ${name}(`));
  return at === -1 ? null : bodyOf(lines, at);
}

/** Whether a body only closes what it opened: closes, a lookup of what to close, and a guard around one. */
const onlyCloses = (body) => body.map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  .every((line) => /^(?:[\w.]+\.close\(\)|\w+ = getattr\(.*\)|if .*:)$/.test(line));

/** name -> { bases, setUp, tearDown } for the classes at the top level of a suite. */
function classesOf(lines) {
  const classes = new Map();
  lines.forEach((line, at) => {
    const header = line.match(/^class (\w+)(?:\((.*)\))?:/);
    if (!header) return;
    const body = bodyOf(lines, at);
    classes.set(header[1], {
      bases: (header[2] ?? '').split(',').map((base) => base.trim()),
      setUp: definition(body, 'setUpClass', 4),
      tearDown: definition(body, 'tearDownClass', 4),
    });
  });
  return classes;
}

/** The nearest definition of `part` on a class or on a base of it in the same file. */
function inherited(classes, name, part) {
  const found = classes.get(name);
  if (!found) return null;
  return found[part] ?? found.bases.map((base) => inherited(classes, base, part)).find(Boolean) ?? null;
}

export default function check() {
  const suites = suitesInLane('stack');
  const problems575 = [];
  let held = 0;
  for (const suite of suites) {
    const lines = read(suite).split('\n');
    const classes = classesOf(lines);
    for (const [name, own] of classes) {
      const setUp = inherited(classes, name, 'setUp');
      if (!setUp) continue;
      held += 1;
      const tearDown = own.tearDown ?? (own.setUp && inherited(classes, name, 'tearDown'));
      if (!tearDown || onlyCloses(tearDown) || setUp.some((line) => line.includes('cls.tearDownClass()'))) continue;
      problems575.push(`${suite}: ${name}'s tearDownClass undoes what setUpClass made, and Python leaves it out when setUpClass raises`);
    }
    const setUpModule = definition(lines, 'setUpModule', 0);
    const tearDownModule = definition(lines, 'tearDownModule', 0);
    if (setUpModule && tearDownModule && !onlyCloses(tearDownModule)) {
      problems575.push(`${suite}: tearDownModule undoes what setUpModule made, and Python leaves it out when setUpModule raises`);
    }
  }
  if (held < 20) problems575.push(`only ${held} classes of the stack suites were read with a setUpClass, so this check reads nothing`);
  if (!read('docs/testing.md').replace(/\s+/g, ' ').includes(RULE)) {
    problems575.push('docs/testing.md does not state the rule this check guards');
  }
  if (problems575.length) {
    fail('a stack suite that skips would leave the stack changed:\n' + problems575.map((p) => `        ${p}`).join('\n') +
      '\n      Sign in before making anything, and register what undoes the rest with cls.addClassCleanup()\n' +
      '      just before it is made.');
  } else {
    pass(`no class of ${suites.length} stack suites leaves what its setUpClass made to a tearDownClass, which Python leaves out when setUpClass raises (${held} with a setUpClass read)`);
  }
}

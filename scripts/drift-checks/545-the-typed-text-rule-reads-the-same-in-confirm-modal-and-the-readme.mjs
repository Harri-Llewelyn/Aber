import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 545. What typed text guards is written down once, in the same words in two places: ConfirmModal's
// `requireTyped`, which a caller reads, and frontend/README.md's *Typed text guards removing access
// and what cannot be undone*. The rule is from "Typed text guards removing" to the end of the list of
// what it does not guard.
// -------------------------------------------------------------------------------------------------

const DOC = 'frontend/src/components/modals/ConfirmModal.jsx';
const README = 'frontend/README.md';
const HEADING = "\n### Typed text guards removing access and what cannot be undone\n";
const START = 'Typed text guards removing a person';

export default function check() {
  const problems545 = [];
  const lf = (path) => read(path).replace(/\r\n/g, '\n');
  // The bullets stay, so a list's items are compared as items.
  const flat = (text) => text.replace(/\s+/g, ' ').trim();

  const param = lf(DOC).match(/\n \* @param \{string\} \[requireTyped\]([\s\S]*?)\n \*\n \* @param /)?.[1] ?? '';
  const doc = flat(param.replace(/\n \* ?/g, '\n'));
  const rule = doc.includes(START) ? doc.slice(doc.indexOf(START)) : '';
  if (!rule) problems545.push(`${DOC} does not state the rule under @param requireTyped`);

  const readme = lf(README);
  const at = readme.indexOf(HEADING);
  const section = at === -1 ? '' : readme.slice(at + HEADING.length, readme.indexOf('\n### ', at + HEADING.length));
  if (!section) problems545.push(`${README} has no "${HEADING.trim().slice(4)}" section`);
  else if (rule && !flat(section).startsWith(rule)) problems545.push(`${README}'s section does not open with the rule in ${DOC}'s words: ${rule}`);

  if (problems545.length) {
    fail('The rule on typed text reads otherwise in one place than the other:\n' + problems545.map((p) => `        ${p}`).join('\n'));
  } else {
    pass("what typed text guards reads the same under ConfirmModal's requireTyped and in frontend/README.md");
  }
}

import { allFiles, fail, pass, read } from './lib.mjs';
import { tagEnd } from '../lib/jsx-dialogs.mjs';

// -------------------------------------------------------------------------------------------------
// 613. A value nobody can change is drawn one way, as frontend/README.md's *A value nobody can change is
// a label* says: by StaticField (common/StaticField.jsx), where its field would be, with the reason in
// words. Under frontend/src no other source writes the part's classes or the `.metric-edit-facts` row it
// replaced, draws a read-only <input> or <textarea>, switches a control off for a person who proposes,
// or greys out a whole LocationPicker, except as listed with why. A listing that no longer matches fails
// too. Comments and tests are not read.
// -------------------------------------------------------------------------------------------------

const SRC = 'frontend/src/';
const PART = 'components/common/StaticField.jsx';

/** What each rule looks for, and the listed exceptions: the file and why. */
const RULES = [
  {
    what: 'writes StaticField\'s classes (form-static, static-field)',
    found: (src) => /["'`\s]form-static\b|["'`\s]static-fields?\b/.test(src),
    part: true,
    allowed: [],
  },
  {
    what: 'writes the .metric-edit-facts row',
    found: (src) => /\bmetric-edit-facts\b/.test(src),
    allowed: [],
  },
  {
    what: 'draws a read-only input',
    found: (src) => [...src.matchAll(/<(?:input|textarea)\b/g)].some((m) => /\sreadOnly\b/.test(src.slice(m.index, tagEnd(src, m.index) + 1))),
    allowed: [
      ['components/modals/ChangePasswordModal.jsx', "hidden: the address a browser's password manager files the password under"],
    ],
  },
  {
    what: 'switches a control off for a person who proposes',
    found: (src) => /\bdisabled=\{[^}]*\bproposeMode\b/.test(src),
    allowed: [],
  },
  {
    what: 'greys out a whole LocationPicker',
    found: (src) => [...src.matchAll(/<LocationPicker\b/g)].some((m) => /\sdisabled\b/.test(src.slice(m.index, tagEnd(src, m.index) + 1))),
    allowed: [],
  },
];

const RULE_IN_README = '**In a dialog or a form it is a `StaticField`**';

/** A source without its comments, each left as blank lines so a line number still holds. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

export default function check() {
  const problems613 = [];
  const sources = new Map(allFiles
    .filter((f) => /^frontend\/src\/.*\.jsx?$/.test(f) && !f.includes('/__tests__/') && !f.startsWith(`${SRC}test/`))
    .map((f) => [f.slice(SRC.length), code(read(f).replace(/\r\n/g, '\n'))]));
  const lineOf = (src, found) => src.split('\n').findIndex((line) => found(line)) + 1;

  for (const { what, found, part = false, allowed } of RULES) {
    if (part && !found(sources.get(PART) ?? '')) problems613.push(`${SRC}${PART} no longer ${what}: the part moved, so name where it is now`);
    for (const [file, src] of sources) {
      if (file === PART || !found(src) || allowed.some(([f]) => f === file)) continue;
      const at = lineOf(src, found);
      problems613.push(`${SRC}${file}${at ? `:${at}` : ''} ${what}: draw a StaticField, or list it here with why`);
    }
    for (const [file] of allowed) {
      if (!found(sources.get(file) ?? '')) problems613.push(`${SRC}${file} is listed as one that ${what}, and does not: remove it`);
    }
  }
  if (!read('frontend/README.md').replace(/\s+/g, ' ').includes(RULE_IN_README)) problems613.push(`frontend/README.md does not say: ${RULE_IN_README}`);

  if (problems613.length) {
    fail('A value nobody can change is drawn by hand (frontend/README.md, A value nobody can change is a label):\n'
      + problems613.map((p) => `        ${p}`).join('\n'));
  } else {
    const users = [...sources].filter(([file, src]) => file !== PART && /<StaticFields?\b|<StaticEmpty\b/.test(src)).length;
    const exceptions = RULES.reduce((n, r) => n + r.allowed.length, 0);
    pass(`a value nobody can change is a StaticField in ${users} dashboard sources: none of the others writes its classes, draws a read-only input or switches a control off for a proposer, but for ${exceptions} listed with why`);
  }
}

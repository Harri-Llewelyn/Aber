import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 560. A field's error is drawn one way, as frontend/README.md's *A dialog says why it cannot go
// ahead* says: by common/FieldError.jsx, and a form's problem by common/FormProblem.jsx. No other
// source under frontend/src writes the `hint-danger` class, gives an element `role="alert"`, sets
// `aria-invalid` (fieldErrorProps does) or draws a danger border inline (App.css's rule does), except
// as listed here with how many and why. A listing that no longer matches its file fails too.
// Comments are not read.
// -------------------------------------------------------------------------------------------------

const FIELD = 'frontend/src/components/common/FieldError.jsx';
const FORM = 'frontend/src/components/common/FormProblem.jsx';
const COMPONENTS = 'frontend/src/components/';

const SIGN_IN = 'the sign-in card\'s own message, about the whole form';
const PREVIEW = 'a file whose preview failed: the dialog\'s subject, not a field of it';

/** What each rule looks for, the parts that may, and the listed exceptions: file, how many, why. */
const RULES = [
  {
    what: 'the hint-danger class',
    found: /hint-danger/g,
    parts: [FIELD, FORM],
    allowed: [],
  },
  {
    what: 'role="alert"',
    // A role given as a string, or chosen by an expression.
    found: /\brole=(?:"alert"|\{[^}\n]*['"]alert['"])/g,
    parts: [FIELD],
    allowed: [
      [`${COMPONENTS}common/Modal.jsx`, 1, 'the dialog\'s error slot: a refused act, not a field'],
      [`${COMPONENTS}common/Toast.jsx`, 1, 'the region the toasts are announced in'],
      [`${COMPONENTS}modals/ApplyAutomationsModal.jsx`, 1, PREVIEW],
      [`${COMPONENTS}modals/ApplyDerivedMetricsModal.jsx`, 1, PREVIEW],
      [`${COMPONENTS}modals/ApplySchemasModal.jsx`, 1, PREVIEW],
      [`${COMPONENTS}auth/SecondFactorChallenge.jsx`, 2, SIGN_IN],
      ['frontend/src/pages/ResetPassword.jsx', 1, SIGN_IN],
      ['frontend/src/App.jsx', 1, SIGN_IN],
    ],
  },
  {
    what: 'aria-invalid',
    found: /aria-invalid/g,
    parts: [FIELD],
    allowed: [],
  },
  {
    what: 'an inline danger border',
    found: /\bborder[\w-]*['"]?\s*:\s*['"`][^'"`\n]*var\(--danger\)/g,
    parts: [],
    allowed: [
      [`${COMPONENTS}common/AutomationEditor.jsx`, 1, 'the code editor\'s own theme, which takes no class'],
      [`${COMPONENTS}auth/SecondFactorChallenge.jsx`, 1, SIGN_IN],
      ['frontend/src/pages/ResetPassword.jsx', 1, SIGN_IN],
      ['frontend/src/App.jsx', 1, SIGN_IN],
    ],
  },
];

const RULE_IN_README = 'A field\'s error is a `FieldError`, under the field and its hint.';

/** A source without its comments, each left as blank lines so a line number still holds. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

export default function check() {
  const problems560 = [];
  const sources = new Map(allFiles
    .filter((f) => /^frontend\/src\/.*\.jsx?$/.test(f) && !f.includes('/__tests__/') && !f.startsWith('frontend/src/test/'))
    .map((f) => [f, code(read(f).replace(/\r\n/g, '\n'))]));

  for (const { what, found, parts, allowed } of RULES) {
    for (const part of parts) {
      if (!(sources.get(part) ?? '').match(found)) problems560.push(`${part} no longer writes ${what}: the part moved, so name where it is now`);
    }
    for (const [file, src] of sources) {
      if (parts.includes(file)) continue;
      const hits = [...src.matchAll(found)];
      const listed = allowed.find(([f]) => f === file);
      if (hits.length === (listed?.[1] ?? 0)) continue;
      const lines = hits.map((m) => src.slice(0, m.index).split('\n').length).join(', ');
      problems560.push(listed
        ? `${file} writes ${what} ${hits.length} time(s)${lines ? ` (line ${lines})` : ''}, and the list says ${listed[1]}: ${listed[2]}`
        : `${file}:${lines} writes ${what}: a field's error is FieldError's, a form's is FormProblem's, or list it here with why`);
    }
    for (const [file] of allowed) {
      if (!sources.has(file)) problems560.push(`${file} is listed for ${what}, and is not there`);
    }
  }

  if (!read('frontend/README.md').replace(/\s+/g, ' ').includes(RULE_IN_README)) {
    problems560.push(`frontend/README.md does not say: ${RULE_IN_README}`);
  }

  if (problems560.length) {
    fail('A field\'s error is drawn by hand (frontend/README.md, A dialog says why it cannot go ahead):\n' +
      problems560.map((p) => `        ${p}`).join('\n'));
  } else {
    const exceptions = RULES.reduce((n, r) => n + r.allowed.length, 0);
    pass(`a field's error is FieldError's and a form's is FormProblem's: none of the ${sources.size} other dashboard sources writes hint-danger, role="alert", aria-invalid or an inline danger border, but for ${exceptions} listed with why`);
  }
}

import { allFiles, fail, pass, read } from './lib.mjs';
import { tagEnd } from '../lib/jsx-dialogs.mjs';

// -------------------------------------------------------------------------------------------------
// 579. A value to copy is drawn one way, as frontend/README.md's *A value to copy* says: by CopyField and
// CopyBlock (common/CopyField.jsx), a chip by CopyableId and an appliance's command by ApplianceCommand,
// each on useCopy(), which holds the tick's time and the refusal's words. Under frontend/src no other
// source calls useCopy() or copyText(), reaches the clipboard, or draws a read-only <input> or <textarea>,
// except as listed with why. A listing that no longer matches fails too. Comments are not read. It does
// not see a copy made through another function's name.
// -------------------------------------------------------------------------------------------------

const SRC = 'frontend/src/';
const COMPONENTS = `${SRC}components/`;

/** What each rule looks for, the parts that may, and the listed exceptions: the file and why. */
const RULES = [
  {
    what: 'calls useCopy()',
    found: (src) => /\buseCopy\(/.test(src),
    parts: ['hooks/useCopy.js', 'components/common/CopyField.jsx', 'components/common/CopyableId.jsx', 'components/common/ApplianceCommand.jsx'],
    allowed: [],
  },
  {
    what: 'calls copyText()',
    found: (src) => /\bcopyText\(/.test(src),
    parts: ['utils/copyText.js', 'hooks/useCopy.js'],
    allowed: [
      ['components/common/HelpMarkdown.jsx', "a help page's code block, whose refusal is beside its button"],
      ['components/tabs/ProfileTab.jsx', 'the access token, which is read as it is copied and never drawn'],
      ['components/tabs/SystemLogs.jsx', 'a log line, copied from its row'],
    ],
  },
  {
    what: 'reaches the clipboard',
    found: (src) => /\bnavigator\.clipboard\b|execCommand\(['"]copy/.test(src),
    parts: ['utils/copyText.js'],
    allowed: [],
  },
  {
    what: 'draws a read-only input',
    found: (src) => [...src.matchAll(/<(?:input|textarea)\b/g)].some((m) => /\sreadOnly\b/.test(src.slice(m.index, tagEnd(src, m.index) + 1))),
    parts: [],
    allowed: [
      ['components/modals/ChangePasswordModal.jsx', "hidden: the address a browser's password manager files the password under"],
    ],
  },
  {
    what: 'keeps a copy\'s time of its own',
    found: (src) => /\bCOPY_FEEDBACK_MS\s*=|\bCOPY_REFUSED\s*=/.test(src),
    parts: ['hooks/useCopy.js'],
    allowed: [],
  },
];

const RULE_IN_README = '**The value is text, never an input.**';

/** A source without its comments, each left as blank lines. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

export default function check() {
  const problems579 = [];
  const sources = new Map(allFiles
    .filter((f) => /^frontend\/src\/.*\.jsx?$/.test(f) && !f.includes('/__tests__/') && !f.startsWith(`${SRC}test/`))
    .map((f) => [f, code(read(f).replace(/\r\n/g, '\n'))]));

  for (const { what, found, parts, allowed } of RULES) {
    for (const part of parts) {
      if (!found(sources.get(SRC + part) ?? '')) problems579.push(`${SRC + part} no longer ${what}: the part moved, so name where it is now`);
    }
    for (const [file, src] of sources) {
      if (parts.includes(file.slice(SRC.length)) || !found(src)) continue;
      if (!allowed.some(([f]) => SRC + f === file)) problems579.push(`${file} ${what}: draw the value with CopyField, or list it here with why`);
    }
    for (const [file] of allowed) {
      if (!found(sources.get(SRC + file) ?? '')) problems579.push(`${SRC + file} is listed as one that ${what}, and does not: remove it`);
    }
  }
  // The row CopyField replaced is written out nowhere else.
  for (const [file, src] of sources) {
    if (file.startsWith(COMPONENTS) && file !== `${COMPONENTS}common/CopyField.jsx` && src.includes('copy-field')) {
      problems579.push(`${file} writes CopyField's classes: draw a CopyField`);
    }
  }
  if (!read('frontend/README.md').replace(/\s+/g, ' ').includes(RULE_IN_README)) problems579.push(`frontend/README.md does not say: ${RULE_IN_README}`);

  if (problems579.length) {
    fail('A value to copy is drawn by hand (frontend/README.md, A value to copy):\n' + problems579.map((p) => `        ${p}`).join('\n'));
  } else {
    const exceptions = RULES.reduce((n, r) => n + r.allowed.length, 0);
    pass(`a value to copy is CopyField's, CopyBlock's, CopyableId's or ApplianceCommand's: none of the ${sources.size} dashboard sources copies another way or draws a read-only input, but for ${exceptions} listed with why`);
  }
}

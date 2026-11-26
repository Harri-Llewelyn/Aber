import { allFiles, fail, pass, read } from './lib.mjs';
import { dialogsIn, propAt, propText } from '../lib/jsx-dialogs.mjs';

// -------------------------------------------------------------------------------------------------
// 612. Every dialog's header is drawn one way, as frontend/README.md's *A dialog's header names its act*
// says. Each <Modal> and <ConfirmModal> under frontend/src/components has an icon, sized 18. Its title
// is the act in Title Case, written as text: the record it acts on is the `subject` prop, which Modal
// draws after a dash, so no title holds a name in `mono`, a dash, quotes or brackets of its own. An act
// in the README's table takes the table's icon. A <Modal> with acts of its own (a `footer`) has a `lead`
// saying what it will do; a ConfirmModal's message is its lead. It reads what is written: a title or an
// icon kept in a variable is not judged.
// -------------------------------------------------------------------------------------------------

const COMPONENTS = 'frontend/src/components/';
const FRAME = [`${COMPONENTS}common/Modal.jsx`, `${COMPONENTS}modals/ConfirmModal.jsx`];
const SIZE = 18;

/** The README's table: the act a title starts with, and its icon. */
const ACTS = [
  [/^Edit\b/, 'IconPencil'],
  [/^Archive\b/, 'IconArchive'],
  [/^(?:Remove|Delete|Permanently Delete)\b/, 'IconTrash'],
  [/^Restore\b/, 'IconRefreshCw'],
  [/^(?:New|Add|Register)\b/, 'IconPlus'],
  [/^Upload\b/, 'IconUpload'],
  [/^Export\b/, 'IconDownload'],
];

/** A title that starts with an act's word and is not that act: the file, the title and why. */
const NOT_THE_ACT = [
  ['modals/NewPasswordModal.jsx', 'New Password', 'the password Set a New Password made, shown once, with that act\'s lock'],
];

const RULE_IN_README = '### A dialog\'s header names its act';

/** The small words Title Case leaves alone inside a title, as dialogFooters.test.js has them. */
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'onto', 'or', 'the', 'to', 'up', 'with', 'instead']);
const inTitleCase = (text) => text.replace(/\([^)]*\)/g, '').replace(/\bv?\$\{\}/g, '').split(/\s+/)
  .filter((w) => /^[a-z]/.test(w) && !/[.\d]/.test(w)).every((w) => SMALL.has(w));

/** A title's words: its own text, or each string in its expression, with what it interpolates as `${}`. */
function titleWords(tag) {
  const text = propText(tag, 'title');
  if (!text) return [];
  if (tag[propAt(tag, 'title')] !== '{') return [text];
  return [...text.matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map((m) => (m[1] ?? m[2]).replace(/\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '${}'))
    .filter((w) => /[a-zA-Z]{2}/.test(w));
}

export default function check() {
  const problems612 = [];
  let seen = 0;
  let forms = 0;
  let named = 0;
  const used = new Set();
  const files = allFiles.filter((f) => f.startsWith(COMPONENTS) && f.endsWith('.jsx') && !FRAME.includes(f));

  for (const file of files) {
    const src = read(file).replace(/\r\n/g, '\n');
    for (const d of dialogsIn(src)) {
      const at = `${file}:${d.line}`;
      if (d.problem) { problems612.push(`${at}: ${d.problem}`); continue; }
      seen += 1;
      const { tag, kind } = d;

      // The icon, at the one size.
      const icon = propAt(tag, 'icon') === -1 ? '' : propText(tag, 'icon');
      if (!icon || icon === '{null}') problems612.push(`${at} has no icon: pass the act's, from the README's table`);
      for (const [, size] of icon.matchAll(/<\w+ size=\{(\d+)\}/g)) {
        if (Number(size) !== SIZE) problems612.push(`${at} draws its icon at ${size}px: a dialog's icon is ${SIZE}px`);
      }

      // The title: text, in Title Case, with the record left to `subject`.
      const title = propText(tag, 'title');
      if (/^\{\s*</.test(title)) problems612.push(`${at}'s title is JSX: write the act as text, and pass the record as subject`);
      if (propAt(tag, 'subject') !== -1) named += 1;
      for (const words of titleWords(tag)) {
        if (/[—“”"[\]]/.test(words)) problems612.push(`${at}'s title "${words}" writes a dash, quotes or brackets: pass the record as subject, which Modal draws`);
        if (!inTitleCase(words)) problems612.push(`${at}'s title "${words}" is not in Title Case`);
        const act = ACTS.find(([word]) => word.test(words));
        if (!act) continue;
        const listed = NOT_THE_ACT.find(([f, t]) => COMPONENTS + f === file && t === words);
        if (listed) { used.add(listed); continue; }
        if (!icon.includes(`<${act[1]} `)) problems612.push(`${at}'s title "${words}" is an act the README's table gives ${act[1]}, and its icon is ${icon || 'missing'}`);
      }

      // What it will do: the lead of a dialog with acts, a confirm's message.
      if (kind === 'ConfirmModal') {
        if (propAt(tag, 'message') === -1) problems612.push(`${at} has no message: a confirm's message is its lead`);
      } else if (propAt(tag, 'footer') !== -1) {
        forms += 1;
        const lead = propAt(tag, 'lead') === -1 ? '' : propText(tag, 'lead');
        if (!lead || lead === '{null}') problems612.push(`${at} has acts of its own and no lead: say in one sentence what it will do`);
      }
    }
  }

  for (const entry of NOT_THE_ACT) {
    if (!used.has(entry)) problems612.push(`${entry[0]} is listed for the title "${entry[1]}", and has no such title: remove it`);
  }
  const modal = read(FRAME[0]);
  if (!/\bsubject = null\b/.test(modal) || !modal.includes('modal-subject')) problems612.push(`${FRAME[0]} no longer draws \`subject\` after the title`);
  if (!read(FRAME[1]).includes('subject={subject}')) problems612.push(`${FRAME[1]} no longer hands \`subject\` to Modal`);
  if (seen < 60) problems612.push(`read only ${seen} dialogs: jsx-dialogs.mjs or the components moved`);
  if (!read('frontend/README.md').includes(`\n${RULE_IN_README}\n`)) problems612.push(`frontend/README.md has no section "${RULE_IN_README.slice(4)}"`);

  if (problems612.length) {
    fail('A dialog\'s header is drawn otherwise than frontend/README.md says (A dialog\'s header names its act):\n' +
      problems612.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${seen} dialogs each have an icon at ${SIZE}px and a title that is the act in Title Case, ${named} with the record as their subject; the ${forms} with acts of their own each have a lead`);
  }
}

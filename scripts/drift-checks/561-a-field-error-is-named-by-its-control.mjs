import { allFiles, fail, pass, read } from './lib.mjs';
import { propText, tagEnd } from '../lib/jsx-dialogs.mjs';

// -------------------------------------------------------------------------------------------------
// 561. A FieldError is named by the control it is about, so a screen reader that returns to the
// control reads it again. Every <FieldError> under frontend/src has an `id`, and a line of its file
// hands that id on: to fieldErrorProps(), to an aria-describedby, or to a component's errorId. The
// ones with no control to name them are listed with how many and why.
// -------------------------------------------------------------------------------------------------

const PART = 'frontend/src/components/common/FieldError.jsx';

/** The files whose FieldErrors have no control to name them: how many, and why. */
const UNNAMED = [
  ['frontend/src/components/common/CellPlacementPicker.jsx', 1, 'a place is clicked on the plan, which takes no focus'],
  ['frontend/src/components/common/TimeWindowControl.jsx', 2, 'a span or a range is aria-disabled, and its tooltip says the same'],
  ['frontend/src/components/modals/ApproveQuarantineModal.jsx', 1, 'why the device was held, under an id nobody types'],
];

const HANDS_ON = /fieldErrorProps\(|aria-describedby=|\berrorId=/;

export default function check() {
  const problems561 = [];
  let named = 0;
  const unnamed = new Map();
  const sources = allFiles
    .filter((f) => /^frontend\/src\/.*\.jsx$/.test(f) && !f.includes('/__tests__/') && f !== PART)
    .map((f) => [f, read(f).replace(/\r\n/g, '\n')])
    .filter(([, src]) => src.includes('<FieldError'));

  for (const [file, src] of sources) {
    for (let at = src.indexOf('<FieldError'); at !== -1; at = src.indexOf('<FieldError', at + 1)) {
      const end = tagEnd(src, at);
      const line = src.slice(0, at).split('\n').length;
      if (end === -1) { problems561.push(`${file}:${line}: could not read the end of the <FieldError> tag`); continue; }
      // A string's text, or an expression without its braces.
      const id = propText(src.slice(at, end + 1), 'id').replace(/^\{|\}$/g, '');
      if (!id) { unnamed.set(file, (unnamed.get(file) ?? 0) + 1); continue; }
      const rest = src.slice(0, at) + src.slice(end + 1);
      if (rest.split('\n').some((l) => HANDS_ON.test(l) && l.includes(id))) named += 1;
      else problems561.push(`${file}:${line}: no control names this FieldError's id (${id}): spread fieldErrorProps() on it, or give it an aria-describedby`);
    }
  }

  for (const [file, n] of unnamed) {
    const listed = UNNAMED.find(([f]) => f === file);
    if (!listed) problems561.push(`${file} draws ${n} FieldError(s) with no id: give each one, and its control the same, or list it here with why`);
    else if (listed[1] !== n) problems561.push(`${file} draws ${n} FieldError(s) with no id, and the list says ${listed[1]}: ${listed[2]}`);
  }
  for (const [file, n] of UNNAMED) {
    if (!unnamed.has(file)) problems561.push(`${file} is listed with ${n} FieldError(s) with no id, and has none: remove it from the list`);
  }
  if (!named) problems561.push('no source draws a <FieldError> with an id: the part moved, or was renamed');

  if (problems561.length) {
    fail('A FieldError is not named by its control:\n' + problems561.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${named} FieldErrors in ${sources.length} sources are each named by their control, but the ${UNNAMED.reduce((n, u) => n + u[1], 0)} listed with why none is`);
  }
}

import { allFiles, fail, pass, read } from './lib.mjs';
import { dialogsIn, propAt, propText, tagEnd } from '../lib/jsx-dialogs.mjs';

// -------------------------------------------------------------------------------------------------
// 578. A dialog's act is never disabled for what its form still needs: the press says it
// (hooks/useFormCheck.js), as frontend/README.md's *A dialog says why it cannot go ahead* says. Each
// primary or danger button in a source that holds a dialog is read: the whole file under
// components/modals, and in any other file what is inside a <Modal> or <ConfirmModal>. Its `disabled` may
// be what makes the dialog busy, or a typed gate. Any other is listed in HELD with why the person cannot
// act at all, which is then in view. A button is an <ActionButton> with no class or with btn-primary or
// btn-danger in it, or a <button> with one of them. `permitted` is the role's, and is not read. It does not
// see a button another component draws, or a class or an expression kept in a variable.
// -------------------------------------------------------------------------------------------------

const COMPONENTS = 'frontend/src/components/';

/** The dialogs left as they are, and why. A `disabled` in one is not read. */
const NOT_READ = {
  [`${COMPONENTS}modals/SchemaBuilderModal.jsx`]: 'rebuilt with the one schema editor',
  [`${COMPONENTS}modals/SchemaDetailModal.jsx`]: 'rebuilt with the one schema editor',
  [`${COMPONENTS}modals/SchemaForkModal.jsx`]: 'rebuilt with the one schema editor',
  [`${COMPONENTS}modals/DeviceNameplateModal.jsx`]: 'draws its own footer, under the same rule',
};

/** A typed gate's hold: useTypedGate()'s `open`, and the gateway dialogs' typed name. */
const TYPED = ['!gate.open', '!confirmed'];

/** What else holds an act: the file, the expression, and why nobody can act, which is in view. */
const HELD = [
  ['modals/TelemetryExportModal.jsx', 'Boolean(problem)', 'the window is too long, and is chosen on the page behind: said from the start'],
  ['modals/ApplyAutomationsModal.jsx', 'held', 'the file cannot be read or is refused, and is put right elsewhere: said from the start'],
  ['modals/ApplyDerivedMetricsModal.jsx', 'held', 'the file cannot be read or is refused, and is put right elsewhere: said from the start'],
  ['modals/ApplySchemasModal.jsx', 'held', 'the file cannot be read or is refused, and is put right elsewhere: said from the start'],
];

const RULE_IN_README = '**The primary is never disabled for what the form still needs.**';

/** The text of a prop without its braces. */
const inner = (text) => text.replace(/^\{|\}$/g, '').trim();

export default function check() {
  const problems578 = [];
  let acts = 0;
  let gated = 0;
  const used = new Set();
  const sources = allFiles
    .filter((f) => /^frontend\/src\/.*\.jsx$/.test(f) && !f.includes('/__tests__/') && f !== `${COMPONENTS}common/Modal.jsx`)
    .map((f) => [f, read(f).replace(/\r\n/g, '\n')]);

  for (const [file, src] of sources) {
    if (file in NOT_READ) continue;
    const here = dialogsIn(src).filter((d) => !d.problem);
    if (!here.length) continue;
    // What makes a dialog of this file busy. ConfirmModal's own source names it `pending`.
    const busy = new Set(here.map((d) => inner(propText(d.tag, 'busy'))).filter(Boolean));
    const spans = file.startsWith(`${COMPONENTS}modals/`) ? [[0, src.length]] : here.map((d) => [d.start, d.end]);
    for (const m of src.matchAll(/<(ActionButton|button)\b/g)) {
      if (!spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
      const tag = src.slice(m.index, tagEnd(src, m.index) + 1);
      const cls = propText(tag, 'className');
      const isAct = cls ? /btn-(?:primary|danger)\b/.test(cls) : m[1] === 'ActionButton';
      if (!isAct) continue;
      acts += 1;
      if (propAt(tag, 'disabled') === -1) continue;
      const why = inner(propText(tag, 'disabled'));
      if (busy.has(why)) continue;
      if (TYPED.includes(why)) { gated += 1; continue; }
      const listed = HELD.find(([f, e]) => COMPONENTS + f === file && e === why);
      if (listed) { used.add(listed); continue; }
      problems578.push(`${file}:${src.slice(0, m.index).split('\n').length} disables an act by {${why}}: press it through useFormCheck(), which says what is missing, or list it in HELD with why nobody can act`);
    }
  }

  for (const entry of HELD) {
    if (!used.has(entry)) problems578.push(`${entry[0]} is listed in HELD for {${entry[1]}}, and has no such act: remove it`);
  }
  if (!gated) problems578.push('no act is held by a typed gate: useTypedGate()\'s `open` was renamed, so name it here');
  if (!acts) problems578.push('no dialog holds an act: ActionButton moved, or was renamed');
  if (!read('frontend/README.md').replace(/\s+/g, ' ').includes(RULE_IN_README)) problems578.push(`frontend/README.md does not say: ${RULE_IN_README}`);

  if (problems578.length) {
    fail('A dialog\'s act is disabled for what its form still needs (frontend/README.md, A dialog says why it cannot go ahead):\n' +
      problems578.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`of the ${acts} acts in the dialogs, ${gated} are held by a typed gate and ${HELD.length} by what is in view; the rest are disabled only while their work runs`);
  }
}

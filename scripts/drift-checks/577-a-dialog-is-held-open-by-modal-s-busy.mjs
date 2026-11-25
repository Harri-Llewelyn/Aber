import { allFiles, fail, pass, read } from './lib.mjs';
import { dialogsIn, footersOf, propAt, propText, tagEnd } from '../lib/jsx-dialogs.mjs';

// -------------------------------------------------------------------------------------------------
// 577. A dialog whose work is running is held open by Modal's `busy`, as frontend/README.md's *A dialog is
// closed and confirmed one way* says, so no way out of it is locked while another is live. Each <Modal>
// and <ConfirmModal> under frontend/src is read from source. It fails on a no-op function anywhere in a
// source that holds a dialog, which is how one way out was locked; on a <Modal> whose act runs (a button
// of its footer has `pending`) and that passes no `busy`; and on a dismiss button drawn in a footer, which
// `busy` cannot hold. It does not see a no-op under a name another file gives it, an act among a dialog's
// children, or a footer another component returns.
// -------------------------------------------------------------------------------------------------

const COMPONENTS = 'frontend/src/components/';

/** The dialogs an act of which may end with the dialog closed, and why. */
const MAY_CLOSE = {
  [`${COMPONENTS}modals/ValidatePayloadModal.jsx`]: 'it changes nothing, so closing it while it checks loses nothing',
};

const NO_OP = /\(\)\s*=>\s*(?:\{\s*\}|undefined\b|null\b)/;
const RULE_IN_README = '**`Modal` holds itself open with `busy`.**';

export default function check() {
  const problems577 = [];
  let dialogs = 0;
  let held = 0;
  const sources = allFiles
    .filter((f) => /^frontend\/src\/.*\.jsx$/.test(f) && !f.includes('/__tests__/'))
    .map((f) => [f, read(f).replace(/\r\n/g, '\n')]);

  for (const [file, src] of sources) {
    const here = dialogsIn(src);
    if (!here.length) continue;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/[^\n]*/g, '$1');
    // A handler: named one, passed as one, or chosen between. A `.catch(() => {})` is not.
    const handlers = /\b(?:on[A-Z]\w*=\{|const \w*(?:[cC]lose|[cC]ancel|[dD]ismiss)\w* = )[^\n]*/g;
    for (const m of code.matchAll(handlers)) {
      if (!NO_OP.test(m[0])) continue;
      problems577.push(`${file}:${code.slice(0, m.index).split('\n').length} holds a way out with a no-op: pass busy to Modal, which holds every one`);
    }
    for (const d of here) {
      if (d.problem) { problems577.push(`${file}:${d.line}: ${d.problem}`); continue; }
      dialogs += 1;
      if (d.kind !== 'Modal') continue;
      const footers = footersOf(src, d.tag);
      for (const footer of footers) {
        if (/<button\b[^>]*onClick=\{(?:onClose|onCancel|\w*[cC]lose\w*|cancel|backOut)\}/.test(footer)) {
          problems577.push(`${file}:${d.line} draws its own dismiss button: pass dismiss="Cancel", "Close" or "Done" to Modal, which draws it and holds it`);
        }
      }
      const running = footers.flatMap((f) => [...f.matchAll(/<ActionButton\b/g)].map((m) => f.slice(m.index, tagEnd(f, m.index) + 1)))
        .filter((tag) => propAt(tag, 'pending') !== -1);
      if (!running.length || file in MAY_CLOSE) continue;
      if (propText(d.tag, 'busy')) held += 1;
      else problems577.push(`${file}:${d.line} has an act that runs and no busy: Escape and the × would close it meanwhile`);
    }
  }

  for (const file of Object.keys(MAY_CLOSE)) {
    if (!sources.some(([f, src]) => f === file && src.includes('<Modal'))) problems577.push(`${file} is listed as an exception, and holds no <Modal>`);
  }
  if (!held) problems577.push('no <Modal> passes busy: the prop moved, or was renamed');
  if (!read('frontend/README.md').replace(/\s+/g, ' ').includes(RULE_IN_README)) problems577.push(`frontend/README.md does not say: ${RULE_IN_README}`);

  if (problems577.length) {
    fail('A dialog is not held open by Modal\'s busy (frontend/README.md, A dialog is closed and confirmed one way):\n' +
      problems577.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${held} dialogs of ${dialogs} whose act runs are held open by Modal's busy, and no source that holds one locks a way out with a no-op`);
  }
}

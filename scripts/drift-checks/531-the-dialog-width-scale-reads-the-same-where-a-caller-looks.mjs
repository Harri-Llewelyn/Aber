import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 531. The dialog width scale says the same thing wherever a caller reads it. Each step's width is
// App.css's `max-width` for it, and its content is named in the same words in App.css (the comment
// above the step), Modal.jsx's `size`, frontend/README.md's *A dialog's width is named by its
// content* and, for the steps a confirm takes, ConfirmModal.jsx's `size`. App.css also gives no step
// but `full` a padding of its own, and hangs no rule on a step (`.modal-lg .x`): a rule written for
// one dialog goes on that dialog's own class, or it reaches every dialog that shares the step.
// -------------------------------------------------------------------------------------------------

/** What earns each step, in the words every place uses. */
const CONTENT = {
  sm: 'a question with no field',
  default: 'stacked form fields',
  md: 'a form with a list in it',
  lg: 'content rather than input',
  xl: 'two columns of fields',
  wide: 'a table',
};

/** The steps a confirm takes, as ConfirmModal's `size` lists them. */
const CONFIRM_STEPS = ['sm', 'default', 'md'];

export default function check() {
  const problems531 = [];
  const raw = read('frontend/src/App.css').replace(/\r\n/g, '\n');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const flat = (s) => s.replace(/\s+/g, ' ');

  // A step's width, and the comment straight above its rule.
  const stepRule = (step) => (step === 'default' ? '.modal' : `.modal-${step}`);
  const width = {};
  const said = {};
  for (const step of Object.keys(CONTENT)) {
    const head = `\n${stepRule(step)} {`;
    const at = raw.indexOf(head);
    if (at === -1) { problems531.push(`frontend/src/App.css has no "${stepRule(step)}" rule`); continue; }
    width[step] = Number(raw.slice(at, raw.indexOf('}', at)).match(/max-width:\s*(\d+)px/)?.[1]);
    if (!Number.isInteger(width[step])) problems531.push(`"${stepRule(step)}" in frontend/src/App.css sets no max-width in px`);
    const shut = raw.lastIndexOf('*/', at);
    const comment = shut !== -1 && !raw.slice(shut + 2, at).trim() ? raw.slice(raw.lastIndexOf('/*', shut), shut + 2) : '';
    said[step] = flat(comment).toLowerCase();
  }
  // The default step is the bare `.modal`; the scale's own comment names its content.
  const scale = flat(raw.match(/\/\* The modal width scale\.[\s\S]*?\*\//)?.[0] ?? '').toLowerCase();
  if (!scale) problems531.push('frontend/src/App.css has no comment starting "The modal width scale."');
  else if (Number.isInteger(width.default) && !scale.includes(`default step (${width.default}px), for ${CONTENT.default}`)) {
    problems531.push(`App.css's scale comment does not say the default step (${width.default}px) is "for ${CONTENT.default}"`);
  }
  for (const step of Object.keys(CONTENT).filter((s) => s !== 'default')) {
    if (said[step] !== undefined && !said[step].includes(CONTENT[step])) problems531.push(`App.css's comment above .modal-${step} does not name its content "${CONTENT[step]}"`);
  }

  // Modal.jsx's and ConfirmModal.jsx's `size`, and the README's section.
  const param = (file) => flat(read(file).match(/@param \{'sm'[^}]*\} \[size\]([\s\S]*?)\n \*\n/)?.[1] ?? '').replace(/ \* /g, ' ');
  const places = [
    ['frontend/src/components/common/Modal.jsx', param('frontend/src/components/common/Modal.jsx'), Object.keys(CONTENT), (s) => s],
    ['frontend/src/components/modals/ConfirmModal.jsx', param('frontend/src/components/modals/ConfirmModal.jsx'), CONFIRM_STEPS, (s) => s],
    ['frontend/README.md', flat(read('frontend/README.md').match(/\n### A dialog's width is named by its content\n([\s\S]*?)\n### /)?.[1] ?? ''),
      Object.keys(CONTENT), (s) => (s === 'default' ? 'the default' : `\`${s}\``)],
  ];
  for (const [file, text, steps, label] of places) {
    if (!text) { problems531.push(`${file} does not document the width scale where this check looks`); continue; }
    for (const step of steps) {
      if (!Number.isInteger(width[step])) continue;
      const phrase = `${label(step)} ${width[step]}px for ${CONTENT[step]}`;
      if (!text.includes(phrase)) problems531.push(`${file} does not say "${phrase}"`);
    }
  }

  // No step but full pads itself, and no rule hangs on a step.
  const steps = [...Object.keys(CONTENT).filter((s) => s !== 'default'), 'full'];
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of selectors.split(',').map((s) => s.trim())) {
      for (const step of steps) {
        const cls = `.modal-${step}`;
        if (selector === cls && step !== 'full' && /(^|[;\s])padding/.test(body)) problems531.push(`${cls} in frontend/src/App.css sets a padding of its own; every step but full uses .modal's`);
        if (selector.startsWith(`${cls} `) || selector.startsWith(`${cls}>`)) problems531.push(`"${selector}" in frontend/src/App.css hangs a rule on the ${step} step, so it reaches every dialog at that step`);
      }
    }
  }

  if (problems531.length) {
    fail('The dialog width scale reads otherwise in one place than another:\n' + problems531.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the dialog width scale (${Object.keys(CONTENT).map((s) => `${s} ${width[s]}px`).join(', ')}) names each step's content in the same words in App.css, Modal.jsx, ConfirmModal.jsx and frontend/README.md, and no rule pads or hangs on a step but full's padding`);
  }
}

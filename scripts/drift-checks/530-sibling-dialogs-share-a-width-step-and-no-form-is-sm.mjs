import { allFiles, fail, pass, read } from './lib.mjs';
import { dialogsIn, literalProp, propText } from '../lib/jsx-dialogs.mjs';

// -------------------------------------------------------------------------------------------------
// 530. A dialog opens at a step of App.css's width scale that its content earns, and sibling dialogs
// open at one step, as frontend/README.md's *A dialog's width is named by its content* says. Each
// <Modal> and <ConfirmModal> under frontend/src is read from source with its `size` (left out, a
// Modal is the default step and a ConfirmModal is sm). It fails when a step is not in Modal.jsx's
// SIZES, or names a class App.css lacks; when the members of a family below disagree or name their
// step by an expression; and when an sm dialog's own children hold a field: an input, a select, a
// textarea, or a *Field or *Picker component. A field drawn by another component inside them is not
// seen. A typed gate (ConfirmModal's `requireTyped`) is not in the children, and leaves a confirm sm.
// -------------------------------------------------------------------------------------------------

const COMPONENTS = 'frontend/src/components/';

/**
 * The families. A member is a file under components/ and, where the file holds other dialogs, text
 * its title contains. Every dialog a member matches must open at the family's one step.
 */
const FAMILIES = [
  ["an asset's create and edit form", [
    ['tabs/AreasTab.jsx', 'New Area'], ['tabs/CellsTab.jsx', 'New Cell'],
    ['tabs/GatewaysTab.jsx', 'Register Gateway'], ['tabs/DevicesTab.jsx', 'Register New Device'],
  ]],
  ['adding a metric', [['tabs/MetricsTab.jsx', 'Add Metric'], ['modals/AddDerivedMetricModal.jsx']]],
  ['bringing back an entity or a metric', [['modals/RestoreEntityModal.jsx'], ['modals/RestoreMetricModal.jsx']]],
  ['a secret shown once, and the steps before it', [
    ['modals/AddPersonModal.jsx'], ['modals/RegisterAppModal.jsx'], ['modals/NewPasswordModal.jsx'],
    ['modals/ServiceTokenModal.jsx'], ['modals/BrokerSubscriberModal.jsx'], ['modals/SigningKeyModal.jsx'],
    ['modals/GatewayCredentialModal.jsx'], ['modals/ShowGatewayCredentialModal.jsx'], ['modals/GatewayBundleModal.jsx'],
  ]],
  ["changing one of a person's details", [['modals/DisplayNameModal.jsx'], ['modals/ChangeEmailModal.jsx'], ['modals/ChangeRoleModal.jsx']]],
  ['exporting', [['modals/DeviceExportModal.jsx'], ['modals/TelemetryExportModal.jsx']]],
  ['applying a YAML file', [['modals/ApplySchemasModal.jsx'], ['modals/ApplyDerivedMetricsModal.jsx'], ['modals/ApplyAutomationsModal.jsx']]],
  ['an off-site destination', [['modals/BackupDestinationModal.jsx'], ['modals/ColdStorageDestinationModal.jsx']]],
  ['getting a capture', [['modals/StartCaptureModal.jsx'], ['modals/UploadCaptureModal.jsx']]],
];

const FIELD = /<(?:input|select|textarea)\b|<[A-Z]\w*(?:Field|Picker)\b/;

export default function check() {
  const problems530 = [];
  // The steps are Modal's SIZES, each a class App.css defines (`default` is the bare `.modal`).
  const css = read('frontend/src/App.css').replace(/\r\n/g, '\n');
  const sizes = read('frontend/src/components/common/Modal.jsx').match(/\nconst SIZES = \{([^}]*)\}/)?.[1] ?? '';
  const steps = new Set();
  for (const [, step, cls] of sizes.matchAll(/(\w+): '([\w-]*)'/g)) {
    if (cls && !css.includes(`\n.${cls} {`)) problems530.push(`Modal.jsx's SIZES names ${step} as .${cls}, which frontend/src/App.css does not define`);
    steps.add(step);
  }
  if (!steps.has('default') || steps.size < 2) problems530.push('could not read the steps, with `default`, from SIZES in frontend/src/components/common/Modal.jsx');

  const dialogs = [];
  const files = allFiles.filter((f) => f.startsWith('frontend/src/') && f.endsWith('.jsx') && !f.includes('/__tests__/'));
  for (const file of files) {
    for (const { kind, line, tag, body, problem } of dialogsIn(read(file).replace(/\r\n/g, '\n'))) {
      if (problem) { problems530.push(`${file}:${line}: ${problem}`); continue; }
      const size = literalProp(tag, 'size');
      const step = size === undefined ? (kind === 'Modal' ? 'default' : 'sm') : size;
      dialogs.push({ file, line, step, title: propText(tag, 'title'), body });
    }
  }

  for (const d of dialogs) {
    if (d.step !== null && !steps.has(d.step)) problems530.push(`${d.file}:${d.line}: size="${d.step}" is not a step of the scale (Modal.jsx's SIZES: ${[...steps].join(', ')})`);
  }

  for (const [family, members] of FAMILIES) {
    const found = [];
    for (const [path, title] of members) {
      const file = COMPONENTS + path;
      const matched = dialogs.filter((d) => d.file === file && (!title || d.title.includes(title)));
      if (!matched.length) problems530.push(`the family "${family}" names ${path}${title ? ` (${title})` : ''}, which holds no such dialog`);
      found.push(...matched);
    }
    const unread = found.filter((d) => d.step === null);
    for (const d of unread) problems530.push(`${d.file}:${d.line} is in the family "${family}" but names its step by an expression`);
    const named = new Set(found.filter((d) => d.step !== null).map((d) => d.step));
    if (named.size > 1) {
      problems530.push(`the family "${family}" opens at ${named.size} steps: ` +
        found.map((d) => `${d.file.slice(COMPONENTS.length)}:${d.line} ${d.step}`).join(', '));
    }
  }

  for (const d of dialogs.filter((x) => x.step === 'sm')) {
    const field = d.body.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').match(FIELD);
    if (field) problems530.push(`${d.file}:${d.line} is sm, the step for a question with no field, but holds ${field[0]}`);
  }

  if (problems530.length) {
    fail('A dialog opens at a step its content does not earn, or apart from its siblings (frontend/README.md, A dialog\'s width is named by its content):\n' +
      problems530.map((p) => `        ${p}`).join('\n'));
  } else {
    const count = {};
    for (const d of dialogs) count[d.step ?? 'set by an expression'] = (count[d.step ?? 'set by an expression'] || 0) + 1;
    const order = [...steps, 'set by an expression'].filter((s) => count[s]);
    pass(`${dialogs.length} dialogs open at a step of the scale (${order.map((s) => `${s} ${count[s]}`).join(', ')}); ` +
      `${FAMILIES.length} families each open at one step, and no sm dialog holds a field`);
  }
}

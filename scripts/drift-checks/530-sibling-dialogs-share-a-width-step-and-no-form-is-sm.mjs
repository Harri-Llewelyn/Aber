import { allFiles, fail, pass, read } from './lib.mjs';

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

/** The end of the string literal whose quote is at `i`, or `i` itself when the line holds no closing
 *  quote: then the quote is JSX text, such as an apostrophe. */
function stringEnd(src, i) {
  for (let j = i + 1; j < src.length && src[j] !== '\n'; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === src[i]) return j;
  }
  return i;
}

/**
 * Walks JSX source from `start`, skipping string and template literals and tracking braces, and
 * returns the first index where `stop(char, depth, index)` holds, or -1. Inside an expression, a
 * quote after a letter is JSX text (an apostrophe), as is one with no closing quote on its line.
 */
function walk(src, start, stop) {
  const stack = [];
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (stack[stack.length - 1] === '`') {
      if (c === '\\') j++;
      else if (c === '`') stack.pop();
      else if (c === '$' && src[j + 1] === '{') { stack.push('{'); j++; }
      continue;
    }
    if ((c === '"' || c === "'") && (!stack.length || !/\w/.test(src[j - 1]))) { j = stringEnd(src, j); continue; }
    if (c === '`' && stack.length) { stack.push('`'); continue; }
    if (c === '{') stack.push('{');
    else if (c === '}') stack.pop();
    if (stop(c, stack.length, j)) return j;
  }
  return -1;
}

/** The `>` that ends the JSX opening tag whose `<` is at `start`, or -1. */
const tagEnd = (src, start) => walk(src, start + 1, (c, depth) => c === '>' && depth === 0);

/** Where top-level prop `name` of an opening tag starts its value, or -1. */
function propAt(tag, name) {
  const at = walk(tag, 0, (c, depth, j) => depth === 0 && /\s/.test(c) && tag.startsWith(`${name}=`, j + 1));
  return at === -1 ? -1 : at + 1 + name.length + 1;
}

/** A prop's value as written: a string's text, or an expression with its braces. '' when absent. */
function propText(tag, name) {
  const at = propAt(tag, name);
  if (at === -1) return '';
  if (tag[at] === '{') return tag.slice(at, walk(tag, at, (c, depth) => c === '}' && depth === 0) + 1);
  return tag.slice(at + 1, stringEnd(tag, at));
}

/** A prop's literal string value, `undefined` when it is absent, or null for any other expression. */
function literalProp(tag, name) {
  if (propAt(tag, name) === -1) return undefined;
  const text = propText(tag, name);
  if (tag[propAt(tag, name)] !== '{') return text;
  return text.match(/^\{\s*(['"])(\w*)\1\s*\}$/)?.[2] ?? null;
}

/** The next `<kind` opening tag at or after `from` (not `<kindOther`), or -1. */
function nextOpening(src, kind, from) {
  for (let at = src.indexOf(`<${kind}`, from); at !== -1; at = src.indexOf(`<${kind}`, at + 1)) {
    if (!/\w/.test(src[at + kind.length + 1] ?? '')) return at;
  }
  return -1;
}

/** The text between an opening tag ending at `from` and its closing tag, for a `kind` element. */
function children(src, from, kind) {
  const close = `</${kind}>`;
  let depth = 1;
  let at = from;
  for (;;) {
    const shut = src.indexOf(close, at);
    if (shut === -1) return null;
    const nested = nextOpening(src, kind, at);
    if (nested !== -1 && nested < shut) {
      const end = tagEnd(src, nested);
      if (end !== -1 && src[end - 1] !== '/') depth++;
      at = end === -1 ? nested + 1 : end + 1;
      continue;
    }
    if (--depth === 0) return src.slice(from, shut);
    at = shut + close.length;
  }
}

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
    const src = read(file).replace(/\r\n/g, '\n');
    for (const m of src.matchAll(/<(Modal|ConfirmModal)\b/g)) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const lead = src.slice(lineStart, m.index).trim();
      if (lead.startsWith('*') || lead.startsWith('//')) continue;
      const line = src.slice(0, m.index).split('\n').length;
      const end = tagEnd(src, m.index);
      if (end === -1) { problems530.push(`${file}:${line}: could not read the <${m[1]}> opening tag`); continue; }
      const tag = src.slice(m.index, end + 1);
      const size = literalProp(tag, 'size');
      const step = size === undefined ? (m[1] === 'Modal' ? 'default' : 'sm') : size;
      const body = src[end - 1] === '/' ? '' : children(src, end + 1, m[1]);
      if (body === null) { problems530.push(`${file}:${line}: could not find the </${m[1]}> that closes this dialog`); continue; }
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

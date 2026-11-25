import { allFiles, fail, pass, read } from './lib.mjs';
import { dialogsIn, propAt, propText } from '../lib/jsx-dialogs.mjs';

// -------------------------------------------------------------------------------------------------
// 544. Typed text guards removing a person's access and every act that cannot be undone, as
// frontend/README.md's *Typed text guards removing access and what cannot be undone* says. Each
// <Modal> and <ConfirmModal> under frontend/src is read from source. A gate is a ConfirmModal's
// `requireTyped`, or a <TypedGate> among a Modal's children. It fails when a dialog in GATED has
// none, and when a dialog whose own words say the act cannot be taken back (WORDS) has none and is
// not in UNGATED with its reason. A dialog's words are its props, its children (less a dialog inside
// them) and the function its message calls. An act with no dialog, or whose dialog says nothing of
// the kind, is not seen. Whether the gate holds the button is typedGates.test.jsx's to show.
// -------------------------------------------------------------------------------------------------

const COMPONENTS = 'frontend/src/components/';

/** What a dialog says of an act that cannot be taken back. */
const WORDS = /\bcannot be (?:undone|recovered|restored)\b|\bfor good\b|\bpermanently\b|\bdestroy(?:s|ed)\b/i;

/** The gated dialogs: the file under components/, and text the dialog's title contains. */
const GATED = [
  ['tabs/PeopleSection.jsx', 'Remove Access for'],
  ['tabs/EntitiesTab.jsx', 'Permanently Delete'],
  ['tabs/SchemasTab.jsx', 'Discard Draft'],
  ['tabs/DevicesTab.jsx', 'Reject Device'],
  ['tabs/AutomationDetail.jsx', 'Delete Automation'],
  ['tabs/CaptureTab.jsx', 'Delete Capture'],
  ['modals/StartCaptureModal.jsx', 'Replace Capture'],
  ['modals/UploadCaptureModal.jsx', 'Upload Capture'],
];

/** The dialogs that use the words and take no gate, with why. */
const UNGATED = [
  ['modals/ServiceTokenInventoryModal.jsx', 'Tokens for', 'revoking a token must stay quick, and another can be issued'],
  ['modals/ServiceTokenInventoryModal.jsx', 'Revoke Token', 'revoking a token must stay quick, and another can be issued'],
  ['modals/ServiceTokenModal.jsx', 'Token for', 'the token is shown once; issuing one destroys nothing'],
  ['modals/SigningKeyModal.jsx', 'Signing Key', 'the key is shown once; rotating it must stay quick, and another can be issued'],
  ['modals/GatewayCredentialModal.jsx', 'Broker Credential for', "the password is shown once; the dialog asks for the gateway's name itself"],
  ['modals/SchemaForkModal.jsx', 'Create Version', 'what it keeps permanently is a description; nothing is destroyed'],
  ['modals/ColdStorageDestinationModal.jsx', 'Cold Storage Destination', 'with archiving off, the retention window drops the readings, not a click'],
  ['common/CredentialField.jsx', 'Replace the', 'nothing is overwritten until the dialog saves, and a key can be issued again where it came from'],
  ['tabs/DevicesTab.jsx', 'Edit Device Configuration', 'Enforce keeps later values out; it destroys nothing the site holds'],
  ['modals/ArchiveModal.jsx', 'Archive Entity', "Restore undoes an archive, and its timer's deletion is not a click"],
];

/** The text of JSX source: no comments, string joins or inline markup, and one space between words. */
const words = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1')
  .replace(/(['"`])\s*\+\s*(['"`])/g, '')
  .replace(/<\/?(?:strong|em|code|span)\b[^<>]*>/g, '')
  .replace(/\{' '\}/g, ' ')
  .replace(/\s+/g, ' ');

/** The source of each function called `name`, whichever file declares it: its block, or the lines up
 *  to a blank one when it has none. */
function declared(sources, name) {
  const found = [];
  for (const src of sources.values()) {
    for (const line of [`function ${name}(`, `const ${name} = (`]) {
      for (let at = src.indexOf(line); at !== -1; at = src.indexOf(line, at + 1)) {
        const start = src.lastIndexOf('\n', at) + 1;
        const block = src.slice(start, src.indexOf('\n', at)).endsWith('{');
        const stop = src.indexOf(block ? `\n${src.slice(start).match(/^ */)[0]}}` : '\n\n', at);
        found.push(src.slice(start, stop === -1 ? undefined : stop));
      }
    }
  }
  return found;
}

export default function check() {
  const problems544 = [];
  const sources = new Map(allFiles
    .filter((f) => /^frontend\/src\/.*\.jsx?$/.test(f) && !f.includes('/__tests__/'))
    .map((f) => [f, read(f).replace(/\r\n/g, '\n')]));

  const dialogs = [];
  for (const [file, src] of sources) {
    const here = dialogsIn(src);
    for (const d of here) {
      if (d.problem) { problems544.push(`${file}:${d.line}: ${d.problem}`); continue; }
      let own = src.slice(d.start, d.end);
      for (const inner of here) {
        if (!inner.problem && inner.start > d.start && inner.end <= d.end) own = own.replace(src.slice(inner.start, inner.end), ' ');
      }
      const called = [...`${propText(d.tag, 'message')} ${propText(d.tag, 'lead')}`.matchAll(/\b([a-z]\w*)\(/g)].map((m) => m[1]);
      const said = words([own, ...called.flatMap((name) => declared(sources, name))].join('\n'));
      dialogs.push({
        file,
        line: d.line,
        title: propText(d.tag, 'title'),
        gated: d.kind === 'ConfirmModal' ? propAt(d.tag, 'requireTyped') !== -1 : /<TypedGate\b/.test(d.body),
        says: said.match(WORDS)?.[0],
      });
    }
  }

  const named = ([path, title]) => {
    const matched = dialogs.filter((d) => d.file === COMPONENTS + path && d.title.includes(title));
    if (!matched.length) problems544.push(`${path} holds no dialog whose title says "${title}": it moved or was renamed, so name where it is now`);
    return matched;
  };

  for (const entry of GATED) {
    for (const d of named(entry).filter((x) => !x.gated)) problems544.push(`${d.file}:${d.line} ("${entry[1]}") has no typed gate: it removes a person's access, or cannot be undone`);
  }
  const excused = new Set();
  for (const entry of UNGATED) {
    for (const d of named(entry)) {
      excused.add(d);
      if (d.gated) problems544.push(`${d.file}:${d.line} ("${entry[1]}") has a typed gate, and is listed as having none`);
      else if (!d.says) problems544.push(`${d.file}:${d.line} ("${entry[1]}") is listed as having no typed gate, and no longer says it cannot be undone`);
    }
  }
  for (const d of dialogs.filter((x) => x.says && !x.gated && !excused.has(x))) {
    problems544.push(`${d.file}:${d.line} says "${d.says}" and has no typed gate: give it requireTyped (or a TypedGate), or list it in the check with the reason it has none`);
  }

  if (problems544.length) {
    fail('Typed text does not guard removing access and what cannot be undone (frontend/README.md, Typed text guards removing access and what cannot be undone):\n' +
      problems544.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${GATED.length} dialogs that remove a person's access or cannot be undone ask for typed text, and the ${UNGATED.length} others that say an act cannot be taken back are listed with why they ask for none`);
  }
}

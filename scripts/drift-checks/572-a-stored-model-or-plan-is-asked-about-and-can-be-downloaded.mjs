import { fail, pass, read } from './lib.mjs';
import { dialogsIn, propAt, propText } from '../lib/jsx-dialogs.mjs';

// -------------------------------------------------------------------------------------------------
// 572. A device's 3D model and an area's plan behave alike when the stored file is about to go. Each
// asks before Replace and before Remove in a plain ConfirmModal, whose message ends in the shared
// sentence of utils/storedFile.js, and each offers Download, Replace and Remove in that order, with
// Download outside the gate on the other two. The Devices and Areas help say both ask first and that
// every role can download, and frontend/README.md's typed-text rule says why neither takes typed text.
// That Replace uploads nothing until it is confirmed is storedFileReplacedWhenAsked.test.jsx's to show.
// -------------------------------------------------------------------------------------------------

const SUBJECTS = [
  {
    file: 'frontend/src/components/common/Model3DUploader.jsx',
    replace: 'Replace 3D model', remove: 'Remove 3D model',
    order: ['<IconDownload size={12} /> Download', '{canManage && (', '<IconUpload size={12} /> Replace', '<IconTrash size={12} /> Remove'],
    help: 'help/pages/devices.md', says: ['**Download** saves it, and every role can use it', 'Both ask first, so download the file before them'],
  },
  {
    file: 'frontend/src/components/common/AreaPlanPanel.jsx',
    replace: 'Replace area plan', remove: 'Remove area plan',
    order: ['<IconDownload size={13} /> Download plan', '{turnable && (', '<IconUpload size={13} /> Replace plan', '<IconTrash size={13} /> Remove plan'],
    help: 'help/pages/areas.md', says: ['**Download plan** saves the file as it was uploaded, and every role can use it', '**Replace plan** and **Remove plan** ask first, so download the plan before them'],
  },
];

const README = 'frontend/README.md';

export default function check() {
  const problems572 = [];
  const lf = (path) => read(path).replace(/\r\n/g, '\n');

  for (const { file, replace, remove, order, help, says } of SUBJECTS) {
    const src = lf(file);
    const confirms = dialogsIn(src).filter((d) => !d.problem && d.kind === 'ConfirmModal');
    for (const [title, sentence] of [[replace, 'STORED_FILE_REPLACED'], [remove, 'STORED_FILE_DELETED']]) {
      const dialog = confirms.find((d) => propText(d.tag, 'title').includes(title));
      if (!dialog) { problems572.push(`${file} holds no ConfirmModal titled "${title}"`); continue; }
      if (!propText(dialog.tag, 'message').includes(`\${${sentence}}`)) problems572.push(`${file}'s "${title}" does not say utils/storedFile.js's ${sentence}`);
      if (propAt(dialog.tag, 'requireTyped') !== -1) problems572.push(`${file}'s "${title}" asks for typed text, and ${README} says it does not`);
    }
    // Each piece is looked for after the one before it.
    let from = 0;
    for (const piece of order) from = from < 0 ? from : src.indexOf(piece, from);
    if (from < 0) problems572.push(`${file} does not draw Download, then, under its gate, Replace and Remove`);
    for (const phrase of says) {
      if (!lf(help).includes(phrase)) problems572.push(`${help} does not say "${phrase}"`);
    }
  }
  if (!lf(README).includes('- **A 3D model and an area plan take a plain confirm,** to replace and to remove.')) {
    problems572.push(`${README}'s typed-text rule does not say a 3D model and an area plan take a plain confirm`);
  }

  if (problems572.length) {
    fail('a stored 3D model and a stored area plan do not behave alike when the file is about to go:\n' + problems572.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('a stored 3D model and a stored area plan each ask before Replace and Remove in the same words, each offer Download to every role first, and the help and the typed-text rule say so');
  }
}

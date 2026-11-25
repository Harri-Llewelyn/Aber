import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 595. A person gives a file one way, as frontend/README.md's *A file is chosen with one drop zone*
// says: in a <DropZone> (common/DropZone.jsx), or, where a zone has no place, with a button on its
// useFilePicker(). Under frontend/src no other source draws a file input, makes one, opens the browser's
// file picker, or reads the files of a drop, except as listed here with why. A listing that no longer
// matches fails too. Every page that takes a file draws the zone, and the help names its one button as
// it does. Comments and tests are not read.
// -------------------------------------------------------------------------------------------------

const SRC = 'frontend/src/';
const ZONE = 'components/common/DropZone.jsx';

/** The pages that take a file, each of which draws the zone. */
const ZONES = [
  'components/modals/ImportVocabularyModal.jsx',
  'components/common/AreaPlanPanel.jsx',
  'components/common/Model3DUploader.jsx',
  'components/tabs/CaptureTab.jsx',
  'components/modals/UploadCaptureModal.jsx',
  'components/modals/ApplySchemasModal.jsx',
  'components/modals/ApplyAutomationsModal.jsx',
  'components/modals/DerivedMetricsEditorModal.jsx',
];

/** What each rule looks for, and the listed exceptions: the file and why. */
const RULES = [
  {
    what: 'draws or makes a file input',
    found: (src) => /\btype=\{?\s*["'`]file["'`]/.test(src) || /\.type\s*=\s*["'`]file["'`]/.test(src)
      || /setAttribute\(\s*["'`]type["'`]\s*,\s*["'`]file["'`]/.test(src) || /\btype:\s*["'`]file["'`]/.test(src),
    allowed: [],
  },
  {
    what: "opens the browser's file picker itself",
    found: (src) => /\bshowOpenFilePicker\b/.test(src),
    part: false,
    allowed: [],
  },
  {
    what: "reads the files of a drop",
    found: (src) => /\bdataTransfer\b[^\n]{0,20}\.(?:files|items)\b/.test(src),
    allowed: [
      ['components/tabs/CaptureTab.jsx', "a file dropped anywhere on the card opens Play a File…'s dialog with the file in it"],
    ],
  },
  {
    what: 'calls useFilePicker()',
    found: (src) => /\buseFilePicker\(/.test(src),
    allowed: [
      ['components/common/AreaPlanPanel.jsx', 'Replace Plan: the plan is drawn where a zone would be'],
      ['components/common/Model3DUploader.jsx', 'Replace: the model is drawn where a zone would be'],
      ['components/tabs/ProfileTab.jsx', 'Choose Picture: a zone makes its row taller than the others'],
    ],
  },
];

const RULE_IN_README = '**One component takes a file.**';
/** The button a zone that holds a file draws, and the help that names it. */
const AGAIN = 'Choose Another';
const HELP = ['help/pages/vocabulary.md', 'help/pages/schemas.md', 'help/pages/metrics.md', 'help/pages/automations.md', 'help/pages/capture.md'];

/** A source without its comments, each left as blank lines so a line number still holds. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

export default function check() {
  const problems595 = [];
  const sources = new Map(allFiles
    .filter((f) => /^frontend\/src\/.*\.jsx?$/.test(f) && !f.includes('/__tests__/') && !f.startsWith(`${SRC}test/`))
    .map((f) => [f.slice(SRC.length), code(read(f).replace(/\r\n/g, '\n'))]));
  const lineOf = (src, found) => src.split('\n').findIndex((line) => found(line)) + 1;

  for (const { what, found, part = true, allowed } of RULES) {
    if (part && !found(sources.get(ZONE) ?? '')) problems595.push(`${SRC}${ZONE} no longer ${what}: the part moved, so name where it is now`);
    for (const [file, src] of sources) {
      if (file === ZONE || !found(src) || allowed.some(([f]) => f === file)) continue;
      problems595.push(`${SRC}${file}:${lineOf(src, found)} ${what}: draw a DropZone, or list it here with why`);
    }
    for (const [file] of allowed) {
      if (!found(sources.get(file) ?? '')) problems595.push(`${SRC}${file} is listed as one that ${what}, and does not: remove it`);
    }
  }
  for (const file of ZONES) {
    if (!/<DropZone\b/.test(sources.get(file) ?? '')) problems595.push(`${SRC}${file} takes a file and draws no <DropZone>`);
  }
  for (const [file, src] of sources) {
    if (/<DropZone\b/.test(src) && !ZONES.includes(file)) problems595.push(`${SRC}${file} draws a <DropZone> and is not in this check's list of the pages that take a file`);
  }

  if (!read('frontend/README.md').replace(/\s+/g, ' ').includes(RULE_IN_README)) problems595.push(`frontend/README.md does not say: ${RULE_IN_README}`);
  if (!(sources.get(ZONE) ?? '').includes(`>${AGAIN}<`)) problems595.push(`${SRC}${ZONE} no longer draws ${AGAIN}, which the help names`);
  for (const page of HELP) {
    if (!read(page).includes(`**${AGAIN}**`)) problems595.push(`${page} does not name **${AGAIN}**`);
  }

  if (problems595.length) {
    fail('A file is chosen another way than with the drop zone (frontend/README.md, A file is chosen with one drop zone):\n' +
      problems595.map((p) => `        ${p}`).join('\n'));
  } else {
    const exceptions = RULES.reduce((n, r) => n + r.allowed.length, 0);
    pass(`a file is chosen in a DropZone on ${ZONES.length} pages, and by ${exceptions} listed with why: none of the other ${sources.size - 1} dashboard sources draws a file input, opens a picker or reads a drop's files`);
  }
}

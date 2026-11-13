import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 373. A unit is read as a symbol and exchanged as a code (frontend/README.md's rule of that name). The files
// that put a reading's unit before a person say it with utils/units.js, and the Add Metric dialog's
// Units list stays the codes it stores. The files that write data out never import it, so the CSV
// export, the AAS exports and the API keep the catalogue's code, which other programs read.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems373 = [];
  const READ_BY_A_PERSON = [
    'frontend/src/utils/history.js',
    'frontend/src/utils/automationEditorHelp.js',
    'frontend/src/components/tabs/HistoryTab.jsx',
    'frontend/src/components/tabs/MetricsTab.jsx',
  ];
  const LEAVES_ABER = [
    'frontend/src/api.js',
    'frontend/src/utils/telemetryExport.js',
    'frontend/src/utils/downloadCSV.js',
    'frontend/src/components/modals/TelemetryExportModal.jsx',
  ];
  const importsUnits = (src) => /^import [^;\n]* from '[^']*\/units(?:\.js)?'/m.test(src);
  for (const file of READ_BY_A_PERSON) {
    if (!importsUnits(read(file))) problems373.push(`${file} prints a unit to a person and does not import utils/units.js`);
  }
  for (const file of LEAVES_ABER) {
    if (importsUnits(read(file))) problems373.push(`${file} writes data out and imports utils/units.js: an export keeps the catalogue's code`);
  }
  if (!/<option key=\{u\} value=\{u\}>\{u\}<\/option>/.test(read('frontend/src/components/tabs/MetricsTab.jsx'))) {
    problems373.push("MetricsTab.jsx's Add Metric Units list no longer offers each code as it is stored");
  }
  const readme = read('frontend/README.md').replace(/\s+/g, ' ');
  for (const phrase of ['A unit is a symbol where it is read, and a code where it is exchanged', '`unitAndCode()`', '`unitSymbol()`']) {
    if (!readme.includes(phrase)) problems373.push(`frontend/README.md does not say "${phrase}"`);
  }
  if (problems373.length) {
    fail('a unit is not read as a symbol and exchanged as a code, as the README says:\n' + problems373.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`${READ_BY_A_PERSON.length} files print a unit as its symbol, ${LEAVES_ABER.length} files that write data out keep the code, and the Add Metric list stays the codes`);
  }
}

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 407. History's help shows a derived metric's comment row as the file writes it, and says what the
// dialog says of Raw. The example is the row derivedRows() writes for a rate of a counter, up to its
// ", computed from the 1-minute rollup", with the definition in the words the Derived tab uses; the
// dialog's Raw note says "1 minute", as the help does. A help page that quotes a row the file does not
// write sends a reader looking for it.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { derivationText } = await import(pathToFileURL(join(REPO, 'frontend/src/utils/derivedMetric.js')).href);
  const exportJs = read('frontend/src/utils/telemetryExport.js');
  const help = read('help/pages/history.md');
  const problems407 = [];
  const template = exportJs.match(/`# DERIVED: \$\{d\.metric\} = \$\{d\.definition\}, computed from the 1-minute rollup`/);
  if (!template) problems407.push('could not find the comment row derivedRows() writes in frontend/src/utils/telemetryExport.js');
  const example = `# DERIVED: Controller/PARTS_PER_HOUR = ${derivationText({ kind: 'counter_rate', input: 'Controller/PART_COUNT' })}`;
  if (template && !help.includes(`**${example}**`)) problems407.push(`help/pages/history.md does not show the comment row **${example}**`);
  if (!help.includes('With **Raw samples**, a derived metric comes at 1 minute')) {
    problems407.push('help/pages/history.md does not say a derived metric comes at 1 minute with **Raw samples**');
  }
  const note = exportJs.match(/export const DERIVED_RAW_NOTE = '([^']*)'/)?.[1];
  if (!note) problems407.push('could not find DERIVED_RAW_NOTE in frontend/src/utils/telemetryExport.js');
  else if (!/come at 1 minute/.test(note)) problems407.push("the dialog's DERIVED_RAW_NOTE does not say a derived metric comes at 1 minute");
  if (problems407.length) {
    fail("History's help shows a derived metric's export otherwise than the dialog and the file write it:\n" +
      problems407.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help shows the comment row **${example}** as derivedRows() writes it, and says a derived metric comes at 1 minute with Raw`);
  }
}

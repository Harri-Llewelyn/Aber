import { EXPORT_ENTRY_FILES, EXPORT_ENTRY_TABS, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 343. History's help names every tab that offers Export CSV, and no tab that does not. A tab offers
// it when its file under components/tabs imports TelemetryExportModal; the help's step 1 of
// *Exporting readings* says what each saves, as "On Overview, ..." or "On the Cell tab, ...". A tab
// the help leaves out is one whose button a reader does not know to look for; a tab it names that has
// none sends them looking for a button that is not there. A file outside History's tabs that opens
// the dialog is not one this check can name, so it fails until the check is taught it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems343 = [];
  for (const f of EXPORT_ENTRY_FILES) {
    if (!/^frontend\/src\/components\/tabs\/History[A-Za-z]+\.jsx$/.test(f)) problems343.push(`${f} opens the export dialog and is not a History tab, so this check cannot name it`);
  }
  const step = read('help/pages/history.md').match(/\n1\. Choose what to export\.([^\n]*)\n/)?.[1];
  if (!step) {
    problems343.push('help/pages/history.md has no "1. Choose what to export." step under Exporting readings');
  } else {
    const named = new Set([...step.matchAll(/\bOn the ([A-Z][a-z]+) tab\b/g)].map((m) => m[1]));
    if (/\bOn Overview\b/.test(step)) named.add('Overview');
    for (const tab of EXPORT_ENTRY_TABS) if (!named.has(tab)) problems343.push(`help/pages/history.md's step 1 does not say what the ${tab} tab exports ("On ${tab === 'Overview' ? 'Overview' : `the ${tab} tab`},")`);
    for (const tab of named) if (!EXPORT_ENTRY_TABS.includes(tab)) problems343.push(`help/pages/history.md's step 1 names the ${tab} tab, which does not open the export dialog`);
  }
  if (problems343.length) {
    fail('History\'s help names the tabs that offer Export CSV otherwise than the code does:\n' + problems343.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`History's help says what Export CSV saves on each of the ${EXPORT_ENTRY_TABS.length} tabs that offer it: ${EXPORT_ENTRY_TABS.join(', ')}`);
  }
}

import { EXPORT_ENTRY_TABS, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 344. frontend/README.md's *History's Export* counts the places that export and names each, as the
// code has them: one bullet with "The Device tab:", "Overview:", "The Cell tab:" and so on for every
// tab that imports TelemetryExportModal (check 343's list), under "from <number> places". A sixth
// entry point the section does not mention is one whose rules nobody checked against the other five.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems344 = [];
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const section = read('frontend/README.md').match(/\n### History's Export\n([\s\S]*?)\n### /)?.[1];
  if (!section) {
    problems344.push('frontend/README.md has no "History\'s Export" section');
  } else {
    const flat = section.replace(/\s+/g, ' ');
    const count = EXPORT_ENTRY_TABS.length;
    if (!flat.includes(`from ${words[count] ?? count} places`)) problems344.push(`frontend/README.md's History's Export does not say "from ${words[count] ?? count} places"`);
    for (const tab of EXPORT_ENTRY_TABS) {
      const label = tab === 'Overview' ? '**Overview:**' : `**The ${tab} tab:**`;
      if (!flat.includes(label)) problems344.push(`frontend/README.md's History's Export does not name ${label}`);
    }
  }
  if (problems344.length) {
    fail('frontend/README.md\'s History\'s Export lists the export\'s entry points otherwise than the code has them:\n' + problems344.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`frontend/README.md's History's Export counts and names the ${EXPORT_ENTRY_TABS.length} entry points to the export dialog`);
  }
}

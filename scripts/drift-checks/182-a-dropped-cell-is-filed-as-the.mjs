import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 182. A dropped cell is filed as the Areas help says. A drop asks first: fileCell() writes
// nothing, and the dialog's confirm buttons are Move Cell and Unfile Cell, which the help names.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const PAGE = 'frontend/src/components/tabs/AreasTab.jsx';
  const HELP = 'help/pages/areas.md';
  const offences = [];

  const page = read(PAGE);
  const help = read(HELP);
  const fileCell = /const fileCell = [^\n]*\n([\s\S]*?)\n {2}\}\n/.exec(page);
  if (!fileCell) offences.push(`${PAGE} has no fileCell() where this check reads it`);
  else if (/\bapi\./.test(fileCell[1])) offences.push(`${PAGE}'s fileCell() writes at the drop, before anybody is asked`);
  for (const label of ['Move Cell', 'Unfile Cell']) {
    if (!page.includes(`'${label}'`)) offences.push(`${PAGE} has no dialog button labelled ${label}`);
    if (!help.includes(`**${label}**`)) offences.push(`${HELP} does not name **${label}**`);
  }

  if (offences.length) {
    fail(`A dropped cell is filed as the Areas help says:\n  ${offences.join('\n  ')}`);
  } else {
    pass(`A dropped cell is filed as the Areas help says: fileCell() only asks, and the help names Move Cell and Unfile Cell`);
  }
}

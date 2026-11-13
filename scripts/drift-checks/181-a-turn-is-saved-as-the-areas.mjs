import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 181. A turn is saved as the Areas help says. The panel offers Save Turn through the shared
// SaveDiscard pair, whose other button is Discard, and the help names both. The panel writes the
// turn only through setAreaPlanRotation(), called once, from Save Turn.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const PANEL = 'frontend/src/components/common/AreaPlanPanel.jsx';
  const PAIR = 'frontend/src/components/common/SaveDiscard.jsx';
  const HELP = 'help/pages/areas.md';
  const offences = [];

  const panel = read(PANEL);
  const help = read(HELP);
  if (!/<SaveDiscard\b[^>]*\bsaveLabel="Save Turn"/.test(panel)) offences.push(`${PANEL} no longer offers Save Turn through SaveDiscard`);
  if (!read(PAIR).includes('/> Discard\n')) offences.push(`${PAIR} has no button labelled Discard`);
  for (const label of ['Save Turn', 'Discard']) {
    if (!help.includes(`**${label}**`)) offences.push(`${HELP} does not name **${label}**`);
  }
  if ((panel.match(/api\.setAreaPlanRotation\(/g) || []).length !== 1) offences.push(`${PANEL} should call api.setAreaPlanRotation() in one place, Save Turn`);

  if (offences.length) {
    fail(`A turn is saved as the Areas help says:\n  ${offences.join('\n  ')}`);
  } else {
    pass(`A turn is saved as the Areas help says: the panel offers Save Turn and Discard through SaveDiscard, the help names both, and the panel writes the turn in one place`);
  }
}

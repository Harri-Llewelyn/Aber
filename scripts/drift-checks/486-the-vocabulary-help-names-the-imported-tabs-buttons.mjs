import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 486. The Vocabulary help names the Imported tab's controls as the dashboard draws them (0306): each
// button and radio the help tells the reader to press is a label in the components, and the confirm
// of the Import dialog repeats the action's name, as the dialogs' rule asks. Help that says "press
// Share definitions" over a button that reads "Share" sends a reader looking for what is not there.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems486 = [];
  const help = read('help/pages/vocabulary.md');
  const panel = read('frontend/src/components/common/SiteVocabularyPanel.jsx');
  const modal = read('frontend/src/components/modals/ImportVocabularyModal.jsx');
  const section = help.slice(help.indexOf('## The Imported tab'), help.indexOf('## Why this is a separate page'));
  if (!section.startsWith('## The Imported tab')) {
    fail('486: help/pages/vocabulary.md has no "The Imported tab" section -- the file\'s shape changed, so this check is no longer checking anything');
    return;
  }

  // Each control the help asks for, in bold, and the file that draws it.
  for (const [label, source, where] of [
    ['Import vocabulary', panel, 'the toolbar'],
    ['Import vocabulary', modal, 'the dialog\'s confirm'],
    ['Share definitions', panel, 'the table and the confirmation'],
    ['Stop sharing', panel, 'the table'],
    ['Remove', panel, 'the table'],
    ['A published standard', modal, 'the dialog'],
    ['The site\'s own vocabulary', modal, 'the dialog'],
  ]) {
    if (!section.includes(`**${label}**`)) problems486.push(`the help does not name **${label}**`);
    if (!source.includes(label)) problems486.push(`${where} does not draw "${label}", which the help names`);
  }
  // The dialog's confirm is the act's name, and filled.
  if (!/confirmLabel="Remove vocabulary"/.test(panel)) problems486.push('the removal\'s confirm does not repeat the action as "Remove vocabulary"');
  if (!/confirmLabel="Share definitions"[\s\S]*?confirmClassName="btn btn-primary"/.test(panel)) problems486.push('the sharing confirmation is not the action\'s name on a btn-primary');
  if (!/className="btn btn-primary"[\s\S]{0,200}Import vocabulary\n\s*<\/ActionButton>/.test(modal)) problems486.push('the Import dialog\'s confirm is not "Import vocabulary" on a btn-primary');
  // The tab's name is the page's own.
  if (!section.includes('**Imported** tab')) problems486.push('the help does not name the **Imported** tab');
  if (!/label: 'Imported'/.test(panel)) problems486.push('the panel does not draw the tab as Imported');

  if (problems486.length) {
    fail(`the Vocabulary help and the Imported tab's controls disagree:\n${problems486.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('the Vocabulary help names the Imported tab and its controls as the dashboard draws them, and the dialogs\' confirms repeat the action');
  }
}

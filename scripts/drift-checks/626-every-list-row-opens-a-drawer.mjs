import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 626. Metrics › Uncatalogued and Vocabulary › Imported open a drawer from each row, as every list's rows
// do, so a column a narrow card hides is still in view, and the help and the README say so. Each row is
// a selectable row in the address (`?declared=`, `?file=`); its acts are in the drawer and not the row;
// the Imported drawer is drawn beside the card, through the page's drawer host.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems626 = [];
  const flat = (text) => text.replace(/\s+/g, ' ');
  const metrics = flat(read('frontend/src/components/tabs/MetricsTab.jsx'));
  const imported = flat(read('frontend/src/components/common/SiteVocabularyPanel.jsx'));
  const vocabulary = flat(read('frontend/src/components/tabs/VocabularyTab.jsx'));
  const readme = flat(read('frontend/README.md'));
  const metricsHelp = flat(read('help/pages/metrics.md'));
  const vocabularyHelp = flat(read('help/pages/vocabulary.md'));

  // Uncatalogued: the row selects its name, and the drawer holds Catalogue.
  if (!metrics.includes("useUrlState('declared'") || !metrics.includes('onClick={rowSelectHandler(() => selectDeclared(u))}')) {
    problems626.push("MetricsTab.jsx's Uncatalogued rows do not open a drawer by ?declared=");
  }
  const drawer = metrics.slice(metrics.indexOf('function UncataloguedDrawer('), metrics.indexOf('export function MetricsTab('));
  if (!drawer.includes('<ContextPanel') || !drawer.includes("label: 'Catalogue'")) {
    problems626.push("MetricsTab.jsx's UncataloguedDrawer is not a ContextPanel with Catalogue");
  }
  if (metrics.includes('onClick={() => handleCatalogue(u)}')) problems626.push("an Uncatalogued row still has a Catalogue of its own");

  // Imported: the row selects its file, the acts are the drawer's, and the drawer is beside the card.
  const body = imported.slice(imported.indexOf('<tbody>'), imported.indexOf('</tbody>'));
  if (!body.includes('onClick={rowSelectHandler(() => selectFile(file))}')) problems626.push("SiteVocabularyPanel.jsx's rows do not open a drawer by ?file=");
  if (body.includes('<ActionButton')) problems626.push("an Imported row still has buttons of its own");
  for (const act of ["label: 'Show Concepts'", "label: 'Share Definitions'", "label: 'Stop Sharing'", "label: 'Remove'"]) {
    if (!imported.includes(act)) problems626.push(`the Imported drawer has no ${act}`);
  }
  if (!imported.includes('{drawerHost ? createPortal(drawer, drawerHost) : drawer}')
    || !vocabulary.includes('siteVocabularyTab({ canManage: canUse, onUseEntry, showToast, drawerHost })')) {
    problems626.push("the Imported drawer is not drawn into VocabularyTab.jsx's drawer host, beside the card");
  }

  // The docs: no "no drawer" left, and each help page says how a row opens.
  if (readme.includes('Uncatalogued and Imported rows have no drawer')) problems626.push('frontend/README.md still says Uncatalogued and Imported rows have no drawer');
  if (metricsHelp.includes('Its rows have no details panel')) problems626.push('help/pages/metrics.md still says the Uncatalogued rows have no details panel');
  if (!metricsHelp.includes('**Catalogue**, in the panel,')) problems626.push('help/pages/metrics.md does not say Catalogue is in the panel');
  if (!vocabularyHelp.includes("Select a file's row to open its details panel.")) problems626.push("help/pages/vocabulary.md does not say a file's row opens its panel");

  if (problems626.length) {
    fail(`An Uncatalogued or Imported row does not open a drawer as the docs say:\n${problems626.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('Metrics › Uncatalogued and Vocabulary › Imported open a drawer from each row, with the acts in it, as the help and the README say');
  }
}

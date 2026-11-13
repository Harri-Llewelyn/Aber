import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 365. The Devices drawer offers the 3D model as one action, after View History, and the help names
// it as the drawer does. The label follows the model: View 3D Model with one attached, Add 3D
// Model… with none. The drawer keeps no 3D Model section, so no Model3DLabel and no beforeActions.
// The dialog it opens draws Download, Replace, Remove and a Public marker, and the viewer Reset
// view; devices.md names each.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const tab = read('frontend/src/components/tabs/DevicesTab.jsx');
  const dialog = read('frontend/src/components/common/Model3DUploader.jsx');
  const viewer = read('frontend/src/components/common/Model3DViewer.jsx');
  const help = read('help/pages/devices.md');
  const problems365 = [];
  const after = tab.match(/label: 'View History', icon: <\w+ size=\{13\} \/>,\s*to: deviceHistoryUrl\([^)]*\),\s*title: [^\n]+\n\s*\},\s*(?:\/\*[\s\S]*?\*\/\s*)?\{\s*label: [^\n]*'View 3D Model'[^\n]*'Add 3D Model…'/);
  if (!after) problems365.push("DevicesTab.jsx has no action right after View History whose label is 'View 3D Model' with a model and 'Add 3D Model…' without one");
  if (/Model3DLabel|model-section|beforeActions=/.test(tab)) problems365.push('DevicesTab.jsx still draws a 3D Model section in the drawer (Model3DLabel, model-section or beforeActions)');
  for (const word of ['Download', 'Replace', 'Remove', 'Public']) {
    if (!dialog.includes(` ${word}`)) problems365.push(`Model3DUploader.jsx no longer draws "${word}"`);
    if (!help.includes(`**${word}**`)) problems365.push(`help/pages/devices.md does not name **${word}**`);
  }
  if (!viewer.includes('Reset view')) problems365.push('Model3DViewer.jsx no longer draws "Reset view"');
  for (const label of ['View 3D Model', 'Add 3D Model…', 'Reset view']) {
    if (!help.includes(`**${label}**`)) problems365.push(`help/pages/devices.md does not name **${label}**`);
  }
  if (!/\*\*View 3D Model\*\*[^\n]*after \*\*View History\*\*/.test(help)) problems365.push('help/pages/devices.md does not say View 3D Model sits after View History');
  if (/\*\*Expand\*\*/.test(help.slice(help.indexOf('**View 3D Model**'), help.indexOf('**Suppression windows**')))) {
    problems365.push('help/pages/devices.md still sends a reader to an Expand button for the model, which the drawer no longer has');
  }
  if (problems365.length) {
    fail('the Devices drawer\'s 3D model action and its help disagree:\n' + problems365.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the Devices drawer has one 3D model action after View History, View 3D Model or Add 3D Model…, and the help names it and the view\'s Download, Replace, Remove, Public and Reset view');
  }
}

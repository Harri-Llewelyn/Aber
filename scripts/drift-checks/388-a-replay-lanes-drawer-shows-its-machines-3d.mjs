import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 388. A replay lane's drawer shows its machine's 3D model, read-only, and never its own. DevicesTab
// reads the model from the lane's machine, withholds the action from a lane whose machine has none,
// and hands the dialog that machine as modelOf. The dialog then reads the machine's path, is
// read-only, draws no file picker, and names the machine in place of the Public marker. The Devices
// and Capture help say a lane has no model of its own, and the Devices help says what the view lacks.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const tab = read('frontend/src/components/tabs/DevicesTab.jsx');
  const dialog = read('frontend/src/components/common/Model3DUploader.jsx');
  const devices = read('help/pages/devices.md');
  const capture = read('help/pages/capture.md');
  const problems388 = [];
  if (!/const modelPath = \(selectedDevice\?\.shadow_of \? laneMachine : selectedDevice\)\?\.model_3d_path/.test(tab)) {
    problems388.push("DevicesTab.jsx does not read a lane's model from its machine (laneMachine) and a device's from itself");
  }
  if (!/const laneMachine = selectedDevice\?\.shadow_of\s*\?\s*assets\.find\(a => a\.asset_id === selectedDevice\.shadow_of\)/.test(tab)) {
    problems388.push("DevicesTab.jsx does not find a lane's machine by its shadow_of");
  }
  if (!/\(!selectedDevice\.shadow_of \|\| modelPath\) && \{\s*label: modelPath \? 'View 3D Model' : 'Add 3D Model…'/.test(tab)) {
    problems388.push("DevicesTab.jsx does not withhold the 3D model action from a lane whose machine has no model, which would otherwise read Add 3D Model…");
  }
  if (!/<Model3DUploader[^>]*\bmodelOf=\{laneMachine\}/.test(tab)) problems388.push("DevicesTab.jsx does not hand the model dialog the lane's machine as modelOf");
  if (!dialog.includes('const canManage = mayManage && !modelOf')) problems388.push("Model3DUploader.jsx lets a person change a model that is another device's");
  if (!dialog.includes('const path = (modelOf || device)?.model_3d_path')) problems388.push("Model3DUploader.jsx does not read another device's path when it is given modelOf");
  if (!dialog.includes('{!modelOf && replace.picker}')) problems388.push("Model3DUploader.jsx draws its file picker for another device's model");
  if (!dialog.includes("'s model`")) problems388.push("Model3DUploader.jsx does not say whose model it shows");
  const lane = devices.match(/- \*\*A replay lane has no 3D model of its own\.\*\*[^\n]*/)?.[0] ?? '';
  if (!lane) problems388.push('help/pages/devices.md has no bullet "A replay lane has no 3D model of its own."');
  for (const word of ['**View 3D Model**', '**Download**', '**Reset view**', '**Replace**', '**Remove**', '**Public**', '**Add 3D Model…**']) {
    if (lane && !lane.includes(word)) problems388.push(`help/pages/devices.md's replay lane bullet does not name ${word}`);
  }
  if (!capture.includes('**A replay lane has no 3D model of its own.**')) problems388.push('help/pages/capture.md has no bullet "A replay lane has no 3D model of its own."');
  if (problems388.length) {
    fail("a replay lane's drawer, its model dialog and the help say its 3D model differently:\n" + problems388.map((p) => `        ${p}`).join('\n'));
  } else {
    pass("a replay lane's drawer reads its machine's 3D model through modelOf, offers View and never Add, and the dialog is read-only, as the Devices and Capture help say");
  }
}

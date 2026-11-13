import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 367. The help says who may do what with a 3D model as the code gates it. Viewing and Download are
// open to every role; Add 3D Model…, Replace and Remove need device:manage. The drawer greys Add
// out with requiresRolesTitle(DEVICE_MANAGE) (and for an archived device, which cannot take one),
// and the dialog draws Replace and Remove only under canManage, with Download outside it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const tab = read('frontend/src/components/tabs/DevicesTab.jsx');
  const dialog = read('frontend/src/components/common/Model3DUploader.jsx');
  const help = read('help/pages/devices.md');
  const problems367 = [];
  if (!/disabled: !selectedDevice\.model_3d_path && \(!canManage \|\| selectedDevice\.is_archived\)/.test(tab)) {
    problems367.push('DevicesTab.jsx does not grey Add 3D Model… out for a role that may not manage devices or for an archived device, and only then');
  }
  if (!/requiresRolesTitle\(PERMISSION_UUIDS\.DEVICE_MANAGE\)[\s\S]{0,200}Restore this device to attach a 3D model/.test(tab)) {
    problems367.push("DevicesTab.jsx's Add 3D Model… does not name the roles, then the restore, as its reasons");
  }
  if (!/canManage=\{canManage && !selectedDevice\.is_archived\}/.test(tab.slice(tab.indexOf('<Model3DUploader')))) {
    problems367.push('DevicesTab.jsx hands the dialog canManage without the archived check');
  }
  const download = dialog.indexOf('<IconDownload size={12} /> Download');
  const gate = dialog.indexOf('{canManage && (');
  const replace = dialog.indexOf('<IconUpload size={12} /> Replace');
  if (download < 0 || gate < 0 || replace < 0 || !(download < gate && gate < replace)) {
    problems367.push('Model3DUploader.jsx does not draw Download before, and outside, the canManage gate that holds Replace and Remove');
  }
  const bullet = help.slice(help.indexOf('**The 3D model\'s file**'), help.indexOf('**Add 3D Model…**'));
  for (const phrase of ['**Download** saves it, and every role can use it', '**Replace** and **Remove** need permission to manage devices', '**Remove** asks first']) {
    if (!bullet.includes(phrase)) problems367.push(`help/pages/devices.md's 3D model file bullet does not say "${phrase}"`);
  }
  const add = help.slice(help.indexOf('**Add 3D Model…**'), help.indexOf('**Who can open a model.**'));
  for (const phrase of ['It needs permission to manage devices', 'greyed out', 'An archived device cannot take a new model']) {
    if (!add.includes(phrase)) problems367.push(`help/pages/devices.md's Add 3D Model… bullet does not say "${phrase}"`);
  }
  if (problems367.length) {
    fail('the 3D model\'s gating and the help disagree:\n' + problems367.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the help says Download and viewing are open to every role, and Add 3D Model…, Replace and Remove need device:manage, as the drawer and the dialog gate them');
  }
}

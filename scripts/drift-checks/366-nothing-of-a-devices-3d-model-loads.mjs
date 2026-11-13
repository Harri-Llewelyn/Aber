import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 366. Nothing of a device's 3D model loads until its dialog is opened. DevicesTab mounts the
// dialog only while modelOpen is set; Model3DViewer is the one file that imports @google/model-viewer
// and only through import(); the viewer is imported by the dialog alone and does not auto-rotate;
// and the README and the help both say so.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const src = allFiles.filter((f) => /^frontend\/src\/.*\.jsx?$/.test(f) && !/^frontend\/src\/(__tests__|test)\//.test(f));
  const tab = read('frontend/src/components/tabs/DevicesTab.jsx');
  const viewer = read('frontend/src/components/common/Model3DViewer.jsx');
  const problems366 = [];
  if (!/\{modelOpen && selectedDevice && \(\s*<Model3DUploader/.test(tab)) problems366.push('DevicesTab.jsx does not mount Model3DUploader only while modelOpen is set');
  const viewerImports = [];
  const moduleImports = [];
  for (const f of src) {
    const text = read(f);
    if (/(?:from|import)\s+['"]@google\/model-viewer['"]/.test(text)) moduleImports.push(f);
    if (/from\s+['"][./]*(?:components\/)?(?:common\/)?Model3DViewer['"]/.test(text)) viewerImports.push(f);
  }
  if (moduleImports.length) problems366.push(`${moduleImports.join(', ')} import @google/model-viewer statically, so the viewer loads with the page`);
  if (!viewer.includes("import('@google/model-viewer')")) problems366.push("Model3DViewer.jsx does not load @google/model-viewer with import()");
  if (viewerImports.some((f) => f !== 'frontend/src/components/common/Model3DUploader.jsx')) {
    problems366.push(`${viewerImports.filter((f) => f !== 'frontend/src/components/common/Model3DUploader.jsx').join(', ')} import Model3DViewer, which only the 3D model dialog may`);
  }
  if (/auto-rotate/.test(viewer)) problems366.push('Model3DViewer.jsx turns the model by itself, so it keeps drawing in an open dialog');
  const readme = read('frontend/README.md');
  if (!readme.includes("### A device's 3D model opens on request")) problems366.push("frontend/README.md has no \"A device's 3D model opens on request\" section");
  if (!readme.includes('**Nothing loads until it is asked for.**')) problems366.push('frontend/README.md does not say nothing of the model loads until it is asked for');
  if (!read('help/pages/devices.md').includes('Nothing of the model loads until you open the view')) problems366.push('help/pages/devices.md does not say nothing of the model loads until the view is opened');
  if (problems366.length) {
    fail('the 3D model loads before it is asked for, or the docs say otherwise:\n' + problems366.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the 3D model\'s dialog is mounted only while open, @google/model-viewer is imported only through import() in the one viewer, and the README and the help say so');
  }
}

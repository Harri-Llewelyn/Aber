import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 392. A value nobody can change is a label, and a catalog metric is chosen from MetricPicker.
// The places that drew a fixed value as a greyed input (a Settings row, a nameplate value the
// device publishes, Cold Storage's site key, Add Metric's Units, and a Settings row for a role that
// may not change it) draw text, as do a replay lane's Serving Gateway and a Digital Nameplate for a
// role that may neither edit nor propose. Deprecate Metric and a draft schema choose a metric from
// the list the schema builder uses, and frontend/README.md states the rule beside the dialog rules.
// The Settings help no longer describes a greyed field.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems392 = [];
  const files = {
    settings: 'frontend/src/components/tabs/SettingsTab.jsx',
    nameplate: 'frontend/src/components/modals/DeviceNameplateModal.jsx',
    cold: 'frontend/src/components/modals/ColdStorageDestinationModal.jsx',
    metrics: 'frontend/src/components/tabs/MetricsTab.jsx',
    devices: 'frontend/src/components/tabs/DevicesTab.jsx',
    deprecate: 'frontend/src/components/modals/DeprecateMetricModal.jsx',
    draft: 'frontend/src/components/modals/SchemaDetailModal.jsx',
  };
  const src = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, read(f)]));
  // A bare `readOnly` attribute, alone on its line, is a fixed value drawn as an input.
  const bareReadOnly = /^\s*readOnly\s*$/m;
  for (const key of ['settings', 'nameplate', 'cold']) {
    if (bareReadOnly.test(src[key])) problems392.push(`${files[key]} draws a fixed value as a readOnly input`);
  }
  if (/disabled=\{readOnly\}/.test(src.settings)) problems392.push(`${files.settings} greys a control for a role that may not change it`);
  if (/disabled=\{proposeMode \|\| !!editing\?\.shadow_of\}/.test(src.devices)) problems392.push(`${files.devices} greys a replay lane's gateway, which nobody can change`);
  if (/disabled=\{!canManage && !proposeMode\}/.test(src.nameplate)) problems392.push(`${files.nameplate} greys the inputs of a role that may neither edit nor propose`);
  if (/disabled=\{!unitsApply\}/.test(src.metrics)) problems392.push(`${files.metrics} greys Units for a type that takes none`);
  for (const key of ['deprecate', 'draft']) {
    if (!src[key].includes('<MetricPicker')) problems392.push(`${files[key]} does not choose a metric with MetricPicker`);
  }
  if (src.deprecate.includes('<select')) problems392.push(`${files.deprecate} chooses the replacement from a <select>`);
  const readme = read('frontend/README.md');
  if (!readme.includes('### A value nobody can change is a label')) problems392.push('frontend/README.md does not state the rule that a value nobody can change is a label');
  if (/greyed(?:-| )out|greyed field/.test(read('help/pages/settings.md'))) problems392.push('help/pages/settings.md describes a greyed field');
  if (problems392.length) {
    for (const p of problems392) fail(`a fixed value is a label: ${p}`);
  } else {
    pass("a value nobody can change is drawn as text in the Settings rows, the nameplate, Cold Storage, Add Metric and a replay lane's gateway, Deprecate Metric and a draft schema choose from MetricPicker, and the README states the rule");
  }
}

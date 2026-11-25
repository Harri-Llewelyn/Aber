import { compare, need, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 165. The size a drop zone states is the one its bucket admits: an area's plan, a device's 3D model and
// a capture, each against storage-init.mjs's limit and, where the chart sets it, values.yaml's. A zone
// that states more invites a file the bucket refuses at the end of its upload, and one that states less
// turns away a file the site would take. A picture's is check 26's.
// -------------------------------------------------------------------------------------------------
const ZONES = [
  {
    label: "an area's plan", file: 'frontend/src/utils/areaPlans.js', constant: 'AREA_PLAN_MAX_BYTES',
    init: /^const AREA_PLAN_SIZE_LIMIT = (\d+);$/m, initName: 'AREA_PLAN_SIZE_LIMIT',
  },
  {
    label: "a device's 3D model", file: 'frontend/src/components/common/Model3DUploader.jsx', constant: 'MAX_BYTES',
    init: /process\.env\.STORAGE_MODEL_FILE_SIZE_LIMIT \|\| '(\d+)'/, initName: 'the default of STORAGE_MODEL_FILE_SIZE_LIMIT',
    chart: /^ {2}modelFileSizeLimit: (\d+)$/m, chartName: 'supabaseStorage.modelFileSizeLimit',
  },
  {
    label: 'a capture', file: 'frontend/src/utils/captureFile.js', constant: 'CAPTURE_FILE_MAX_BYTES',
    init: /process\.env\.CAPTURE_FILE_SIZE_LIMIT \|\| '(\d+)'/, initName: 'the default of CAPTURE_FILE_SIZE_LIMIT',
    chart: /^ {2}captureFileSizeLimit: (\d+)$/m, chartName: 'supabaseStorage.captureFileSizeLimit',
  },
];

/** `const NAME = 5 * 1024 * 1024` in a source, as a number in a string, or null when it is not there. */
function bytesOf(src, name, file) {
  const line = src.split('\n').find((l) => l.replace(/^export /, '').startsWith(`const ${name} = `)) ?? '';
  const product = need(line, /= (\d+(?: \* \d+)*)\s*$/, `${name} in ${file}`);
  return product && String(product[1].split(' * ').reduce((n, part) => n * Number(part), 1));
}

export default function check() {
  const init = read('scripts/storage-init.mjs').replace(/\r\n/g, '\n');
  const values = read('deploy/helm/aber/values.yaml').replace(/\r\n/g, '\n');
  for (const zone of ZONES) {
    const stated = bytesOf(read(zone.file).replace(/\r\n/g, '\n'), zone.constant, zone.file);
    const admitted = need(init, zone.init, `${zone.initName} in scripts/storage-init.mjs`);
    if (!stated || !admitted) continue;
    compare('dropZoneSize', `${zone.label}: the size its drop zone states and the bucket's`, stated, admitted[1]);
    const chart = zone.chart && need(values, zone.chart, `${zone.chartName} in values.yaml`);
    if (chart) compare('dropZoneSize', `${zone.label}: the size its drop zone states and the chart's`, stated, chart[1]);
  }
}

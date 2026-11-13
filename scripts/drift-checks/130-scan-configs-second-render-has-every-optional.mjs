import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 130. scan:config's second render has every optional workload on. Each `enabled: false` in
// values.yaml is turned on by values-prod.yaml.example or named in the overlay that render adds:
// true, or false where it renders no workload. Every key the overlay sets is in values.yaml, so a
// renamed switch fails here instead of leaving the overlay setting nothing. A part that renders
// only while a switch is off (`not .Values.<switch>`) is missing from a render that turns the switch
// on, so the third render's overlay names each such switch, and no other: false, or true where it
// hides nothing.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const OVERLAY = 'scripts/lint/config-scan-every-workload.yaml';
  const REPLACED = 'scripts/lint/config-scan-replaced-workloads.yaml';
  // Block mappings only, by indentation: dotted path -> the scalar after the colon, '' for a parent.
  // Comments, list items and flow mappings are skipped; the switches are none of those.
  const keyPaths = (text) => {
    const out = new Map();
    const stack = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^( *)([A-Za-z0-9_]+):(?: (.*))?$/);
      if (!m) continue;
      while (stack.length && stack[stack.length - 1].indent >= m[1].length) stack.pop();
      const value = (m[3] ?? '').replace(/ +#.*$/, '').trim();
      out.set([...stack.map((s) => s.key), m[2]].join('.'), value);
      if (!value) stack.push({ indent: m[1].length, key: m[2] });
    }
    return out;
  };
  const values = keyPaths(read('deploy/helm/aber/values.yaml'));
  const example = keyPaths(read('deploy/helm/aber/values-prod.yaml.example'));
  const overlay = keyPaths(read(OVERLAY));
  const replaced = keyPaths(read(REPLACED));
  const off = [...values].filter(([k, v]) => /(^|\.)enabled$/.test(k) && v === 'false').map(([k]) => k);
  const negated = new Set(allFiles
    .filter((f) => f.startsWith('deploy/helm/aber/templates/') && /\.(yaml|tpl)$/.test(f))
    .flatMap((f) => [...read(f).matchAll(/\bnot\s+\.Values\.([A-Za-z0-9_.]+)/g)].map((m) => m[1])));
  const replacing = [...negated].filter((k) => overlay.get(k) === 'true' || example.get(k) === 'true');
  const bad = [];
  const scanConfig = read('scripts/scan-config.mjs');
  for (const f of [OVERLAY, REPLACED]) {
    // The header comment names both files too, so only the path the script joins counts.
    if (!scanConfig.includes(`join(REPO, '${f}')`)) bad.push(`scripts/scan-config.mjs does not render with ${f}`);
  }
  if (off.length < 10) bad.push(`found only ${off.length} \`enabled: false\` in values.yaml; the reader has drifted from the file`);
  for (const k of off) {
    if (example.get(k) !== 'true' && !overlay.has(k)) bad.push(`${k} is off in values.yaml and values-prod.yaml.example; turn it on in ${OVERLAY}, or name it false there with why it renders no workload`);
  }
  for (const [k, v] of overlay) {
    if (v && !values.has(k)) bad.push(`${OVERLAY} sets ${k}, which values.yaml does not declare`);
  }
  for (const k of replacing) {
    if (!replaced.has(k)) bad.push(`a template reads ${k} as off, and the example or ${OVERLAY} turns it on; name it in ${REPLACED}: false, or true with why it hides nothing`);
  }
  for (const [k, v] of replaced) {
    if (v && !replacing.includes(k)) bad.push(`${REPLACED} sets ${k}, which no template reads as \`not .Values.${k}\` while the example or ${OVERLAY} turns it on`);
  }
  if (bad.length) {
    fail(`scan:config's every-workload render has drifted from the chart:\n${bad.map((b) => `        ${b}`).join('\n')}`);
  } else {
    const stayOff = off.filter((k) => overlay.get(k) === 'false');
    pass(`scan:config renders every switch values.yaml leaves off: ${off.length - stayOff.length} on in the second render or the example, ${stayOff.length} named as no workload; ${replacing.filter((k) => replaced.get(k) === 'false').length} of ${replacing.length} switches read as off are off again in the third`);
  }
}

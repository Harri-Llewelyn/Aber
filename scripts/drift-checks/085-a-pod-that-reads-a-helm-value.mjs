import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 85. A pod that reads a Helm value into its environment from the chart's Secret rolls when the
// value changes. Environment is fixed when the container starts, and an upgrade that changes only
// the Secret's data leaves the pod as it was. Each workload below hashes the value in a checksum
// annotation on its POD template; the Deployment's own metadata rolls nothing. The playback
// dialogs' fallback, "set secrets.mqttPlaybackCredentials and upgrade", rests on playback's.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const T = 'deploy/helm/aber/templates/apps/';
  const ROLLS = [
    ['playback.yaml', 'secrets.mqttPlaybackCredentials'],
    ['ingestion.yaml', 'secrets.mqttIngestionUser'],
    ['i3x-service.yaml', 'secrets.mqttI3xUser'],
  ];
  const offences = [];
  for (const [file, value] of ROLLS) {
    const src = read(T + file);
    const ref = `.Values.${value}`;
    const pod = /\n {2}template:\n {4}metadata:\n([\s\S]*?)\n {4}spec:\n/.exec(src)?.[1];
    if (pod === undefined) {
      offences.push(`${T}${file}: no pod template metadata found (\`  template:\` then \`    metadata:\`)`);
      continue;
    }
    // The value itself, or a variable the template assigns from it.
    const covers = (expr) => expr.includes(ref) ||
      [...src.matchAll(/(\$\w+)\s*:?=\s*([^}]+)/g)].some((m) => m[1] === expr && m[2].includes(ref));
    const sums = [...pod.matchAll(/^\s+checksum\/[\w.-]+: \{\{ (.+?) \| sha256sum \}\}$/gm)];
    if (!sums.some((m) => covers(m[1].trim()))) {
      offences.push(`${T}${file}'s pod template has no checksum annotation over ${value}, so changing it and upgrading leaves the pod on the old value`);
    }
  }
  for (const o of offences) fail(o);
  if (!offences.length) {
    pass(`the ${ROLLS.length} pods that read a Helm-value credential at start roll when it changes (${ROLLS.map(([, v]) => v).join(', ')})`);
  }
}

import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 78. The existingSecret contract in values-prod.yaml.example names every key templates/secret.yaml
// renders, and no other. A site that keeps its credentials in an external store builds its Secret
// from that list: a key missing from it is a pod that cannot start or a feature that fails closed.
// List lines are `#` and three spaces; text in parentheses is a key's condition and is not counted.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const EXAMPLE = 'deploy/helm/aber/values-prod.yaml.example';
  const TEMPLATE = 'deploy/helm/aber/templates/secret.yaml';
  const example = read(EXAMPLE);
  const start = example.indexOf('THE SECRET MUST CARRY THESE KEYS');
  const end = example.indexOf('# STILL A SET.', start);
  const lines = start < 0 || end < 0 ? [] : example.slice(start, end).split('\n').filter((l) => /^\s*# {3}/.test(l));
  const listed = [...lines.map((l) => l.replace(/^\s*#/, '')).join('\n').replace(/\([^)]*\)/g, '')
    .matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)].map((m) => m[0]);
  const rendered = [...read(TEMPLATE).matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);

  if (!listed.length || !rendered.length) {
    fail(`check 78 found no "THE SECRET MUST CARRY THESE KEYS" list in ${EXAMPLE} or no keys in ${TEMPLATE}, so it compares nothing`);
  } else {
    const missing = rendered.filter((k) => !listed.includes(k));
    const stale = [...new Set(listed)].filter((k) => !rendered.includes(k));
    const twice = [...new Set(listed.filter((k, i) => listed.indexOf(k) !== i))];
    for (const k of missing) {
      fail(`${TEMPLATE} renders ${k}, and ${EXAMPLE}'s existingSecret list does not name it. Add it there, ` +
        'with "(read only when ...)" if a setting gates it: a Secret built from the list lacks it otherwise.');
    }
    for (const k of stale) fail(`${EXAMPLE}'s existingSecret list names ${k}, which ${TEMPLATE} does not render: remove it`);
    for (const k of twice) fail(`${EXAMPLE}'s existingSecret list names ${k} more than once`);
    if (!missing.length && !stale.length && !twice.length) {
      pass(`${EXAMPLE}'s existingSecret list names the ${rendered.length} keys ${TEMPLATE} renders, and no other`);
    }
  }
}

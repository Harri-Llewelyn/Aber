import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 144. manage-people's actions are the same set everywhere they are named: the handler's `case`
// labels, the sentence it refuses an unknown action with, docs/openapi.yaml's `action` enum and
// its description's bullets, and the dashboard's calls. An action added to one and not the others
// is a request the spec says is refused, or a refusal that names an action the function lacks.
// And because change-email frees an address, the forge never finds a person by one: its email
// fallback stays off (templates/apps/gitea.yaml).
// -------------------------------------------------------------------------------------------------
export default function check() {
  const FN_FILE = 'supabase/functions/manage-people/people.ts';
  const source = read(FN_FILE);
  const handled = [...source.matchAll(/^\s+case "([a-z-]+)":$/gm)].map((m) => m[1]);
  const refusal = /`action` must be ([^"]+)\.",?$/m.exec(source)?.[1];
  const said = refusal ? refusal.split(/, | or /).map((a) => a.trim()) : [];
  const spec = read('docs/openapi.yaml');
  const block = spec.slice(spec.indexOf('\n  /functions/v1/manage-people:'), spec.indexOf('\n  /functions/v1/', spec.indexOf('\n  /functions/v1/manage-people:') + 1));
  const enumLine = /^\s+action:\s+\{ type: string, enum: \[([^\]]+)\] \}$/m.exec(block)?.[1];
  const specEnum = enumLine ? enumLine.split(',').map((a) => a.trim()) : [];
  const bullets = [...block.matchAll(/^ {8}- \*\*`([a-z-]+)`\*\*:/gm)].map((m) => m[1]);
  const api = read('frontend/src/api.js');
  const called = [...new Set([...api.matchAll(/managePeople\(\{ action: '([a-z-]+)'/g)].map((m) => m[1]))];
  const sorted = (list) => [...list].sort().join(', ');
  const want = sorted(handled);
  const wrong = [];
  if (handled.length < 5) wrong.push(`found ${handled.length} case labels in ${FN_FILE}; the extraction no longer matches the file`);
  for (const [what, list] of [
    [`${FN_FILE}'s "\`action\` must be" sentence`, said],
    ["docs/openapi.yaml's manage-people `action` enum", specEnum],
    ["docs/openapi.yaml's manage-people description bullets", bullets],
  ]) {
    if (sorted(list) !== want) wrong.push(`${what} names ${sorted(list) || 'nothing'}; the handler takes ${want}`);
  }
  for (const action of called) {
    if (!handled.includes(action)) wrong.push(`frontend/src/api.js asks manage-people for '${action}', which the handler does not take`);
  }
  if (!/- name: GITEA__service__ENABLE_REVERSE_PROXY_EMAIL\n\s+value: "false"\n/.test(read('deploy/helm/aber/templates/apps/gitea.yaml'))) {
    wrong.push('templates/apps/gitea.yaml does not set GITEA__service__ENABLE_REVERSE_PROXY_EMAIL to "false": the forge would sign a newcomer in as whoever holds their address');
  }
  if (wrong.length) {
    fail(`manage-people's actions disagree:\n${wrong.map((w) => `        ${w}`).join('\n')}`);
  } else {
    pass(`manage-people's ${handled.length} actions agree across the handler, its refusal, the OpenAPI enum and bullets, and the dashboard's ${called.length} calls; the forge's email fallback is off`);
  }
}

import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 494. Every gateway type has a row in docs/gateway-lifecycle.md's table of types. The page says what
// each lifecycle step leaves behind for each type, so a type the database admits or the dashboard
// names that the page does not list is a type whose steps nobody wrote down. Two sources name the
// types: the CHECK on gateways.deployment in 0001 (host, remote, third_party, which every later
// migration replays under) and LABELS in frontend/src/utils/gatewayType.js (those three, Simulated
// and Playback). The table's first column holds the labels and its second the `deployment` values.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const doc = read('docs/gateway-lifecycle.md');
  const section = doc.split(/^## The types$/m)[1]?.split(/^## /m)[0] ?? '';
  const rows = section.split('\n')
    .filter((line) => line.startsWith('| ') && !/^\| (:?-+:? \| )+/.test(line) && !line.startsWith('| Type |'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));

  const documentedLabels = new Set(rows.map((cells) => cells[0]));
  const documentedDeployments = new Set(rows.flatMap((cells) => [...(cells[1] ?? '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1])));

  const baseline = read('supabase/migrations/0001_baseline_schema.sql');
  const constraint = baseline.match(/CONSTRAINT gateways_deployment_valid CHECK \(\(deployment = ANY \(ARRAY\[([^\]]+)\]\)\)\)/);
  const labelsBlock = read('frontend/src/utils/gatewayType.js').match(/const LABELS = \{([^}]+)\}/);

  const problems494 = [];
  if (!constraint) problems494.push('0001 no longer declares gateways_deployment_valid as a list of values this check can read');
  if (!labelsBlock) problems494.push('frontend/src/utils/gatewayType.js no longer declares LABELS as a block this check can read');
  if (!rows.length) problems494.push('docs/gateway-lifecycle.md has no table under "The types"');

  if (!problems494.length) {
    const admitted = new Set([...constraint[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    const labelled = new Set([...labelsBlock[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]));
    for (const value of admitted) {
      if (!documentedDeployments.has(value)) problems494.push(`the deployment type \`${value}\` has no row in docs/gateway-lifecycle.md's table of types`);
    }
    for (const value of documentedDeployments) {
      if (!admitted.has(value)) problems494.push(`docs/gateway-lifecycle.md lists the deployment \`${value}\`, which gateways_deployment_valid does not admit`);
    }
    for (const label of labelled) {
      if (!documentedLabels.has(label)) problems494.push(`the type ${label} has no row in docs/gateway-lifecycle.md's table of types`);
    }
    for (const label of documentedLabels) {
      if (!labelled.has(label)) problems494.push(`docs/gateway-lifecycle.md lists the type ${label}, which gatewayType.js does not name`);
    }
  }

  if (problems494.length) {
    fail('the gateway lifecycle page and the types the code names disagree:\n' + problems494.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('docs/gateway-lifecycle.md has a row for every gateway type the database admits and the dashboard names');
  }
}

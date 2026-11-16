import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 435. The Gateways drawer reads a gateway's free disk as the Gateway Fleet Health dashboard does.
// The dashboard's Disk free column is red below its second step and orange below its third;
// utils/gatewayHealth.js names the same two figures, so the drawer's Disk Free row and the Health
// block's summary say the same thing about one gateway. The row's help and the Gateways help state
// them, in the dashboard's terms.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems435 = [];
  const source = read('frontend/src/utils/gatewayHealth.js');
  const gib = source.match(/const GIB = 1024 \*\* 3;/) ? 1024 ** 3 : null;
  const figure = (name) => {
    const m = source.match(new RegExp(`export const ${name} = (\\d+) \\* GIB;`));
    return m && gib ? Number(m[1]) * gib : null;
  };
  const danger = figure('DISK_FREE_DANGER_BYTES');
  const warn = figure('DISK_FREE_WARN_BYTES');
  if (danger === null || warn === null) problems435.push('utils/gatewayHealth.js no longer states DISK_FREE_DANGER_BYTES and DISK_FREE_WARN_BYTES as `N * GIB`, so this check cannot read them');

  const dashboard = JSON.parse(read('grafana/provisioning/dashboards/platform/gateway-fleet-health.json'));
  const steps = [];
  const visit = (panels) => {
    for (const panel of panels ?? []) {
      for (const override of panel.fieldConfig?.overrides ?? []) {
        if (override.matcher?.options !== 'Disk free') continue;
        const t = override.properties.find((p) => p.id === 'thresholds');
        if (t) steps.push(t.value.steps);
      }
      visit(panel.panels);
    }
  };
  visit(dashboard.panels);
  if (steps.length !== 1) {
    problems435.push(`the Fleet Health dashboard has ${steps.length} thresholds for its Disk free column, not 1`);
  } else {
    const [red, orange, green] = steps[0];
    if (red?.color !== 'red' || orange?.color !== 'orange' || green?.color !== 'green') {
      problems435.push(`the dashboard's Disk free steps are ${steps[0].map((s) => s.color).join(', ')}, not red, orange, green`);
    } else {
      if (danger !== null && orange.value !== danger) problems435.push(`the dashboard turns Disk free orange at ${orange.value} bytes, but DISK_FREE_DANGER_BYTES is ${danger}`);
      if (warn !== null && green.value !== warn) problems435.push(`the dashboard turns Disk free green at ${green.value} bytes, but DISK_FREE_WARN_BYTES is ${warn}`);
    }
  }
  if (!read('frontend/src/components/tabs/GatewaysTab.jsx').includes('Under 5 GiB reads amber and under 1 GiB red')) problems435.push('the Disk Free row\'s help does not say it reads amber under 5 GiB and red under 1 GiB');
  if (!read('help/pages/gateways.md').includes('**Disk Free** reads amber under 5 GiB and red under 1 GiB')) problems435.push('help/pages/gateways.md does not say Disk Free reads amber under 5 GiB and red under 1 GiB');

  if (problems435.length) {
    fail('the Gateways drawer and the Gateway Fleet Health dashboard read free disk differently:\n' + problems435.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the Gateways drawer reads Disk Free amber under 5 GiB and red under 1 GiB, as the Gateway Fleet Health dashboard colours it, and the help says so');
  }
}

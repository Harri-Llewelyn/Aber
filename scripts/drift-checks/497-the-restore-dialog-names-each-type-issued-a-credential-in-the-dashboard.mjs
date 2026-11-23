import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 497. The Restore dialog names every type the dashboard issues a broker credential for. It tells a
// person who restores a gateway whose credential was revoked where to get another: Generate Broker
// Credential for the types credentialIssuedHere() admits, Set Up Gateway for a Remote one. A type
// the dialog leaves out is a type whose person is not told. The types are the selectable ones
// (SELECTABLE_TYPES) that are not Remote, and credentialIssuedHere() must admit exactly the two
// deployments (host and third_party) that leave. A deployment added to it fails here until the
// dialog names it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const type = read('frontend/src/utils/gatewayType.js');
  const dialog = read('frontend/src/components/modals/RestoreEntityModal.jsx').replace(/'\s*\+\s*'/g, '');

  const problems497 = [];
  const issued = type.match(/export function credentialIssuedHere\(gateway\) \{([\s\S]*?)\n\}/);
  const selectable = type.match(/export const SELECTABLE_TYPES = \[([^\]]*)\]/);
  const labels = type.match(/const LABELS = \{([^}]+)\}/);
  const phrase = dialog.match(/\(Generate Broker Credential\) for an? ([^']+?) gateway, or set a Remote gateway up again/);
  if (!issued) problems497.push('gatewayType.js no longer declares credentialIssuedHere() in a shape this check can read');
  if (!selectable) problems497.push('gatewayType.js no longer declares SELECTABLE_TYPES in a shape this check can read');
  if (!labels) problems497.push('gatewayType.js no longer declares LABELS in a shape this check can read');
  if (!phrase) problems497.push("RestoreEntityModal.jsx no longer says which gateways are issued a credential again, as '(Generate Broker Credential) for a <types> gateway, or set a Remote gateway up again'");

  if (!problems497.length) {
    const deployments = [...issued[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort().join(',');
    if (deployments !== 'host,third_party') {
      problems497.push(`credentialIssuedHere() admits the deployments ${deployments}, and this check expects host,third_party: say which types the Restore dialog names for the new one`);
    }
    const labelOf = new Map([...labels[1].matchAll(/\[GATEWAY_TYPES\.([A-Z_]+)\]: '([^']+)'/g)].map((m) => [m[1], m[2]]));
    const expected = [...selectable[1].matchAll(/GATEWAY_TYPES\.([A-Z_]+)/g)].map((m) => m[1])
      .filter((name) => name !== 'REMOTE').map((name) => labelOf.get(name) ?? `(unlabelled ${name})`).sort();
    const named = phrase[1].split(/, | or /).map((word) => word.trim()).filter(Boolean).sort();
    if (expected.join(',') !== named.join(',')) {
      problems497.push(`the Restore dialog names ${named.join(', ')} where a credential is issued again, and the selectable types that are not Remote are ${expected.join(', ')}`);
    }
  }

  if (problems497.length) {
    fail('the Restore dialog and the types the dashboard issues a credential for disagree:\n' + problems497.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the Restore dialog names Host, Simulated and Third-party, the selectable types that are not Remote, where a credential is issued again');
  }
}

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compare, lastDefinition, need, read, ROOT } from './lib.mjs';

/** The files that open the setup dialog, each with the row it hands over and the call that hands it. */
const OPENERS = {
  'AccessControlTab.jsx': ['...g', /onClick=\{\(\) => setBundleForGw\(\{\s*(\.\.\.g), gateway_id: g\.id, gateway_name: g\.name, confirmFirst: true\s*\}\)\}/],
  'GatewaysTab.jsx': ['...selected', /onClick: \(\) => setBundleForGw\(\{ (\.\.\.selected), confirmFirst: true \}\)/],
};

// 130. Which setup revokes a credential, one rule in issue_gateway_enrollment_token() and the
// dashboard (0312). The database revokes the credential an enrolled appliance holds when
// gateway_has_broker_credential() says its enrolment stands, and check 129 holds that rule against
// enrolmentStands(). setupRevokesCredential() is enrolmentStands(), and two places ask it: the drawer,
// which names the action Re-issue Setup and never offers it while the gateway is online, and the setup
// dialog, which says the old appliance's credential is revoked. The dialog goes by the two times it reads
// as its question opens, and by the row it is given until they answer. So every caller hands its row over
// whole, Access Control's read and the dialog's select both times, and the dialog's own issue leaves an
// enrolment that has ended. If the sides read different rules, the dialog promises a revocation the
// database does not make, or a person is cut off without being told.
export default function check() {
  const issue = lastDefinition('CREATE OR REPLACE FUNCTION public.issue_gateway_enrollment_token(', '$$;',
    'issue_gateway_enrollment_token()');
  const revokes = issue && need(issue.body, /v_ends := public\.([a-z_]+)\(v_gateway\);\s+IF v_ends THEN\s+PERFORM public\.([a-z_]+)\(v_gateway\.sparkplug_id\)/,
    `the revocation issue_gateway_enrollment_token() makes for an enrolled appliance (${issue?.file})`);
  if (revokes) {
    compare('setupRevokes', `what decides that a setup revokes (${issue.file})`, 'gateway_has_broker_credential', revokes[1]);
    compare('setupRevokes', `how the setup's revocation is recorded (${issue.file})`, 'owe_gateway_revocation', revokes[2]);
  }

  const rule = need(read('frontend/src/utils/credentialState.js'), /export function setupRevokesCredential\(gateway\) \{\s*return ([^;]*);\s*\}/,
    'setupRevokesCredential() in frontend/src/utils/credentialState.js');
  if (rule) compare('setupRevokes', 'the rule setupRevokesCredential() reads', rule[1], 'enrolmentStands(gateway)');

  const tab = read('frontend/src/components/tabs/GatewaysTab.jsx');
  const reissues = need(tab, /const reissuesSetup = !!selected && ([^\n]*)\(selected\)\n/,
    "the drawer's rule for Re-issue Setup in GatewaysTab.jsx");
  if (reissues) compare('setupRevokes', "the function the drawer's Re-issue Setup reads", reissues[1], 'setupRevokesCredential');
  const offered = need(tab, /const offersSetup = [^\n]*\n\s+&& \(selectedPending \|\| (!isGatewayOnline)\(selected\)\)/,
    "the drawer's rule for offering setup in GatewaysTab.jsx");
  if (offered) compare('setupRevokes', 'the drawer offers setup only while the gateway is not online', offered[1], '!isGatewayOnline');

  const modal = read('frontend/src/components/modals/GatewayBundleModal.jsx');
  const asks = need(modal, /const revokesCredential = ([A-Za-z]+)\(([^\n]*)\)\n/,
    "the setup dialog's rule for the revocation in GatewayBundleModal.jsx");
  if (asks) {
    compare('setupRevokes', 'the function the setup dialog reads', asks[1], 'setupRevokesCredential');
    compare('setupRevokes', 'what the setup dialog asks it of: what it knows since it opened, else its row', asks[2], 'enrolment ?? gateway');
  }
  const opens = need(modal, /useEffect\(\(\) => \{\n {4}if \(step !== '([a-z]+)'\) return undefined\n[\s\S]{0,160}await api\.([A-Za-z]+)\(gateway\.gateway_id\)/,
    "the setup dialog's read of the gateway as its question opens in GatewayBundleModal.jsx");
  if (opens) {
    compare('setupRevokes', 'the step whose opening reads the gateway again', opens[1], 'confirm');
    compare('setupRevokes', 'what the setup dialog reads the gateway with', opens[2], 'gatewayEnrolment');
  }
  // Both shapes of the issue, the command and the bundle, end the enrolment the dialog knows of.
  compare('setupRevokes', 'the issues after which the dialog takes the enrolment to have ended',
    [...modal.matchAll(/setBundle\(\{ \.\.\.result, kind: '([a-z]+)' \}\)\n +ended\(\)\n/g)].map((m) => m[1]).join(', '), 'command, bundle');
  const says = need(modal, /\{([^{}]*) && \(\s*<> This gateway has already enrolled, so this also revokes the broker credential/,
    'the setup dialog\'s revocation sentence in GatewayBundleModal.jsx');
  if (says) compare('setupRevokes', 'what the dialog reads before it says the credential is revoked', says[1], 'revokesCredential');

  // A new opener is added to OPENERS, with the row it hands over.
  const components = 'frontend/src/components';
  const openers = readdirSync(join(ROOT, components), { recursive: true })
    .map((path) => String(path).replaceAll('\\', '/'))
    .filter((path) => path.endsWith('.jsx') && read(`${components}/${path}`).includes('<GatewayBundleModal'))
    .map((path) => path.slice(path.lastIndexOf('/') + 1)).sort();
  compare('setupRevokes', 'the files that open the setup dialog', openers.join(', '), Object.keys(OPENERS).join(', '));
  for (const [file, [row, shape]] of Object.entries(OPENERS)) {
    const handed = need(read(`${components}/tabs/${file}`), shape, `the row ${file} hands the setup dialog`);
    if (handed) compare('setupRevokes', `the row ${file} hands the setup dialog, whole`, handed[1], row);
  }
  const READS = [
    ["Access Control's read", /listGatewayCredentials: async[\s\S]*?\.select\('([^']*)'\)/],
    ["the setup dialog's own read", /gatewayEnrolment: async[\s\S]*?\.select\('([^']*)'\)/],
  ];
  for (const [whose, shape] of READS) {
    const columns = need(read('frontend/src/api.js'), shape, `${whose} of the gateways in api.js`);
    if (!columns) continue;
    const selects = columns[1].split(',');
    compare('setupRevokes', `the times ${whose} selects`,
      ['enrolled_at', 'credential_revoked_at'].filter((column) => selects.includes(column)).join(', '), 'enrolled_at, credential_revoked_at');
  }
}

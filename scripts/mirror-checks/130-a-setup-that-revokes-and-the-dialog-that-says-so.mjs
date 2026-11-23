import { compare, lastDefinition, need, read } from './lib.mjs';

// 130. Which setup revokes a credential, one rule in issue_gateway_enrollment_token() and the drawer
// (0312). The database revokes the credential an enrolled appliance holds when
// gateway_has_broker_credential() says its enrolment stands, and check 129 holds that rule against
// enrolmentStands(). The drawer names the action Re-issue Setup, and has the dialog say the old
// appliance's credential is revoked, for the gateways enrolmentStands() answers for, and never offers
// it while the gateway is online. If the two sides read different rules, the dialog promises a
// revocation the database does not make, or a person is cut off without being told.
export default function check() {
  const issue = lastDefinition('CREATE OR REPLACE FUNCTION public.issue_gateway_enrollment_token(', '$$;',
    'issue_gateway_enrollment_token()');
  const revokes = issue && need(issue.body, /v_ends := public\.([a-z_]+)\(v_gateway\);\s+IF v_ends THEN\s+PERFORM public\.([a-z_]+)\(v_gateway\.sparkplug_id\)/,
    `the revocation issue_gateway_enrollment_token() makes for an enrolled appliance (${issue?.file})`);
  if (revokes) {
    compare('setupRevokes', `what decides that a setup revokes (${issue.file})`, 'gateway_has_broker_credential', revokes[1]);
    compare('setupRevokes', `how the setup's revocation is recorded (${issue.file})`, 'owe_gateway_revocation', revokes[2]);
  }

  const tab = read('frontend/src/components/tabs/GatewaysTab.jsx');
  const reissues = need(tab, /const reissuesSetup = !!selected && \(selected\.status === 'AWAITING_BIRTH' \|\| (enrolmentStands)\(selected\)\)/,
    "the drawer's rule for Re-issue Setup in GatewaysTab.jsx");
  if (reissues) compare('setupRevokes', "the function the drawer's Re-issue Setup reads", reissues[1], 'enrolmentStands');
  const passed = need(tab, /revokesCredential: (reissuesSetup),/, "what the drawer tells the setup dialog about the revocation");
  if (passed) compare('setupRevokes', 'what the drawer passes the dialog', passed[1], 'reissuesSetup');
  const offered = need(tab, /const offersSetup = [^\n]*\n\s+&& \(selectedPending \|\| (!isGatewayOnline)\(selected\)\)/,
    "the drawer's rule for offering setup in GatewaysTab.jsx");
  if (offered) compare('setupRevokes', 'the drawer offers setup only while the gateway is not online', offered[1], '!isGatewayOnline');

  const modal = read('frontend/src/components/modals/GatewayBundleModal.jsx');
  const says = need(modal, /\(gateway\.status === 'AWAITING_BIRTH' \|\| gateway\.(revokesCredential)\) && !bundle && \(\s*<> This gateway has already enrolled, so this also revokes the broker credential/,
    'the setup dialog\'s revocation sentence in GatewayBundleModal.jsx');
  if (says) compare('setupRevokes', 'what the dialog reads before it says the credential is revoked', says[1], 'revokesCredential');
}

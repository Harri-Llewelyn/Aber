import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 10e. The CA-expiry warning window is one decision, declared twice: Grafana's
// `aber-gateway-ca-expiring` rule and the Gateways page's CERT_EXPIRY_WARN_DAYS. A UI that warns
// at a different day count than the rule fires sends an operator looking for an alert that has
// not been raised, or trains them to ignore the colour.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const rules = read('grafana/provisioning/alerting/alert-rules.yaml');
  const util = read('frontend/src/utils/gatewayStatus.js');

  // The threshold node of the CA rule, found by walking forward from its uid so a `params: [30]`
  // belonging to some other rule cannot answer for it.
  const ruleAt = rules.indexOf('uid: aber-gateway-ca-expiring');
  const ruleBody = ruleAt === -1 ? '' : rules.slice(ruleAt, ruleAt + 4000);
  const ruleDays = ruleBody.match(/type:\s*lt\s*\n\s*params:\s*\[(\d+)\]/);
  const uiDays = util.match(/CERT_EXPIRY_WARN_DAYS\s*=\s*(\d+)/);

  if (ruleAt === -1) {
    fail('grafana alert rule `aber-gateway-ca-expiring` is gone. It is the only warning that a '
      + 'gateway\'s\n      hand-distributed CA is about to expire, which takes the whole fleet '
      + 'offline at once.');
  } else if (!ruleDays || !uiDays) {
    fail('could not read the CA-expiry window from '
      + `${ruleDays ? 'frontend/src/utils/gatewayStatus.js' : 'the Grafana rule'}, so the two were `
      + 'not compared.');
  } else if (ruleDays[1] !== uiDays[1]) {
    fail(
      `the CA-expiry warning window disagrees: the Grafana rule fires below ${ruleDays[1]} days, `
      + `the Gateways page warns below ${uiDays[1]}.\n`
      + '      An operator seeing one without the other goes looking for an alert that was never\n'
      + '      raised, or learns to ignore a colour that means nothing.'
    );
  } else {
    pass(`the CA-expiry window is ${ruleDays[1]} days in both the Grafana rule and the Gateways page`);
  }
}

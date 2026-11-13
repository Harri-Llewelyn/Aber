import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 362. The two columns the retry reads for "a credential after the stamp" are the ones the dashboard
// and gateway_has_broker_credential() read. 0288's helper compares enrolled_at and a CREDENTIAL_ISSUED
// row's recorded_at with credential_revoked_at; utils/credentialState.js reads the same two against
// the same stamp, so the drawer and the sweep agree on what outranks a revocation. And 0252's section
// no longer says the sweep judges archived gateways alone, and points at 0288's.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const sql = read('supabase/migrations/0288_a_failed_type_change_revocation_is_retried.sql');
  const helper = sql.match(/FUNCTION public\.gateway_credential_was_replaced\([\s\S]*?\n\$\$;/)?.[0] ?? '';
  const state = read('frontend/src/utils/credentialState.js');
  const readme = supabaseReadme();
  const at252 = readme.match(/\n### Changing a gateway's type cleans up after the old type \(0252\)\n([\s\S]*?)(?=\n### )/)?.[1];
  const problems362 = [];
  if (!helper) problems362.push('could not read gateway_credential_was_replaced() out of 0288');
  else {
    for (const part of ['g.enrolled_at > g.credential_revoked_at', "dt.action      = 'CREDENTIAL_ISSUED'", 'dt.recorded_at > g.credential_revoked_at']) {
      if (!helper.includes(part)) problems362.push(`gateway_credential_was_replaced() does not compare \`${part}\``);
    }
    if (!/after\(gateway\.enrolled_at, revoked\)/.test(state) || !/after\(issuedAt, revoked\)/.test(state)) {
      problems362.push("utils/credentialState.js no longer lets an enrolment or an issue after credential_revoked_at outrank the revocation, as 0288's helper reads them");
    }
  }
  if (!at252) problems362.push('supabase/README.md has no 0252 section');
  else {
    if (/judges archived gateways\s+alone/.test(at252)) problems362.push("the 0252 section still says the revocation sweep judges archived gateways alone, which 0288 no longer does");
    if (!at252.includes('(0288)')) problems362.push('the 0252 section does not point to 0288');
  }
  if (problems362.length) {
    fail(`the revocation retry and what outranks a revocation are not described as the code reads them:\n${problems362.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass("0288's retry and utils/credentialState.js let an enrolment or a CREDENTIAL_ISSUED row after credential_revoked_at outrank a revocation, and 0252's section points to 0288");
  }
}

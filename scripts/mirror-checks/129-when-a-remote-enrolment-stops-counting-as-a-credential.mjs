import { compare, lastDefinition, need, read } from './lib.mjs';

// 129. When a Remote gateway's enrolment stops counting as a broker credential (0308). The dashboard
// reads it in enrolmentStands(), which the drawer's setup action and the Edit form's Type hint both
// ask: an enrolment stands while no revocation came after it. gateway_has_broker_credential()'s
// remote arm decides the same for the database, where the archive and delete triggers and a type
// change ask the broker to disable the account. If one side counted an enrolment the other did not,
// a person would be told saving ends a credential the broker already refused, or the broker would be
// asked for a second revocation. Both must read which of the two times is later, and both must
// count an enrolment where no stamp exists.
export default function check() {
  const stands = need(read('frontend/src/utils/credentialState.js'),
    /export function enrolmentStands\(gateway\) \{([\s\S]*?)\n\}/, 'enrolmentStands() in frontend/src/utils/credentialState.js');
  const has = lastDefinition('CREATE OR REPLACE FUNCTION public.gateway_has_broker_credential(', '$$;', 'gateway_has_broker_credential()');
  const arm = has && need(has.body, /g\.deployment = 'remote'([\s\S]*?)\n\s*OR \(g\.deployment IN/,
    `gateway_has_broker_credential()'s remote arm (${has.file})`);
  const jsLater = stands && need(stands[1], /after\(gateway\.([a-z_]+), gateway\.([a-z_]+)\)/,
    "the comparison enrolmentStands() makes between an enrolment and a revocation");
  const sqlLater = arm && need(arm[1], /g\.([a-z_]+) > g\.([a-z_]+)/,
    `the comparison the remote arm makes between an enrolment and a revocation (${has.file})`);
  if (jsLater && sqlLater) {
    compare('remoteEnrolmentCounts', `the column that must be later (${has.file} and enrolmentStands())`, `${jsLater[1]} after ${jsLater[2]}`, `${sqlLater[1]} after ${sqlLater[2]}`);
  }
  if (stands && arm) {
    compare('remoteEnrolmentCounts', `whether an enrolment with no revocation stamp counts (${has.file} and enrolmentStands())`,
      /!gateway\.credential_revoked_at/.test(stands[1]), /g\.credential_revoked_at IS NULL OR/.test(arm[1]));
  }

  const form = need(read('frontend/src/components/tabs/GatewaysTab.jsx'), /editingRemote \? (enrolmentStands)\(editing\)/,
    "the Edit form's Remote credential in GatewaysTab.jsx");
  if (form) compare('remoteEnrolmentCounts', "the function the Edit form reads a Remote gateway's credential with", form[1], 'enrolmentStands');
}

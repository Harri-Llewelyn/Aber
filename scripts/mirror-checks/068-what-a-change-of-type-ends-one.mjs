import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 68. What a change of type ends, one rule in the trigger and the Edit form (0252). The trigger, and
// 0252's one-off clean-up, move a gateway that leaves Remote out of the enrolment states
// gatewayStatus.js counts as pending. The form says a setup command is cancelled for the state
// issue_gateway_enrollment_token() writes, and reads a Remote gateway's credential from the column
// gateway_has_broker_credential()'s remote arm reads. A state one side adds leaves a gateway reading
// Awaiting setup after its type changed; another column has the form say nothing ends where the
// trigger revokes.
export default function check() {
  const js = read('frontend/src/utils/gatewayStatus.js');
  const constants = new Map([...js.matchAll(/export const (GATEWAY_STATUS_[A-Z_]+) = '([A-Z_]+)'/g)].map((m) => [m[1], m[2]]));
  const pending = need(js, /const PENDING_STATUSES = new Set\(\[([^\]]*)\]\)/, 'PENDING_STATUSES in gatewayStatus.js');
  const jsStates = pending
    ? [...pending[1].matchAll(/[A-Z_]+/g)].map((m) => constants.get(m[0]) ?? `(unresolved ${m[0]})`).sort().join(',')
    : null;
  const list = (text) => [...text.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort().join(',');

  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.clean_up_after_a_gateway_type_change(', '$$;',
    'clean_up_after_a_gateway_type_change()');
  const trigger = fn && need(fn.body, /NEW\.status IN \(([^)]*)\) THEN\s+NEW\.status := 'OFFLINE'/,
    `the states clean_up_after_a_gateway_type_change() ends (${fn.file})`);
  const cleanUp = need(SCHEMA, /UPDATE public\.gateways\s+SET status = 'OFFLINE'\s+WHERE deployment <> 'remote'\s+AND status IN \(([^)]*)\)/,
    "0252's one-off clean-up of the enrolment states");
  if (jsStates && trigger) compare('gatewayTypeChange', `the enrolment states the trigger ends (${fn.file}) and PENDING_STATUSES`, jsStates, list(trigger[1]));
  if (jsStates && cleanUp) compare('gatewayTypeChange', "the enrolment states 0252's clean-up ends and PENDING_STATUSES", jsStates, list(cleanUp[1]));

  const type = read('frontend/src/utils/gatewayType.js');
  const issue = lastDefinition('CREATE OR REPLACE FUNCTION public.issue_gateway_enrollment_token(', '$$;', 'issue_gateway_enrollment_token()');
  const issued = issue && need(issue.body, /UPDATE public\.gateways\s+SET status = '([A-Z_]+)'/, `the status issue_gateway_enrollment_token() writes (${issue.file})`);
  const jsSetup = need(type, /wasRemote && stored\.status === '([A-Z_]+)'/, "gatewayTypeChange()'s setup state in utils/gatewayType.js");
  if (issued && jsSetup) compare('gatewayTypeChange', `the state a setup command leaves (${issue.file}) and the form's`, jsSetup[1], issued[1]);

  const has = lastDefinition('CREATE OR REPLACE FUNCTION public.gateway_has_broker_credential(', '$$;', 'gateway_has_broker_credential()');
  const arm = has && need(has.body, /g\.deployment = 'remote' AND g\.([a-z_]+) IS NOT NULL/, `gateway_has_broker_credential()'s remote arm (${has.file})`);
  const jsArm = need(read('frontend/src/components/tabs/GatewaysTab.jsx'), /editingRemote \? !!editing\.([a-z_]+)/,
    "the Edit form's Remote credential in GatewaysTab.jsx");
  if (arm && jsArm) compare('gatewayTypeChange', `the column a Remote gateway's credential is read from (${has.file}) and the form's`, jsArm[1], arm[1]);
}

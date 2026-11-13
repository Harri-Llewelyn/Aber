import { compare, lastDefinition, MIGRATION_DIR, ok, problems, read } from './lib.mjs';

// 60. The MFA switch's predicate, in its four places (0251): mfa_satisfied() and require_mfa() in
// 0001, the session ending in 0251, the edge functions' _shared/secondFactor.ts with the consent
// gate, and the dashboard's utils/secondFactor.js. Each names the same setting, roles, federated
// methods, refusal sentence and code, and the gate's Grafana is stack_app_ids()'s first app.
export default function check() {
  const before = problems.length;
  const satisfied = lastDefinition('CREATE OR REPLACE FUNCTION public.mfa_satisfied()', '$$;', 'mfa_satisfied() in the applied chain');
  const guard = lastDefinition('CREATE OR REPLACE FUNCTION public.require_mfa()', '$$;', 'require_mfa() in the applied chain');
  const ending = lastDefinition('CREATE OR REPLACE FUNCTION public.end_covered_door_sessions(', '$$;', 'end_covered_door_sessions() in the applied chain');
  const trigger = lastDefinition('CREATE OR REPLACE FUNCTION public.mfa_grant_ends_door_sessions()', '$$;', 'mfa_grant_ends_door_sessions() in the applied chain');
  const switched = lastDefinition('CREATE OR REPLACE FUNCTION public.mfa_switch_ends_door_sessions()', '$$;', 'mfa_switch_ends_door_sessions() in the applied chain');
  const ids = lastDefinition('CREATE OR REPLACE FUNCTION public.stack_app_ids()', '$$;', 'stack_app_ids() in the applied chain');
  const ts = read('supabase/functions/_shared/secondFactor.ts');
  const gate = read('supabase/functions/consent-gate/gate.ts');
  const web = read('frontend/src/utils/secondFactor.js');
  const seed = read(`${MIGRATION_DIR}/0002_seed_data.sql`);
  const list = (src) => (src ? [...src.matchAll(/["']([A-Za-z_/]+)["']/g)].map((m) => m[1]).sort().join(', ') : null);
  // A literal search, not a regex built from the name.
  const tsConst = (name) => {
    const head = `export const ${name} = `;
    const at = ts.indexOf(head);
    if (at < 0) {
      problems.push(`could not find ${name} in _shared/secondFactor.ts — the file's shape changed, so this check is no longer checking anything`);
      return null;
    }
    return ts.slice(at + head.length, ts.indexOf(';', at));
  };
  if (satisfied && guard && ending && trigger && switched && ids) {
    const setting = tsConst('MFA_SETTING')?.replace(/"/g, '');
    for (const [where, body] of [['mfa_satisfied()', satisfied.body], ['mfa_switch_ends_door_sessions()', switched.body], ['mfa_grant_ends_door_sessions()', trigger.body]]) {
      if (!body.includes(`'${setting}'`)) problems.push(`mfaPredicate: ${where} does not read ${setting}, the setting _shared/secondFactor.ts reads`);
    }
    if (!seed.includes(`'${setting}',\n    to_jsonb(false),\n    'boolean'`)) problems.push(`mfaPredicate: 0002 does not declare ${setting} as a boolean, off`);
    const roles = list(tsConst('COVERED_ROLES'));
    for (const [where, body] of [['mfa_satisfied()', satisfied.body], ['end_covered_door_sessions()', ending.body], ['mfa_grant_ends_door_sessions()', trigger.body]]) {
      compare('mfaPredicate', `the covered roles in ${where} and _shared/secondFactor.ts`, roles, list((body.match(/ARRAY\[([^\]]*)\]/) || [])[1]));
    }
    const federated = list(tsConst('FEDERATED_METHODS'));
    compare('mfaPredicate', 'the federated methods in mfa_satisfied() and _shared/secondFactor.ts', federated,
      [...satisfied.body.matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]).sort().join(', '));
    compare('mfaPredicate', 'the federated methods in utils/secondFactor.js and _shared/secondFactor.ts', federated,
      list((web.match(/export const FEDERATED_METHODS = \[([^\]]*)\]/) || [])[1]));
    const sentence = tsConst('MFA_REFUSAL')?.replace(/^"|"$/g, '');
    compare('mfaPredicate', 'the refusal in require_mfa() and _shared/secondFactor.ts', sentence, (guard.body.match(/RAISE EXCEPTION '([^']+)'/) || [])[1]);
    compare('mfaPredicate', 'the refusal in utils/secondFactor.js and _shared/secondFactor.ts', sentence, (web.match(/export const MFA_REQUIRED_MESSAGE = '([^']+)'/) || [])[1]);
    compare('mfaPredicate', 'the refusal code in require_mfa() and _shared/secondFactor.ts', tsConst('MFA_REFUSAL_CODE')?.replace(/"/g, ''),
      (guard.body.match(/DETAIL = '([^']+)'/) || [])[1]);
    const grafana = (ids.body.match(/'([0-9a-f-]{36})'/) || [])[1];
    compare('mfaPredicate', "Grafana's app in consent-gate and stack_app_ids()", (gate.match(/GRAFANA_CLIENT_ID = "([0-9a-f-]{36})"/) || [])[1], grafana);
    compare('mfaPredicate', "the app end_covered_door_sessions() keeps and stack_app_ids()'s Grafana", (ending.body.match(/<> '([0-9a-f-]{36})'::uuid/) || [])[1], grafana);
    if (problems.length === before) ok.push('mfaPredicate: the setting, roles, federated methods, refusal and Grafana agree across 0001, 0251, the functions and the dashboard');
  }
}

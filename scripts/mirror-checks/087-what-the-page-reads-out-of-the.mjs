import { compare, lastDefinition, need, read } from './lib.mjs';

// 87. What the page reads out of the database's answers, in the words the functions use (0255, 0256).
// The fingerprint of an alert an automation raised, which the page takes the trigger out of to open
// its automation; the reasons automations_for_entity() gives, which the list says in words; and the
// statuses apply_automations() gives each automation, which the preview draws. A word the page does
// not know is drawn as it came, but a fingerprint it cannot read opens nothing.
export default function check() {
  const fingerprint = lastDefinition('CREATE OR REPLACE FUNCTION public.automation_alert_fingerprint(', '$$;', 'automation_alert_fingerprint()');
  const sqlShape = fingerprint && need(fingerprint.body,
    /ELSE '(condition:)' \|\| p_trigger_id::text \|\| '(:)' \|\| p_entity_id::text \|\| '(:)' \|\| p_metric_name/,
    `automation_alert_fingerprint()'s composition (${fingerprint.file})`);
  const routes = read('frontend/src/routes.js');
  const jsPattern = need(routes, /export const triggerIdOfFingerprint =[\s\S]*?\/\^(condition:)\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)(:)\//,
    'triggerIdOfFingerprint() in routes.js');
  if (sqlShape && jsPattern) {
    compare('automationsReads', `the fingerprint of an automation's alert, up to its trigger id, in routes.js and automation_alert_fingerprint() (${fingerprint.file})`,
      `${jsPattern[1]}<trigger>${jsPattern[2]}`, `${sqlShape[1]}<trigger>${sqlShape[2]}`);
  }

  const js = read('frontend/src/utils/automations.js');
  const forEntity = lastDefinition('CREATE OR REPLACE FUNCTION public.automations_for_entity(', '$$;', 'automations_for_entity()');
  const sqlReasons = forEntity && [...forEntity.body.matchAll(/'([a-z][a-z-]*)'::text/g)].map((m) => m[1]);
  const block = need(js, /export const APPLIES_BECAUSE = \{([\s\S]*?)\n\}/, 'APPLIES_BECAUSE in utils/automations.js');
  const jsReasons = block && [...block[1].matchAll(/^ {2}(?:'([a-z-]+)'|([a-z]+)): \{/gm)].map((m) => m[1] ?? m[2]);
  if (sqlReasons && jsReasons) {
    compare('automationsReads', `the reasons the list says and automations_for_entity() gives (${forEntity.file})`,
      [...jsReasons].sort().join(', '), [...new Set(sqlReasons)].sort().join(', '));
  }

  const apply = lastDefinition('CREATE OR REPLACE FUNCTION public.apply_automations(', '$$;', 'apply_automations()');
  const sqlStatuses = apply && [...new Set([...apply.body.matchAll(/v_status := '([a-z]+)'/g)].map((m) => m[1]))].sort();
  const statuses = need(js, /export const RESULT_STATUSES = \[([\s\S]*?)\n\]/, 'RESULT_STATUSES in utils/automations.js');
  const jsStatuses = statuses && [...statuses[1].matchAll(/value: '([a-z]+)'/g)].map((m) => m[1]).sort();
  if (sqlStatuses && jsStatuses) {
    compare('automationsReads', `the statuses the preview draws and apply_automations() gives (${apply.file})`,
      jsStatuses.join(', '), sqlStatuses.join(', '));
  }
}

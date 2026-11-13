import { compare, lastDefinition, need, read } from './lib.mjs';

// 83. What marks an alert as an automation's, one prefix in four places (0255, 0271): the dashboard's
// isAutomationAlert() reads it, automation_alert_fingerprint() composes every trigger's fingerprint
// with it, evaluate_automations() names its own alert with it, and platform_alert_confirmation_window()
// gives it its window. A prefix one of them spells differently is an automation's alert opening
// Grafana, or a reminder that is never sent.
export default function check() {
  const js = need(read('frontend/src/constants.js'), /isAutomationAlert = \(alert\) => String\(alert\?\.fingerprint \?\? ''\)\.startsWith\('([^']+)'\)/,
    'isAutomationAlert() in constants.js');
  const compose = lastDefinition('CREATE OR REPLACE FUNCTION public.automation_alert_fingerprint(', '$$;', 'automation_alert_fingerprint()');
  const composed = compose && need(compose.body, /WHEN p_entity_id IS NULL OR p_metric_name IS NULL THEN '([^']+)' \|\|/,
    `automation_alert_fingerprint()'s prefix (${compose.file})`);
  const evaluator = lastDefinition('CREATE OR REPLACE FUNCTION public.evaluate_automations(', '$$;', 'evaluate_automations()');
  const own = evaluator && need(evaluator.body, /c_not_evaluated CONSTANT text := '([^']+)'/,
    `evaluate_automations()'s own fingerprint (${evaluator.file})`);
  const window = lastDefinition('CREATE OR REPLACE FUNCTION public.platform_alert_confirmation_window(', '$$;',
    'platform_alert_confirmation_window()');
  const windowed = window && need(window.body, /WHEN starts_with\(p_fingerprint, '([^']+)'\)/,
    `platform_alert_confirmation_window()'s condition: arm (${window.file})`);
  if (js && composed && own && windowed) {
    compare('automationAlertPrefix', `the dashboard's prefix and the one automation_alert_fingerprint() composes (${compose.file})`, js[1], composed[1]);
    compare('automationAlertPrefix', `the dashboard's prefix and the one the evaluator's own alert starts with (${evaluator.file})`,
      js[1], own[1].slice(0, js[1].length));
    compare('automationAlertPrefix', `the dashboard's prefix and the one the confirmation window answers for (${window.file})`, js[1], windowed[1]);
  }
}

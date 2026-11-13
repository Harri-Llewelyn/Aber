import { compare, lastDefinition, need, read } from './lib.mjs';

// 57. How long a Grafana alert's confirmation holds (0247). grafana-alert-webhook stamps
// last_confirmed_at on every post, and Grafana posts a firing alert again every repeat_interval
// (policies.yaml). platform_alert_confirmation_window() allows that interval plus a margin before an
// alert is reminded no more. A shorter window than the interval stops the reminders of every alert
// still firing; a longer one keeps reminding about a resolve that never arrived.
export default function check() {
  const policies = read('grafana/provisioning/alerting/policies.yaml');
  const repeat = need(policies, /^\s*repeat_interval:\s*(\d+)h\s*$/m, 'repeat_interval in grafana/provisioning/alerting/policies.yaml');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.platform_alert_confirmation_window(', '$$;',
    'platform_alert_confirmation_window()');
  const arm = fn && need(fn.body, /ELSE interval '(\d+) hours' \+ interval '(\d+) hours?'/,
    `platform_alert_confirmation_window()'s Grafana arm (${fn.file})`);
  if (repeat && arm) {
    compare('alertConfirmationWindow', `Grafana's repeat_interval (hours) and the window's interval (${fn.file})`, repeat[1], arm[1]);
  }
}

import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 45. An alert's acknowledgement reasons, one closed set in three places (0231): the CHECK on
// platform_alerts, acknowledge_alert()'s own refusal, and the dialog's list. A reason the dialog
// offers and the database lacks is refused on every save; one the database admits and the dialog
// lacks can never be chosen. Compared in order, so the dialog lists them as the CHECK does.
export default function check() {
  const check = need(SCHEMA, /ADD CONSTRAINT platform_alerts_acknowledgement_reason_valid CHECK \(\(acknowledgement_reason = ANY \(ARRAY\[([^\]]*)\]\)\)\)/,
    'platform_alerts_acknowledgement_reason_valid in the migrations');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.acknowledge_alert(', '$$;', 'acknowledge_alert()');
  const js = need(read('frontend/src/utils/alertAcknowledgement.js'),
    /export const ALERT_ACKNOWLEDGEMENT_REASONS = \[([\s\S]*?)\n\]/, 'ALERT_ACKNOWLEDGEMENT_REASONS in utils/alertAcknowledgement.js');
  const refused = fn && need(fn.body, /NOT p_reason = ANY \(ARRAY\[([^\]]*)\]\)/, `acknowledge_alert()'s list of reasons (${fn.file})`);
  if (check && refused && js) {
    const words = (list) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).join(', ');
    const offered = [...js[1].matchAll(/value: '([a-z_]+)'/g)].map((m) => m[1]).join(', ');
    compare('alertAcknowledgementReasons', 'the reasons the CHECK admits and the dialog offers', offered, words(check[1]));
    compare('alertAcknowledgementReasons', `the reasons acknowledge_alert() admits (${fn.file}) and the dialog offers`,
      offered, words(refused[1]));
  }
}

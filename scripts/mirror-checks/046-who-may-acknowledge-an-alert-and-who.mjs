import { compare, lastDefinition, need, read } from './lib.mjs';

// 46. Who may acknowledge an alert, and who may withdraw anyone's acknowledgement (0231). The alert
// counter offers Acknowledge and Withdraw by ALERT_ACKNOWLEDGE_ROLES and ALERT_WITHDRAW_ANY_ROLES; the
// functions decide by has_role(). A role the counter offers and the database refuses meets an
// error on every click; one it leaves out never sees the button.
export default function check() {
  const ack = lastDefinition('CREATE OR REPLACE FUNCTION public.acknowledge_alert(', '$$;', 'acknowledge_alert()');
  const withdraw = lastDefinition('CREATE OR REPLACE FUNCTION public.withdraw_alert_acknowledgement(', '$$;',
    'withdraw_alert_acknowledgement()');
  const js = read('frontend/src/utils/alertAcknowledgement.js');
  const jsAck = need(js, /export const ALERT_ACKNOWLEDGE_ROLES = \[([^\]]*)\]/, 'ALERT_ACKNOWLEDGE_ROLES');
  const jsAny = need(js, /export const ALERT_WITHDRAW_ANY_ROLES = \[([^\]]*)\]/, 'ALERT_WITHDRAW_ANY_ROLES');
  const roles = (list) => [...list.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]).sort().join(', ');
  if (ack && withdraw && jsAck && jsAny) {
    const ackSql = need(ack.body, /NOT public\.has_role\(ARRAY\[([^\]]*)\]\) THEN/, `acknowledge_alert()'s roles (${ack.file})`);
    const gateSql = need(withdraw.body, /NOT public\.has_role\(ARRAY\[([^\]]*)\]\) THEN/,
      `withdraw_alert_acknowledgement()'s callers (${withdraw.file})`);
    const anySql = need(withdraw.body, /IS DISTINCT FROM v_uid\s+AND NOT public\.has_role\(ARRAY\[([^\]]*)\]\)/,
      `withdraw_alert_acknowledgement()'s roles that withdraw anyone's (${withdraw.file})`);
    if (ackSql) compare('alertAcknowledgementRoles', 'the roles that may acknowledge', roles(jsAck[1]), roles(ackSql[1]));
    if (gateSql) compare('alertAcknowledgementRoles', 'the roles that may withdraw their own', roles(jsAck[1]), roles(gateSql[1]));
    if (anySql) compare('alertAcknowledgementRoles', "the roles that may withdraw anyone's", roles(jsAny[1]), roles(anySql[1]));
  }
}

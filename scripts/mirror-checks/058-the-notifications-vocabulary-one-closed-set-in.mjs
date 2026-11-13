import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 58. The Notifications vocabulary, one closed set in each place it is written (0247, 0248): the
// severities a route may name, as notification_setting_guard() admits them, notification_severity_carried()
// ranks them and the Settings page offers them; and the events a message may be, as the queue's CHECK
// admits them, the delivery log labels them and the dispatcher types them. A severity offered and
// refused fails every save; an event the log cannot name shows as its raw word.
export default function check() {
  const notifications = read('frontend/src/utils/notifications.js');
  const dispatch = read('supabase/functions/notification-dispatch/dispatch.ts');
  const guard = lastDefinition('CREATE OR REPLACE FUNCTION public.notification_setting_guard(', '$$;', 'notification_setting_guard()');
  const rank = lastDefinition('CREATE OR REPLACE FUNCTION public.notification_severity_carried(', '$$;',
    'notification_severity_carried()');
  const offered = need(notifications, /export const SEVERITIES = \[([\s\S]*?)\n\]/, 'SEVERITIES in utils/notifications.js');
  const admitted = guard && need(guard.body, /NOT \(NEW\.value #>> '\{\}'\) = ANY \(ARRAY\[([^\]]*)\]\)/,
    `notification_setting_guard()'s severities (${guard.file})`);
  const ranked = rank && need(rank.body, /array_position\(ARRAY\[([^\]]*)\], p_severity\)/,
    `notification_severity_carried()'s ranking (${rank.file})`);
  const words = (list) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).join(', ');
  if (offered && admitted && ranked) {
    const js = [...offered[1].matchAll(/value: '([a-z]+)'/g)].map((m) => m[1]).join(', ');
    compare('notificationSeverities', `the severities the page offers and the guard admits (${guard.file})`, js, words(admitted[1]));
    compare('notificationSeverities', `the severities the page offers and the route ranks, lowest first (${rank.file})`, js, words(ranked[1]));
  }

  const check = need(SCHEMA, /CONSTRAINT notification_deliveries_event_valid\s+CHECK \(\(event = ANY \(ARRAY\[([^\]]*)\]\)\)\)/,
    'notification_deliveries_event_valid in the migrations');
  const labels = need(notifications, /export const EVENT_LABELS = \{([^}]*)\}/, 'EVENT_LABELS in utils/notifications.js');
  const typed = need(dispatch, /export type Event = ([^;]*);/, 'the Event type in notification-dispatch/dispatch.ts');
  if (check && labels && typed) {
    const sql = words(check[1].replace(/::text/g, ''));
    compare('notificationEvents', 'the events the delivery log labels and the queue admits',
      [...labels[1].matchAll(/([a-z]+):/g)].map((m) => m[1]).join(', '), sql);
    compare('notificationEvents', 'the events the dispatcher types and the queue admits',
      [...typed[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).join(', '), sql);
  }
}

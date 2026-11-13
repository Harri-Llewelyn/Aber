import { compare, lastDefinition, need, problems, read, SCHEMA } from './lib.mjs';

// 76. The channels a message may go down, one closed set in each place it is written (0247, 0262):
// the queue's CHECK admits them, the delivery log names each, notification_channel_is_configured()
// has an arm for each, and notification_channel_reaches() says which alerts each may carry. A
// channel the log cannot name shows as its raw word; one the configured test lacks is queued
// for never or always, and its messages wait or fail with no sentence.
export default function check() {
  const notifications = read('frontend/src/utils/notifications.js');
  // The last declaration stands: 0247 creates the table with one channel and 0262 replaces the CHECK.
  const declared = [...SCHEMA.matchAll(/CONSTRAINT notification_deliveries_channel_valid\s+CHECK \(\(channel = ANY \(ARRAY\[([^\]]*)\]\)\)\)/g)];
  const check = declared.length ? declared[declared.length - 1] : null;
  if (!check) problems.push('notificationChannels: found no notification_deliveries_channel_valid in the migrations -- the shape this check reads has changed');
  const labels = need(notifications, /export const CHANNEL_LABELS = \{([^}]*)\}/, 'CHANNEL_LABELS in utils/notifications.js');
  const configured = lastDefinition('CREATE OR REPLACE FUNCTION public.notification_channel_is_configured(', '$;',
    'notification_channel_is_configured()');
  const reaches = lastDefinition('CREATE OR REPLACE FUNCTION public.notification_channel_reaches(', '$;',
    'notification_channel_reaches()');
  const words = (list) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).join(', ');
  if (check && labels) {
    const sql = words(check[1].replace(/::text/g, ''));
    compare('notificationChannels', 'the channels the delivery log labels and the queue admits',
      [...labels[1].matchAll(/([a-z]+):/g)].map((m) => m[1]).join(', '), sql);
    if (configured) {
      compare('notificationChannels', `the channels the queue admits and notification_channel_is_configured() has an arm for (${configured.file})`,
        sql, [...configured.body.matchAll(/WHEN '([a-z]+)' THEN/g)].map((m) => m[1]).join(', '));
    }
    if (reaches) {
      compare('notificationChannels', `the channels the queue admits and notification_channel_reaches() rules on (${reaches.file})`,
        sql, [...reaches.body.matchAll(/WHEN '([a-z]+)' THEN/g)].map((m) => m[1]).join(', '));
    }
  }
}

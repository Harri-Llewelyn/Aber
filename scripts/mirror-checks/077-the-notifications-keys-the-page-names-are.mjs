import { compare, lastDefinition, problems, read, SCHEMA } from './lib.mjs';

// 77. The Notifications keys the page names are the keys the migrations seed, and the guard checks
// each: a key the page reads that nothing seeds is an empty read, and one the guard does not name
// takes any value an Administrator types, which the dispatcher then reads as it can.
export default function check() {
  const notifications = read('frontend/src/utils/notifications.js');
  const guard = lastDefinition('CREATE OR REPLACE FUNCTION public.notification_setting_guard(', '$;', 'notification_setting_guard()');
  const named = [...notifications.matchAll(/^export const [A-Z_]+_KEY = '(notifications\.[a-z_]+)'$/gm)].map((m) => m[1]).sort();
  const seeded = [...SCHEMA.matchAll(/seed_setting\(\s*'(notifications\.[a-z_]+)'/g)].map((m) => m[1]).sort();
  if (!named.length) {
    problems.push('notificationKeys: found no notifications.* key in utils/notifications.js -- the shape this check reads has changed');
  } else {
    compare('notificationKeys', 'the Notifications keys the page names and the migrations seed', named.join(', '), seeded.join(', '));
    if (guard) {
      // A setting that counts whole things is held by system_settings_whole_number_guard() (0285), which
      // is no arm of this one.
      const whole = [...(SCHEMA.match(/v_whole text\[\] := ARRAY\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'(notifications\.[a-z_]+)'/g)].map((m) => m[1]);
      const guarded = [...new Set([...guard.body.matchAll(/WHEN '(notifications\.[a-z_]+)' THEN/g)].map((m) => m[1]).concat(whole))].sort();
      compare('notificationKeys', `the Notifications keys the page names and the guards check (${guard.file}, and 0285's whole-number guard)`, named.join(', '), guarded.join(', '));
    }
  }
}

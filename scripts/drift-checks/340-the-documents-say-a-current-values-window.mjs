import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 340. The documents say a current value's window as derived_window_minutes() holds it. The automation
// reference gives one row for each kind, an hour or the last whole minute by what the function
// answers; the Devices help says both phrases the drawer shows. A document that says an hour where
// the function reads a minute describes a value the alert does not compare.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const migration = read('supabase/migrations/0282_history_draws_a_derived_metric_from_the_minutes.sql');
  const windows = new Map([...migration.matchAll(/WHEN '([a-z_]+)' THEN (\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const automations = read('docs/automations.md').match(/### A threshold on a derived metric\n([\s\S]*?)\n### /)?.[1];
  const devices = read('help/pages/devices.md');
  const words = { counter_rate: 'Counter rate', time_in_state: 'Time in state', sum: 'Sum or difference' };
  const problems340 = [];
  if (windows.size === 0) problems340.push('could not read derived_window_minutes() out of 0282');
  if (!automations) problems340.push('docs/automations.md has no "A threshold on a derived metric"');
  if (!problems340.length) {
    for (const [kind, minutes] of windows) {
      const row = automations.match(new RegExp(`^\\| ${words[kind]} \\|(.*)\\|$`, 'm'))?.[1];
      if (!row) {
        problems340.push(`docs/automations.md has no row for ${words[kind]}`);
        continue;
      }
      const wants = minutes === 0 ? 'last whole minute' : 'last hour';
      if (!row.includes(wants)) problems340.push(`docs/automations.md says a ${words[kind]} is judged ${row.trim()}; derived_window_minutes() is ${minutes}, so it is the ${wants}`);
    }
    for (const phrase of ['over the last hour', 'at the last whole minute']) {
      if (!devices.includes(phrase)) problems340.push(`help/pages/devices.md does not say "${phrase}", which the drawer shows`);
    }
  }
  if (problems340.length) {
    fail("The documents say a derived metric's current value otherwise than derived_window_minutes() holds it:\n" +
      problems340.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the automation reference and the Devices help say each kind's window as derived_window_minutes() holds it (${[...windows].map(([k, m]) => `${k} ${m}`).join(', ')})`);
  }
}

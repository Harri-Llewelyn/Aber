import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 10d2. The Realtime publication lists every table the frontend subscribes to.
//
// The baseline applies the publication with an absolute `SET TABLE` from its `intended` list, so a
// table published anywhere else is dropped on the next replay. A subscription to an unpublished
// table delivers nothing and raises no error: the page just goes on polling. The squash dropped the
// Capture page's two job tables this way.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const baseline = read('supabase/migrations/0001_baseline_schema.sql');
  const listed = /intended CONSTANT text\[\] := ARRAY\[([^\]]*)\]/.exec(baseline);
  const published = new Set(listed ? [...listed[1].matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]) : []);

  // Every `useRealtimeTable([...])` call, and every `table: '...'` filter of a postgres_changes
  // subscription made straight on a channel.
  const subscribed = new Map();
  const note = (table, file) => subscribed.set(table, [...(subscribed.get(table) || []), file]);
  for (const file of allFiles.filter((f) => /^frontend\/src\/.*\.(jsx?|tsx?)$/.test(f)
    && !/__tests__|\.test\./.test(f))) {
    const src = read(file);
    for (const m of src.matchAll(/useRealtimeTable\(\s*\[([^\]]*)\]/g)) {
      for (const t of m[1].matchAll(/'([a-z_0-9]+)'/g)) note(t[1], file);
    }
    if (src.includes('postgres_changes')) {
      for (const m of src.matchAll(/\btable:\s*'([a-z_0-9]+)'/g)) note(m[1], file);
    }
  }

  if (!published.size) {
    fail('Could not read the `intended` list from the baseline\'s realtime publication block.\n'
      + '      Update the pattern in check 10d2 to match it, or this check passes nothing.');
  } else if (!subscribed.size) {
    fail('No Realtime subscription found under frontend/src. Update the patterns in check 10d2.');
  } else {
    const missing = [...subscribed].filter(([t]) => !published.has(t));
    if (missing.length) {
      fail(`The frontend subscribes to table(s) the supabase_realtime publication does not list: `
        + `${missing.map(([t, fs]) => `${t} (${[...new Set(fs)].join(', ')})`).join('; ')}.\n`
        + '      Such a subscription delivers nothing and raises no error. Add the table to\n'
        + '      `intended` in supabase/migrations/0001_baseline_schema.sql, section 5: the\n'
        + '      publication is applied there with an absolute SET TABLE, so a table published\n'
        + '      only where it is created is removed again on the next replay.');
    } else {
      pass(`all ${subscribed.size} tables the frontend subscribes to are in the realtime publication`);
    }
  }
}

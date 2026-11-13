import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 12. Nothing seeds an asset or a metric. A migration that inserts a cell, a gateway, a device or a
// catalog metric puts it on every install on the next boot. The Playback gateway is the one
// exemption: a recorded capture has nowhere else to publish from, it is `is_shadow`, and it cannot
// be archived away. Example metrics are supabase/example-metrics.sql, applied only on request.
// -------------------------------------------------------------------------------------------------
export default function check() {
  // The exemption is the gateway's id, not the file it lives in: exempting 0002 by name would
  // exempt the whole seed file.
  const PLAYBACK_ID = '16000000-0000-4000-8000-000000000001';
  const offenders = [];

  for (const file of readdirSync(join(REPO, 'supabase/migrations')).filter((f) => f.endsWith('.sql'))) {
    const text = read(join('supabase/migrations', file));
    // TOP-LEVEL INSERTs ONLY, anchored to the start of a line. A function body that inserts on
    // demand is not a seed -- `relocate_devices()` and the enrolment path both insert, and what
    // they insert is what a user asked for. Those sit indented inside their definitions.
    for (const m of text.matchAll(/^INSERT INTO (?:public[.])?(cells|gateways|devices|metric_catalog)(?![A-Za-z_])/gm)) {
      // The statement, not the file: an INSERT runs to its terminating semicolon, and the
      // exemption applies only if THIS one names the Playback gateway.
      const stmt = text.slice(m.index, text.indexOf(';', m.index) + 1);
      if (m[1] === 'gateways' && stmt.includes(PLAYBACK_ID)) continue;
      offenders.push(`${file} seeds public.${m[1]}`);
    }
  }

  if (offenders.length) {
    fail(
      [
        'a migration seeds shopfloor assets or catalog metrics:',
        ...offenders.map((o) => `        ${o}`),
        '      A fresh install has no cells, no gateways, no devices and no metrics. A seeded row comes',
        '      back on EVERY boot, on every install, which is what the demonstration floor was retired',
        '      for. Example metrics belong in supabase/example-metrics.sql (dbInit.exampleMetrics).',
      ].join(String.fromCharCode(10))
    );
  } else {
    pass('no migration seeds a cell, a gateway, a device or a metric (the Playback gateway aside)');
  }
}

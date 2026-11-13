import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 71. The Playback gateway is never reported stale, and its replay lanes are never expected to
// publish. The last declaration of platform_health_rows() keeps `NOT g.is_shadow` in its
// gateway_stale arm (archived migration 0061 added it, 0074 lost it in a redeclaration, 0182 put it
// back) and in its expected_publishers arm (0185). Comments are stripped, so only the SQL counts.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const declaration = /CREATE OR REPLACE FUNCTION\s+public\.platform_health_rows\s*\(\)[\s\S]*?\bAS\s+(\$[a-z_]*\$)([\s\S]*?)\1/gi;
  let last = null;
  for (const name of files) {
    for (const m of read(`${dir}/${name}`).matchAll(declaration)) last = { name, body: m[2] };
  }
  const why = {
    gateway_stale:
      'Nothing publishes as the Playback gateway between playbacks, so Gateway Stale would fire after\n' +
      '      every replay and teach an operator to ignore it. 0074 dropped the line this way; keep it in\n' +
      '      every redeclaration (0182).',
    expected_publishers:
      'A replay leaves its lanes with a first DBIRTH behind a gateway that has reported, so they would\n' +
      '      count as devices that should be publishing, and the critical Ingestion Consuming Nothing would\n' +
      '      fire after every replay on a stack with no other devices (0185).',
  };
  const sql = last && last.body.replace(/--[^\n]*/g, '');
  const held = [];
  for (const [condition, reason] of Object.entries(why)) {
    const arm = sql && sql.match(new RegExp(`'${condition}'::text[\\s\\S]*?(?=\\bUNION\\s+ALL\\b|$)`, 'i'));
    if (!arm) {
      fail(`no applied migration declares a ${condition} arm in public.platform_health_rows()${last ? ` (last declared in ${last.name})` : ''}, so check 71 compares nothing`);
    } else if (!/\bNOT\s+g\.is_shadow\b/i.test(arm[0])) {
      fail(`${last.name} declares platform_health_rows() last, and its ${condition} arm has no \`AND NOT g.is_shadow\`.\n      ${reason}`);
    } else {
      held.push(condition);
    }
  }
  if (held.length === Object.keys(why).length) {
    pass(`platform_health_rows()'s last declaration (${last.name}) keeps shadow gateways out of ${held.join(' and ')}`);
  }
}

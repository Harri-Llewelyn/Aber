import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 90. Only the seed makes a playback gateway, and only ensure_shadow_devices() makes a replay lane.
// gateways.is_shadow decides which broker password the playback worker is given and which gateway a
// replay may publish as, and devices.shadow_of decides which device a replay may publish as. So
// only 0002 writes the flag, and the one function that writes shadow_of is ensure_shadow_devices().
// Neither column is sent by the dashboard, and trg_gateways_playback_flag_is_seeded and
// trg_devices_replay_lane_stays_as_minted are stated and refuse them to every role the API runs as.
// A second way to mint either, such as a function for Administrators, is a decision to take in the
// open: add it to this check with its reason, as check 65 does for the vault.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const writers = files.filter((name) => {
    const text = read(`${dir}/${name}`);
    return /\bis_shadow\s*=\s*(true|false)\b/i.test(text)
      || /INSERT INTO public\.gateways\s*\([^)]*\bis_shadow\b/i.test(text);
  });
  const stated = (table, trigger) => files.filter((name) => read(`${dir}/${name}`).includes(`replay_trigger('public.${table}', '${trigger}'`));
  const flagGuard = stated('gateways', 'trg_gateways_playback_flag_is_seeded');
  const laneGuard = stated('devices', 'trg_devices_replay_lane_stays_as_minted');
  // Every statement that writes devices.shadow_of, with the function it sits in.
  const LANE_WRITERS = ['public.ensure_shadow_devices'];
  const strays = [];
  for (const name of files) {
    const text = read(`${dir}/${name}`);
    for (const m of text.matchAll(/INSERT INTO public\.devices\s*\(([^)]*)\)|UPDATE public\.devices\b([^;]*);/gi)) {
      const writes = m[1] !== undefined
        ? /\bshadow_of\b/.test(m[1])
        : /\bshadow_of\b/.test(m[2].split(/\bWHERE\b/i)[0]);
      if (!writes) continue;
      const inside = [...text.slice(0, m.index).matchAll(/CREATE OR REPLACE FUNCTION\s+([a-z_]+\.[a-z_]+)/gi)].pop();
      const fn = inside ? inside[1].toLowerCase() : 'no function';
      if (!LANE_WRITERS.includes(fn)) strays.push(`${name} (${fn})`);
    }
  }
  const api = read('frontend/src/api.js');
  const sends = /\bis_shadow\s*:/.test(api) ? 'is_shadow' : /\bshadow_of\s*:/.test(api) ? 'shadow_of' : null;
  if (writers.join() !== '0002_seed_data.sql') {
    fail(`the files that write gateways.is_shadow are ${writers.join(', ') || 'none'}, and must be 0002_seed_data.sql alone: `
      + 'only the seed makes a playback gateway (0187), so a function that mints one belongs in this check with its reason');
  } else if (strays.length) {
    fail(`devices.shadow_of is written outside ensure_shadow_devices() by ${strays.join(', ')}: only that function makes a replay lane (0187), `
      + 'so a function that writes it belongs in this check with its reason');
  } else if (!flagGuard.length || !laneGuard.length) {
    fail('no applied migration states ' + [!flagGuard.length && 'trg_gateways_playback_flag_is_seeded', !laneGuard.length && 'trg_devices_replay_lane_stays_as_minted'].filter(Boolean).join(' or ')
      + ', so a Shopfloor Manager can mark a gateway a playback target or a device a replay lane');
  } else if (sends) {
    fail(`frontend/src/api.js builds a request body with ${sends}: the API refuses it (0187), so the dashboard must never send it`);
  } else {
    pass(`gateways.is_shadow is written by ${writers[0]} alone and devices.shadow_of by ${LANE_WRITERS[0]}() alone, `
      + `both refused to the API (${flagGuard[0]}, ${laneGuard[0]}) and never sent by the dashboard`);
  }
}

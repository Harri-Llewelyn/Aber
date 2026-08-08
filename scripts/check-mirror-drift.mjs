/**
 * Hold the SQL-to-JavaScript mirrors together by comparing the VALUES both sides declare.
 *
 * WHY VALUES AND NOT A grep. The existing sync steps in ci.yml assert that a characteristic
 * literal is PRESENT on both sides, which catches a rewrite and misses a re-tuning: change
 * `INTERVAL '90 seconds'` to 120 and every "does this file mention a threshold" check still
 * passes. This session already produced the sharper version of that lesson elsewhere -- a CI check
 * that restated `fsGroup: 999` agreed perfectly with a values.yaml that was also wrong, for months.
 * So each mirror below is parsed on both sides and the two answers are compared.
 *
 * WHAT IS NOT HERE. The `modelledMetrics` mirror is behaviour rather than a literal and could not
 * be checked this way; it has a fixture contract instead
 * (`tests/fixtures/modelled-metrics.json`, asserted by a vitest suite and a unittest suite). It is
 * the one that found a live divergence, which is the argument for behavioural contracts wherever
 * they are affordable.
 *
 * Usage: node scripts/check-mirror-drift.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** The applied baseline only. `archive/` is the pre-beta chain and never executes. */
const SCHEMA = read('supabase/migrations/0001_baseline_schema.sql');

const problems = [];
const ok = [];

const need = (source, re, what) => {
  const m = source.match(re);
  if (!m) {
    problems.push(`could not find ${what} — the file's shape changed, so this check is no longer checking anything`);
    return null;
  }
  return m;
};

const compare = (mirror, label, jsValue, sqlValue) => {
  if (String(jsValue) !== String(sqlValue)) {
    problems.push(`${mirror}: ${label} disagree — JS has ${JSON.stringify(jsValue)}, SQL has ${JSON.stringify(sqlValue)}`);
  } else {
    ok.push(`${mirror}: ${label} = ${JSON.stringify(jsValue)}`);
  }
};

// -------------------------------------------------------------------------------------------------
// 1. Sparkplug id derivation — the one that matters most.
//
// It derives an IMMUTABLE WIRE IDENTITY. A divergence produces ids that resolve in the UI and not
// on the wire, and because `sparkplug_id` is `GENERATED ALWAYS ... STORED` off the row's UUID, the
// values already issued cannot be corrected -- every device would have to be re-provisioned.
// -------------------------------------------------------------------------------------------------
{
  const js = read('frontend/src/utils/sparkplugId.js');
  const jsDevice = need(js, /DEVICE_ID_PREFIX\s*=\s*'([^']+)'/, 'DEVICE_ID_PREFIX in sparkplugId.js');
  const jsGateway = need(js, /GATEWAY_ID_PREFIX\s*=\s*'([^']+)'/, 'GATEWAY_ID_PREFIX in sparkplugId.js');
  const jsHex = need(js, /HEX_CHARS\s*=\s*(\d+)/, 'HEX_CHARS in sparkplugId.js');
  const jsLength = need(js, /SPARKPLUG_ID_LENGTH\s*=\s*(\d+)/, 'SPARKPLUG_ID_LENGTH in sparkplugId.js');
  const jsRegex = need(js, /SPARKPLUG_ID_REGEX\s*=\s*\/\^\(([a-z|]+)\)\[0-9a-f\]\{(\d+)\}\$\//, 'SPARKPLUG_ID_REGEX in sparkplugId.js');

  // e.g. ('dev'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21))
  const generated = [...SCHEMA.matchAll(
    /sparkplug_id text GENERATED ALWAYS AS \(\('([a-z]+)'::text \|\| substr\(encode\(uuid_send\(id\), 'hex'::text\), 1, (\d+)\)\)\) STORED/g
  )];
  if (generated.length !== 2) {
    problems.push(`sparkplugId: expected 2 generated sparkplug_id columns (devices, gateways) in 0001, found ${generated.length}`);
  } else if (jsDevice && jsGateway && jsHex && jsLength && jsRegex) {
    const sqlPrefixes = generated.map((m) => m[1]).sort();
    const sqlWidths = [...new Set(generated.map((m) => m[2]))];
    compare('sparkplugId', 'type prefixes', [jsDevice[1], jsGateway[1]].sort().join(','), sqlPrefixes.join(','));
    if (sqlWidths.length !== 1) {
      problems.push(`sparkplugId: the two generated columns disagree on hex width: ${sqlWidths.join(' vs ')}`);
    } else {
      compare('sparkplugId', 'hex character count', jsHex[1], sqlWidths[0]);
      // Internal consistency: 3-character prefix + hex width must be the declared total, and the
      // regex must agree with both. A wrong total silently breaks length-based validation.
      compare('sparkplugId', 'total id length', jsLength[1], String(jsDevice[1].length + Number(sqlWidths[0])));
      compare('sparkplugId', 'regex hex width', jsRegex[2], sqlWidths[0]);
      compare('sparkplugId', 'regex prefixes', jsRegex[1].split('|').sort().join(','), sqlPrefixes.join(','));
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 2. Gateway staleness. Derived at READ TIME on both sides -- a view, not a cron writer -- so the
// two thresholds must agree or the dashboard and the database disagree about which gateways are up.
// -------------------------------------------------------------------------------------------------
{
  const js = read('frontend/src/utils/gatewayStatus.js');
  // 90_000 -- numeric separators are legal JS and must be stripped before parsing.
  const jsMs = need(js, /HEARTBEAT_STALE_MS\s*=\s*([\d_]+)/, 'HEARTBEAT_STALE_MS in gatewayStatus.js');

  // The view is built INSIDE `ensure_gateway_status_view()`, not by a top-level CREATE VIEW --
  // `CREATE OR REPLACE VIEW` cannot widen a `g.*` view in place, so 0001 wraps a DROP + CREATE in
  // a function that later migrations call after adding a gateways column. Anchor on the function.
  const viewStart = SCHEMA.indexOf('CREATE OR REPLACE FUNCTION public.ensure_gateway_status_view()');
  if (viewStart < 0) {
    problems.push('gatewayStatus: public.ensure_gateway_status_view() not found in 0001');
  } else if (jsMs) {
    // Scoped to the function body: 0001 carries other intervals (pg_cron retention) that are
    // unrelated, and would make any repo-wide search meaningless.
    const body = SCHEMA.slice(viewStart, SCHEMA.indexOf('$$;', viewStart));
    const intervals = [...new Set([...body.matchAll(/INTERVAL '(\d+) seconds'/g)].map((m) => m[1]))];
    if (intervals.length === 0) {
      problems.push('gatewayStatus: no `INTERVAL \'N seconds\'` in the gateway_status view body');
    } else if (intervals.length > 1) {
      // live_status and is_stale must use one threshold, or a gateway can be STALE and not is_stale.
      problems.push(`gatewayStatus: the view uses more than one threshold: ${intervals.join(', ')} seconds`);
    } else {
      compare('gatewayStatus', 'staleness threshold (ms)', Number(jsMs[1].replace(/_/g, '')), Number(intervals[0]) * 1000);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 3. Effective cell resolution. `NULL cell_id means INHERIT`, so the COALESCE PRECEDENCE is the
// rule: device first, gateway second. Reversed, an explicit override would lose to the value it
// was set to override -- and the UI would still show the override, because the JS resolves it
// separately from the view.
// -------------------------------------------------------------------------------------------------
{
  const js = read('frontend/src/utils/cellResolution.js');
  const viewStart = SCHEMA.indexOf('CREATE OR REPLACE VIEW public.device_locations');
  if (viewStart < 0) {
    problems.push('cellResolution: public.device_locations view not found in 0001');
  } else {
    const body = SCHEMA.slice(viewStart, SCHEMA.indexOf(';', viewStart));

    const sqlCoalesce = need(body, /COALESCE\((\w)\.cell_id,\s*(\w)\.cell_id\)/, 'COALESCE precedence in device_locations');
    if (sqlCoalesce) {
      compare('cellResolution', 'COALESCE precedence', 'device,gateway',
        `${sqlCoalesce[1] === 'd' ? 'device' : 'gateway'},${sqlCoalesce[2] === 'g' ? 'gateway' : 'device'}`);
    }

    // The site_wide branch must resolve to NO cell on both sides, not to an inherited one.
    const sqlSiteWideNulls = /WHEN \(d\.location_scope = 'site_wide'::text\) THEN NULL::uuid/.test(body.replace(/\s+/g, ' '));
    const jsSiteWideNulls = /scope === SCOPE_SITE_WIDE \? null :/.test(js);
    if (!sqlSiteWideNulls || !jsSiteWideNulls) {
      problems.push(`cellResolution: the site_wide branch must resolve to no cell on both sides (SQL ${sqlSiteWideNulls ? 'ok' : 'MISSING'}, JS ${jsSiteWideNulls ? 'ok' : 'MISSING'})`);
    } else {
      ok.push('cellResolution: site_wide resolves to no cell on both sides');
    }

    // The four location_source labels are a closed set the UI switches on.
    // `THEN` and `ELSE`: 'unassigned' is the CASE's fall-through, so a THEN-only pattern silently
    // reports three labels where there are four -- the check would then pass whenever the JS
    // dropped that constant too.
    const sqlSources = [...new Set([...body.matchAll(/(?:THEN|ELSE) '(site_wide|explicit|inherited|unassigned)'::text/g)].map((m) => m[1]))].sort();
    const jsSources = [...new Set([...js.matchAll(/export const SOURCE_[A-Z_]+ = '([a-z_]+)'/g)].map((m) => m[1]))].sort();
    compare('cellResolution', 'location_source labels', jsSources.join(','), sqlSources.join(','));
  }
}

for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error('\nSQL-to-JavaScript mirror drift:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nThese pairs answer the same question in two languages because one runs in a browser');
  console.error('and one in PostgreSQL. A divergence is silent: both sides keep working, and disagree.');
  process.exit(1);
}
console.log(`\nAll ${ok.length} mirrored values agree between 0001_baseline_schema.sql and frontend/src/utils/.`);

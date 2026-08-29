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
 * be checked this way; it has a fixture contract instead (`tests/fixtures/modelled-metrics.json`),
 * asserted by a vitest suite, two unittest suites and a static parse of the edge function. It is
 * the one that found a live divergence, which is the argument for behavioural contracts wherever
 * they are affordable.
 *
 * Usage: node scripts/check-mirror-drift.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const problems = [];
const ok = [];

/**
 * THE WHOLE APPLIED CHAIN, IN FILENAME ORDER -- which is the order db-init replays it in, and
 * therefore the order that decides what is actually running.
 *
 * IT USED TO BE `0001_baseline_schema.sql` ALONE, and that quietly stopped being true. There is no
 * applied-migrations ledger: every file is replayed on every boot, so a later `CREATE OR REPLACE
 * FUNCTION` of the same name simply wins. `ensure_gateway_status_view()` is declared in 0001 AND
 * redeclared in 0025 -- which widens the view for the enrolment columns and adds the branch that
 * short-circuits the lifecycle states -- so the definition this script was reading had been dead
 * since 0025 landed.
 *
 * It passed anyway, because both bodies happen to say `INTERVAL '90 seconds'`. Retune the LIVE one
 * in 0025 and leave 0001 alone and it would go on passing, while PostgreSQL and the browser
 * disagreed about which gateways are up -- precisely the silent divergence this file exists to
 * catch. A guard reading a definition the boot sequence replaces is worse than no guard: it
 * reports an agreement it did not check.
 *
 * `archive/` stays out. readdirSync is top-level only, so the pre-beta chain -- which never
 * executes -- is excluded structurally rather than by a filter someone could forget.
 */
const MIGRATION_DIR = 'supabase/migrations';
const MIGRATION_FILES = readdirSync(join(ROOT, MIGRATION_DIR))
  .filter((name) => /^[0-9]{4}_.*\.sql$/.test(name))
  .sort();

if (MIGRATION_FILES.length === 0) {
  console.error('No applied migrations found in supabase/migrations/. Nothing to check against.');
  process.exit(1);
}

/** Every applied migration, in replay order, each headed by a marker naming its file. */
const SCHEMA = MIGRATION_FILES
  .map((name) => `-- >>> ${name}\n${read(`${MIGRATION_DIR}/${name}`)}`)
  .join('\n');

/**
 * The body of the LAST definition matching `needle`, and which migration it came from.
 *
 * "Last" is the whole point: an earlier declaration is overwritten on every boot, so comparing
 * against one compares against something no database ever runs.
 *
 * `endMarker` bounds the body -- `$$;` for a function, `;` for a plain view. Scoping matters:
 * 0001 carries unrelated `INTERVAL` literals (pg_cron retention) that would make a whole-file
 * search meaningless.
 *
 * `redeclarations` is reported alongside, so the output says which file was actually read rather
 * than leaving the reader to assume it was the first.
 */
const lastDefinition = (needle, endMarker, what) => {
  const at = SCHEMA.lastIndexOf(needle);
  if (at < 0) {
    problems.push(
      `could not find ${what} in any applied migration -- the file's shape changed, so this check is no longer checking anything`
    );
    return null;
  }
  const stop = SCHEMA.indexOf(endMarker, at);
  const preceding = SCHEMA.slice(0, at);
  const marker = preceding.lastIndexOf('-- >>> ');
  const file = marker < 0 ? '(unknown)' : preceding.slice(marker + 7, preceding.indexOf('\n', marker));
  let redeclarations = 0;
  for (let i = SCHEMA.indexOf(needle); i >= 0; i = SCHEMA.indexOf(needle, i + 1)) redeclarations += 1;
  return { body: SCHEMA.slice(at, stop < 0 ? undefined : stop), file, redeclarations };
};

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
  //
  // A generated column cannot be replaced by a later migration -- ALTER TABLE would have to drop
  // and re-add it, which is not something any migration here does -- so scanning the whole chain
  // must still find exactly the two in 0001. More than two would mean a second table grew one.
  const generated = [...SCHEMA.matchAll(
    /sparkplug_id text GENERATED ALWAYS AS \(\('([a-z]+)'::text \|\| substr\(encode\(uuid_send\(id\), 'hex'::text\), 1, (\d+)\)\)\) STORED/g
  )];
  if (generated.length !== 2) {
    problems.push(`sparkplugId: expected 2 generated sparkplug_id columns (devices, gateways) across the applied chain, found ${generated.length}`);
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
//
// The view is built INSIDE `ensure_gateway_status_view()`, not by a top-level CREATE VIEW:
// `CREATE OR REPLACE VIEW` cannot widen a `g.*` view in place, so 0001 wraps a DROP + CREATE in a
// function that later migrations call after adding a gateways column. 0025 is the latest to do so,
// and its body is the one that runs.
// -------------------------------------------------------------------------------------------------
{
  const js = read('frontend/src/utils/gatewayStatus.js');
  // 90_000 -- numeric separators are legal JS and must be stripped before parsing.
  const jsMs = need(js, /HEARTBEAT_STALE_MS\s*=\s*([\d_]+)/, 'HEARTBEAT_STALE_MS in gatewayStatus.js');

  const view = lastDefinition(
    'CREATE OR REPLACE FUNCTION public.ensure_gateway_status_view()',
    '$$;',
    'public.ensure_gateway_status_view()'
  );

  if (view && jsMs) {
    const intervals = [...new Set([...view.body.matchAll(/INTERVAL '(\d+) seconds'/g)].map((m) => m[1]))];
    if (intervals.length === 0) {
      problems.push(`gatewayStatus: no \`INTERVAL 'N seconds'\` in the gateway_status view body (${view.file})`);
    } else if (intervals.length > 1) {
      // live_status and is_stale must use one threshold, or a gateway can be STALE and not is_stale.
      problems.push(`gatewayStatus: the view uses more than one threshold: ${intervals.join(', ')} seconds (${view.file})`);
    } else {
      compare('gatewayStatus', `staleness threshold (ms), from ${view.file}`, Number(jsMs[1].replace(/_/g, '')), Number(intervals[0]) * 1000);
    }

    // ---------------------------------------------------------------------------------------------
    // The enrolment lifecycle states, added by 0025 and mirrored by gatewayLiveStatus().
    //
    // THEY MUST SHORT-CIRCUIT AHEAD OF THE STALENESS ARM ON BOTH SIDES, and that ordering is the
    // property worth pinning rather than the strings. A gateway in AWAITING_BIRTH has a
    // `last_heartbeat` from its previous life -- minutes or months old -- so a staleness test
    // reached first reports STALE for an appliance that is enrolled and simply has not published
    // yet. PENDING_ENROLLMENT survives a wrong order by luck (it has never beaten, so
    // last_heartbeat is NULL); AWAITING_BIRTH does not, which is why luck is not the mechanism.
    // ---------------------------------------------------------------------------------------------
    const sqlStates = [...new Set(
      [...view.body.matchAll(/'(PENDING_ENROLLMENT|AWAITING_BIRTH)'/g)].map((m) => m[1])
    )].sort();
    const jsStates = [...new Set(
      [...js.matchAll(/export const GATEWAY_STATUS_[A-Z_]+ = '(PENDING_ENROLLMENT|AWAITING_BIRTH)'/g)].map((m) => m[1])
    )].sort();
    compare('gatewayStatus', 'enrolment lifecycle states', jsStates.join(','), sqlStates.join(','));

    if (sqlStates.length === 2) {
      // Position, not presence. In the SQL the states must appear in a WHEN branch BEFORE the
      // INTERVAL comparison; in the JS the same states must be returned before isHeartbeatStale()
      // is consulted. Either one reordered is a gateway mid-installation reported as a fault.
      const sqlLifecycleAt = view.body.search(/WHEN[^\n]*PENDING_ENROLLMENT/);
      const sqlStaleAt = view.body.search(/INTERVAL '\d+ seconds'/);
      const jsLifecycleAt = js.search(/GATEWAY_STATUS_PENDING_ENROLMENT|PENDING_ENROLLMENT/);
      const jsStaleAt = js.search(/isHeartbeatStale\(/);
      const sqlFirst = sqlLifecycleAt >= 0 && sqlStaleAt >= 0 && sqlLifecycleAt < sqlStaleAt;
      const jsFirst = jsLifecycleAt >= 0 && jsStaleAt >= 0 && jsLifecycleAt < jsStaleAt;
      if (!sqlFirst || !jsFirst) {
        problems.push(
          `gatewayStatus: the enrolment states must be decided BEFORE the staleness test on both sides ` +
            `(SQL ${sqlFirst ? 'ok' : 'WRONG ORDER'} in ${view.file}, JS ${jsFirst ? 'ok' : 'WRONG ORDER'}). ` +
            `An AWAITING_BIRTH gateway carries a stale last_heartbeat from its previous life and would report STALE.`
        );
      } else {
        ok.push('gatewayStatus: enrolment states short-circuit ahead of staleness on both sides');
      }
    }

    if (view.redeclarations > 1) {
      ok.push(`gatewayStatus: read the LAST of ${view.redeclarations} declarations of ensure_gateway_status_view() (${view.file})`);
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
  const view = lastDefinition(
    'CREATE OR REPLACE VIEW public.device_locations',
    ';',
    'public.device_locations'
  );

  if (view) {
    const body = view.body;

    const sqlCoalesce = need(body, /COALESCE\((\w)\.cell_id,\s*(\w)\.cell_id\)/, 'COALESCE precedence in device_locations');
    if (sqlCoalesce) {
      compare('cellResolution', 'COALESCE precedence', 'device,gateway',
        `${sqlCoalesce[1] === 'd' ? 'device' : 'gateway'},${sqlCoalesce[2] === 'g' ? 'gateway' : 'device'}`);
    }

    // THE THREE ARMS THAT RESOLVE TO NO CELL must do so on both sides, rather than falling through
    // to an inherited one. Site-wide has none by assertion; shadow and simulated (0059) have none
    // because they are lanes rather than places, and gateways_synthetic_has_no_cell guarantees
    // there is nothing to inherit anyway.
    //
    // The JS pattern tolerates the arms being written as one disjunction -- they short-circuit to
    // the same `null` -- but still requires each term to be present, so dropping one is caught.
    const flat = body.replace(/\s+/g, ' ');
    const nullArms = [
      ['site_wide', /WHEN \(d\.location_scope = 'site_wide'::text\) THEN NULL::uuid/.test(flat),
        /scope === SCOPE_SITE_WIDE[^?]*\? null :/.test(js)],
      ['shadow', /WHEN COALESCE\(g\.is_shadow, false\) THEN NULL::uuid/.test(flat),
        /\(\s*shadow \|\|/.test(js)],
      ['simulated', /WHEN COALESCE\(g\.is_simulated, false\) THEN NULL::uuid/.test(flat),
        /\|\| simulated \|\|/.test(js)]
    ];
    for (const [arm, sqlOk, jsOk] of nullArms) {
      if (!sqlOk || !jsOk) {
        problems.push(`cellResolution: the ${arm} branch must resolve to no cell on both sides (SQL ${sqlOk ? 'ok' : 'MISSING'}, JS ${jsOk ? 'ok' : 'MISSING'})`);
      } else {
        ok.push(`cellResolution: ${arm} resolves to no cell on both sides`);
      }
    }

    // PRECEDENCE, which is the one thing about these lanes that can break while every arm stays
    // individually correct. A shadow gateway is necessarily simulated (0056 refuses a target that
    // is not, and gateways_shadow_is_simulated states it), so testing simulated first makes the
    // shadow lane unreachable and nothing else changes. Both sides must ask about shadow first.
    const sqlShadowFirst = flat.indexOf("THEN 'shadow'::text") < flat.indexOf("THEN 'simulated'::text");
    const jsShadowFirst = js.indexOf('if (shadow) source = SOURCE_SHADOW') < js.indexOf('source = SOURCE_SIMULATED');
    if (!sqlShadowFirst || !jsShadowFirst) {
      problems.push(`cellResolution: shadow must be tested before simulated on both sides (SQL ${sqlShadowFirst ? 'ok' : 'WRONG ORDER'}, JS ${jsShadowFirst ? 'ok' : 'WRONG ORDER'})`);
    } else {
      ok.push('cellResolution: shadow resolves ahead of simulated on both sides');
    }

    // The six location_source labels are a closed set the UI switches on.
    // `THEN` and `ELSE`: 'unassigned' is the CASE's fall-through, so a THEN-only pattern silently
    // reports five labels where there are six -- the check would then pass whenever the JS
    // dropped that constant too.
    //
    // The alternation is spelled out rather than left as `\w+` so that adding a lane is a
    // deliberate edit here as well. `\w+` would also match the NULL-arm labels of any other CASE
    // that later joins this view, and would quietly start comparing a wider set than the UI knows.
    const sqlSources = [...new Set([...body.matchAll(/(?:THEN|ELSE) '(site_wide|explicit|inherited|unassigned|simulated|shadow)'::text/g)].map((m) => m[1]))].sort();
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
console.log(
  `\nAll ${ok.length} mirrored values agree between frontend/src/utils/ and the applied migration ` +
    `chain (${MIGRATION_FILES.length} files, last definition wins).`
);

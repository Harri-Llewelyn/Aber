/**
 * Hold the SQL-to-JavaScript mirrors together by comparing the values both sides declare, not by
 * grepping for a literal's presence, which catches a rewrite and misses a re-tuning. The
 * `modelledMetrics` mirror is behaviour rather than a literal and has a fixture contract instead
 * (`test-harness/fixtures/modelled-metrics.json`).
 *
 * Usage: node scripts/check-mirror-drift.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const problems = [];
const ok = [];

/**
 * The whole applied chain, in filename order, the order db-init replays it in. There is no
 * applied-migrations ledger, so a later `CREATE OR REPLACE FUNCTION` of the same name wins, and a
 * guard reading an earlier definition reports an agreement it did not check. `archive/` stays out:
 * readdirSync is top-level only.
 */
const MIGRATION_DIR = 'supabase/migrations';
const MIGRATION_FILES = readdirSync(join(ROOT, MIGRATION_DIR))
  .filter((name) => /^[0-9]{4}_.*\.sql$/.test(name))
  .sort();

if (MIGRATION_FILES.length === 0) {
  console.error('No applied migrations found in supabase/migrations/. Nothing to check against.');
  process.exit(1);
}

/** The example metrics db-init applies on request (dbInit.exampleMetrics). No migration seeds one. */
const EXAMPLES = read('supabase/example-metrics.sql');

/** Every applied migration, in replay order, each headed by a marker naming its file. */
const SCHEMA = MIGRATION_FILES
  .map((name) => `-- >>> ${name}\n${read(`${MIGRATION_DIR}/${name}`)}`)
  .join('\n');

/**
 * The body of the last definition matching `needle`, and which migration it came from. Last,
 * because an earlier declaration is overwritten on every boot. `endMarker` bounds the body (`$$;`
 * for a function, `;` for a plain view), since 0001 carries unrelated `INTERVAL` literals.
 * `redeclarations` is reported so the output says which file was read.
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

// 1. Sparkplug id derivation. It derives an immutable wire identity: `sparkplug_id` is `GENERATED
// ALWAYS ... STORED`, so a divergence cannot be corrected without re-provisioning every device.
{
  const js = read('frontend/src/utils/sparkplugId.js');
  const jsDevice = need(js, /DEVICE_ID_PREFIX\s*=\s*'([^']+)'/, 'DEVICE_ID_PREFIX in sparkplugId.js');
  const jsGateway = need(js, /GATEWAY_ID_PREFIX\s*=\s*'([^']+)'/, 'GATEWAY_ID_PREFIX in sparkplugId.js');
  const jsHex = need(js, /HEX_CHARS\s*=\s*(\d+)/, 'HEX_CHARS in sparkplugId.js');
  const jsLength = need(js, /SPARKPLUG_ID_LENGTH\s*=\s*(\d+)/, 'SPARKPLUG_ID_LENGTH in sparkplugId.js');
  const jsRegex = need(js, /SPARKPLUG_ID_REGEX\s*=\s*\/\^\(([a-z|]+)\)\[0-9a-f\]\{(\d+)\}\$\//, 'SPARKPLUG_ID_REGEX in sparkplugId.js');

  // e.g. ('dev'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21)). 0001 declares each
  // column twice, in its CREATE TABLE IF NOT EXISTS and in the ADD COLUMN IF NOT EXISTS that
  // converges an older table, so declarations are grouped by the table statement they sit in:
  // exactly devices and gateways, and every declaration of one table must agree.
  const declarations = [...SCHEMA.matchAll(
    /sparkplug_id text GENERATED ALWAYS AS \(\('([a-z]+)'::text \|\| substr\(encode\(uuid_send\(id\), 'hex'::text\), 1, (\d+)\)\)\) STORED/g
  )].map((m) => {
    const tables = [...SCHEMA.slice(0, m.index).matchAll(/^(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: ONLY)?(?: IF EXISTS)?) public\.(\w+)/gm)];
    return { table: tables.length ? tables[tables.length - 1][1] : '(unknown)', prefix: m[1], width: m[2] };
  });
  const byTable = new Map();
  for (const d of declarations) {
    const key = `${d.prefix}/${d.width}`;
    byTable.set(d.table, (byTable.get(d.table) ?? new Set()).add(key));
  }
  const tableNames = [...byTable.keys()].sort().join(',');
  const conflicting = [...byTable].filter(([, forms]) => forms.size > 1);
  if (tableNames !== 'devices,gateways') {
    problems.push(`sparkplugId: expected generated sparkplug_id columns on devices and gateways, found them on "${tableNames}"`);
  } else if (conflicting.length > 0) {
    for (const [table, forms] of conflicting) {
      problems.push(`sparkplugId: ${table}.sparkplug_id is declared ${forms.size} different ways across the chain: ${[...forms].join(' vs ')}`);
    }
  } else if (jsDevice && jsGateway && jsHex && jsLength && jsRegex) {
    const generated = [...byTable.values()].map((forms) => [...forms][0].split('/'));
    ok.push(`sparkplugId: ${declarations.length} declarations resolve to one column each on devices and gateways`);
    const sqlPrefixes = generated.map(([prefix]) => prefix).sort();
    const sqlWidths = [...new Set(generated.map(([, width]) => width))];
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

// 2. Gateway staleness, derived at read time on both sides, so the two thresholds must agree. The
// view is built inside `ensure_gateway_status_view()`, which later migrations call after adding a
// gateways column; the latest redeclaration is the one that runs.
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

    // The enrolment lifecycle states, mirrored by gatewayLiveStatus(). They must short-circuit
    // ahead of the staleness arm on both sides: a gateway in AWAITING_BIRTH has a `last_heartbeat`
    // from its previous life, so a staleness test reached first reports STALE for an appliance that
    // has not published yet.
    const sqlStates = [...new Set(
      [...view.body.matchAll(/'(PENDING_ENROLLMENT|AWAITING_BIRTH)'/g)].map((m) => m[1])
    )].sort();
    const jsStates = [...new Set(
      [...js.matchAll(/export const GATEWAY_STATUS_[A-Z_]+ = '(PENDING_ENROLLMENT|AWAITING_BIRTH)'/g)].map((m) => m[1])
    )].sort();
    compare('gatewayStatus', 'enrolment lifecycle states', jsStates.join(','), sqlStates.join(','));

    if (sqlStates.length === 2) {
      // Position, not presence: in the SQL the states must appear in a WHEN branch before the
      // INTERVAL comparison, and in the JS before isHeartbeatStale() is consulted.
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

// 9. The historian's next backup. The Backups page says when the sidecar takes its next backup and
// which type by running nextHistorianBackup(); the sidecar decides with physical_backup_missed_slot()
// and physical_backup_type() in timescaledb/physical_backup.sql. The page's function is run at the
// boundary each SQL rule states, so a re-tuned threshold or a flipped comparison fails here rather
// than as a page promising a backup the sidecar will not take.
{
  const { nextHistorianBackup } = await import(
    pathToFileURL(join(ROOT, 'frontend/src/utils/historianBackupSchedule.js')).href
  );
  const sql = read('timescaledb/physical_backup.sql');
  const flatBody = (name) => {
    const at = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    return at < 0 ? '' : sql.slice(at, sql.indexOf('$;', at)).replace(/\s+/g, ' ');
  };
  const slotSql = flatBody('physical_backup_missed_slot');
  const typeSql = flatBody('physical_backup_type');
  const utcSlot = need(slotSql,
    /date_trunc\('day', p_now AT TIME ZONE 'UTC'\) \+ make_interval\(hours => p_hour\)/,
    'the UTC daily slot in physical_backup_missed_slot()');
  const slotRule = need(slotSql, /CASE WHEN at (<=?) p_now THEN at ELSE at - interval '(\d+) days?' END/,
    'the latest-slot rule in physical_backup_missed_slot()');
  const attemptRule = need(slotSql, /r\.kind IN \(([^)]*)\) AND r\.started_at (>=?) s\.at/,
    'the attempted-since rule in physical_backup_missed_slot()');
  const weekdayRule = need(typeSql,
    /WHEN extract\(dow FROM p_slot AT TIME ZONE 'UTC'\) = p_full_on THEN 'full'/,
    'the weekday rule in physical_backup_type()');
  const ageRule = need(typeSql, /WHEN f\.newest IS NULL OR f\.newest (<=?) p_now - interval '(\d+) days' THEN 'full'/,
    'the no-full and age rules in physical_backup_type()');

  const DAY = 24 * 60 * 60 * 1000;
  const HOUR_UTC = 2;
  const slot = Date.UTC(2026, 0, 7, HOUR_UTC);
  const iso = (ms) => new Date(ms).toISOString();
  const dow = (ms) => new Date(ms).getUTCDay();
  // Attempted at the slot, so the next is tomorrow's, `at`; full_on is then never at's weekday
  // unless a probe sets it.
  const at = slot + DAY;
  const offDay = (dow(at) + 3) % 7;
  const plan = (fields, now) => nextHistorianBackup({ hour_utc: HOUR_UTC, full_on: offDay, ...fields }, now);
  const kindWith = (lastFull, fullOn = offDay) =>
    plan({ last_attempt_at: iso(slot), last_full_at: lastFull === null ? null : iso(lastFull), full_on: fullOn }, slot + 3_600_000).kind;

  if (utcSlot && slotRule) {
    const onTheSlot = plan({ last_full_at: iso(slot - DAY) }, slot);
    compare('historianBackup', 'a slot reached exactly is today\'s (at <= now)',
      onTheSlot.at === slot ? '<=' : '<', slotRule[1]);
    const before = plan({ last_full_at: iso(slot - DAY) }, slot - 1);
    compare('historianBackup', 'the step back to the previous slot (days)', (slot - before.at) / DAY, slotRule[2]);
  }
  if (attemptRule) {
    const atSlot = plan({ last_attempt_at: iso(slot), last_full_at: iso(slot - DAY) }, slot + 3_600_000);
    const earlier = plan({ last_attempt_at: iso(slot - 1), last_full_at: iso(slot - DAY) }, slot + 3_600_000);
    if (!earlier.due) {
      problems.push('historianBackup: the page counts an attempt before the slot as one since it; the sidecar does not');
    } else {
      compare('historianBackup', 'an attempt at the slot counts (started_at >= slot)', atSlot.due ? '>' : '>=', attemptRule[2]);
    }

    // The page reads last_attempt_at from historian_backup_state(), every run but one kind; the
    // sidecar counts the kinds in its IN list. They agree while that list is every other kind.
    const runKinds = need(sql, /kind\s+text\s+NOT NULL CHECK \(kind IN \(([^)]*)\)\)/, 'the run kinds in physical_backup_runs');
    const state = lastDefinition('CREATE OR REPLACE FUNCTION public.historian_backup_state()', '$;',
      'public.historian_backup_state()');
    const excluded = state && need(state.body.replace(/\s+/g, ' '),
      /\(SELECT max\(b\.started_at\) FROM runs b WHERE b\.kind <> '(\w+)'\)/,
      `last_attempt_at in historian_backup_state() (${state.file})`);
    if (runKinds && excluded) {
      const list = (s) => [...s.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort().join(',');
      const counted = list(runKinds[1]).split(',').filter((k) => k !== excluded[1]).join(',');
      compare('historianBackup', `the run kinds that count as an attempt, from ${state.file}`, counted, list(attemptRule[1]));
    }
  }
  if (weekdayRule) {
    if (kindWith(slot - DAY, dow(at)) !== 'full' || kindWith(slot - DAY) !== 'diff') {
      problems.push('historianBackup: the page does not take a full on full_on\'s UTC weekday and a differential otherwise, as the sidecar does');
    } else {
      ok.push('historianBackup: a full on full_on\'s UTC weekday on both sides');
    }
  }
  if (ageRule) {
    if (kindWith(null) !== 'full') {
      problems.push('historianBackup: with no full yet the page expects a differential; the sidecar takes a full');
    }
    let days = null;
    for (let n = 1; n <= 60 && days === null; n += 1) {
      if (kindWith(at - n * DAY - 1) === 'full' && kindWith(at - n * DAY + 1) === 'diff') days = n;
    }
    const op = days === null ? '?' : kindWith(at - days * DAY) === 'full' ? '<=' : '<';
    compare('historianBackup', 'a full when the newest is older than', `${op} ${days} days`, `${ageRule[1]} ${ageRule[2]} days`);
  }
}

// 3. Effective cell resolution. NULL cell_id means inherit, so the COALESCE precedence is the rule:
// device first, gateway second.
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

    // The three arms that resolve to no cell must do so on both sides: site-wide by assertion,
    // shadow and simulated because they are lanes rather than places. The JS pattern tolerates the
    // arms as one disjunction but requires each term.
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

    // Precedence: a shadow gateway is necessarily simulated, so testing simulated first makes the
    // shadow lane unreachable. Both sides must ask about shadow first.
    const sqlShadowFirst = flat.indexOf("THEN 'shadow'::text") < flat.indexOf("THEN 'simulated'::text");
    const jsShadowFirst = js.indexOf('if (shadow) source = SOURCE_SHADOW') < js.indexOf('source = SOURCE_SIMULATED');
    if (!sqlShadowFirst || !jsShadowFirst) {
      problems.push(`cellResolution: shadow must be tested before simulated on both sides (SQL ${sqlShadowFirst ? 'ok' : 'WRONG ORDER'}, JS ${jsShadowFirst ? 'ok' : 'WRONG ORDER'})`);
    } else {
      ok.push('cellResolution: shadow resolves ahead of simulated on both sides');
    }

    // The seven location_source labels are a closed set the UI switches on. `THEN` and `ELSE`,
    // because 'unassigned' is the CASE's fall-through. The alternation is spelled out so adding a
    // lane is a deliberate edit here too.
    const sqlSources = [...new Set([...body.matchAll(/(?:THEN|ELSE) '(site_wide|area_wide|explicit|inherited|unassigned|simulated|shadow)'::text/g)].map((m) => m[1]))].sort();
    const jsSources = [...new Set([...js.matchAll(/export const SOURCE_[A-Z_]+ = '([a-z_]+)'/g)].map((m) => m[1]))].sort();
    compare('cellResolution', 'location_source labels', jsSources.join(','), sqlSources.join(','));
  }
}

// 4. RBAC grants. `DEFAULT_ROLE_PERMISSIONS_MAP` in usePermissions.js is the static fallback the
// dashboard renders from when no `role_permissions` rows resolve, so a divergence offers controls
// the database refuses, or hides a capability. The SQL side is replayed, not read from one file:
// the seed grants and a later migration withdraws.
{
  const constants = read('frontend/src/constants.js');
  const hook = read('frontend/src/hooks/usePermissions.js');

  /** A named block's body, bounded by the first `};` after its declaration. */
  const block = (source, declaration, what) => {
    const at = source.indexOf(declaration);
    if (at < 0) {
      problems.push(`rbacGrants: could not find ${what} -- the file's shape changed, so this check is no longer checking anything`);
      return null;
    }
    const stop = source.indexOf('};', at);
    return source.slice(at, stop < 0 ? undefined : stop);
  };

  const permBlock = block(constants, 'export const PERMISSION_UUIDS = {', 'PERMISSION_UUIDS in constants.js');
  const mapBlock = block(hook, 'const DEFAULT_ROLE_PERMISSIONS_MAP = {', 'DEFAULT_ROLE_PERMISSIONS_MAP in usePermissions.js');

  if (permBlock && mapBlock) {
    // KEY -> uuid, so a disagreement can be reported by the name a reader recognises. Bounded to
    // the PERMISSION_UUIDS block: constants.js carries other uuid-shaped literals.
    const uuidByKey = new Map([...permBlock.matchAll(/(\w+):\s*'([0-9a-f-]{36})'/g)].map((m) => [m[1], m[2]]));
    const keyByUuid = new Map([...uuidByKey].map(([k, v]) => [v, k]));
    const everyPermission = [...uuidByKey.values()];

    // Each role's entry is either the whole set or an explicit list. `Object.values(...)` is
    // Administrator's spelling: it holds every permission by definition.
    const jsGrants = new Map();
    for (const m of mapBlock.matchAll(/(\w+):\s*(Object\.values\(PERMISSION_UUIDS\)|\[[^\]]*\])/g)) {
      const [, role, value] = m;
      const uuids = value.startsWith('Object.values')
        ? everyPermission
        : [...value.matchAll(/PERMISSION_UUIDS\.(\w+)/g)].map((p) => uuidByKey.get(p[1]));
      if (uuids.some((u) => u === undefined)) {
        problems.push(`rbacGrants: ${role} names a PERMISSION_UUIDS key that constants.js does not declare`);
        continue;
      }
      jsGrants.set(role, new Set(uuids));
    }

    const roleNameById = new Map(
      [...SCHEMA.matchAll(/INSERT INTO public\.roles VALUES \((\d+), '(\w+)'/g)].map((m) => [m[1], m[2]])
    );

    const sqlGrants = new Map([...roleNameById.values()].map((name) => [name, new Set()]));
    for (const m of SCHEMA.matchAll(/INSERT INTO public\.role_permissions VALUES \((\d+), '([0-9a-f-]{36})'\)/g)) {
      const role = roleNameById.get(m[1]);
      if (role) sqlGrants.get(role).add(m[2]);
    }

    // The withdrawals, and the parser refuses to guess: only the `role_id = N AND permission_id IN
    // (...)` shape is understood, so a DELETE written another way fails rather than being counted
    // and not applied.
    const deleteStatements = [...SCHEMA.matchAll(/DELETE FROM public\.role_permissions/g)].length;
    const parsedDeletes = [...SCHEMA.matchAll(
      /DELETE FROM public\.role_permissions\s+WHERE role_id = (\d+)\s+AND permission_id IN \(([^;]*?)\);/g
    )];
    if (parsedDeletes.length !== deleteStatements) {
      problems.push(
        `rbacGrants: the chain has ${deleteStatements} DELETE(s) from role_permissions and this check ` +
          `understands ${parsedDeletes.length} of them. Teach it the new shape -- an unparsed withdrawal ` +
          `makes the SQL side look more generous than the database is.`
      );
    }
    for (const m of parsedDeletes) {
      const role = roleNameById.get(m[1]);
      if (!role) continue;
      for (const u of m[2].matchAll(/'([0-9a-f-]{36})'/g)) sqlGrants.get(role).delete(u[1]);
    }

    const named = (set) => [...set].map((u) => keyByUuid.get(u) || u).sort().join(',');
    for (const [role, jsSet] of jsGrants) {
      const sqlSet = sqlGrants.get(role);
      if (!sqlSet) {
        problems.push(`rbacGrants: usePermissions.js has a fallback for '${role}', which public.roles does not seed`);
        continue;
      }
      compare('rbacGrants', `${role}'s permissions`, named(jsSet), named(sqlSet));
    }

    // The other direction: a role seeded with grants and missing from the map falls through to no
    // permissions when the embed comes back empty.
    const unmapped = [...sqlGrants].filter(([role, set]) => set.size > 0 && !jsGrants.has(role)).map(([role]) => role);
    if (unmapped.length) {
      problems.push(
        `rbacGrants: ${unmapped.join(', ')} hold(s) seeded permissions with no entry in ` +
          `DEFAULT_ROLE_PERMISSIONS_MAP, so the fallback renders an empty dashboard for that role`
      );
    } else {
      ok.push(`rbacGrants: every seeded role has a fallback entry (${jsGrants.size} roles)`);
    }
  }
}

// 5. RETIRED BY 0108. `proposable_link_tags()` was dropped with the three link proposal lanes it
// validated for; a link has only ever been attached by the direct edit, which stores `link_tag`
// against no CHECK. The tag vocabulary now lives in EntityLinksModal alone, so there is no second
// copy here to drift from.

// 6. The Directory's local-namespace qualification, TypeScript to Python. `schemas.id` and
// `directory_services.id` are locally minted, and the edge function and `directory_publish.py` both
// attach the qualification; the strings are compared, since two different sentences would read as
// two different claims, and the MQTT half is where it matters most, with no route or documentation
// beside the bytes.
{
  const ts = read('supabase/functions/fplus-directory/index.ts');
  const py = read('ingestion/directory_publish.py');
  const tsNote = need(ts, /const LOCAL_SCHEMA_NOTE = "([^"]+)"/, 'LOCAL_SCHEMA_NOTE in fplus-directory/index.ts');
  const pyNote = need(py, /^LOCAL_SCHEMA_NOTE = "([^"]+)"/m, 'LOCAL_SCHEMA_NOTE in directory_publish.py');
  if (tsNote && pyNote) {
    compare('directoryNamespaceNote', 'the local-schema qualification', pyNote[1], tsNote[1]);
  }

  // The service note is a string literal inline in the /v1/service handler rather than a named
  // constant. Checked in the same pair so the second qualification cannot drift.
  const tsService = need(ts, /note: "(Stack service endpoints[^"]+)"/, 'the /v1/service note in fplus-directory/index.ts');
  const pyService = need(py, /^LOCAL_SERVICE_NOTE = "([^"]+)"/m, 'LOCAL_SERVICE_NOTE in directory_publish.py');
  if (tsService && pyService) {
    compare('directoryServiceNote', 'the local-service qualification', pyService[1], tsService[1]);
  }
}

// -------------------------------------------------------------------------------------------------
// 7. The MTConnect semantic id the Add Metric form derives is the id `mtconnect_vocabulary` seeds
// for that data item type, and the id every MTConnect row of the example metrics carries (#457):
// each SELECTs the id of the concept it names, so that concept must be the name's last segment.
// The form's own function is run, so a change to the namespace or the kind segment on either side
// fails here rather than as a form-created metric naming no concept.
// -------------------------------------------------------------------------------------------------
{
  const { mtconnectSemanticId } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/standards.js')).href);
  const vocabulary = [...SCHEMA.matchAll(
    /^INSERT INTO public\.mtconnect_vocabulary VALUES \('DATA_ITEM_TYPE', '([^']+)', (?:'[^']*'|NULL), '([^']+)'\)/gm
  )];
  // (name, concept) per row of the MTConnect insert: the first and fourth literals of each tuple.
  const mtconnectInsert = EXAMPLES.match(/SELECT[^;]*?'MTConnect'[^;]*?FROM \(VALUES([\s\S]*?)\) AS /);
  const catalog = mtconnectInsert
    ? [...mtconnectInsert[1].matchAll(/\(\s*'([^']+)',\s*\d+,\s*'(?:[^']|'')*',\s*'([^']+)',/g)]
    : [];
  const vocabularyId = new Map(vocabulary.map(([, type, id]) => [type, id]));
  if (vocabulary.length === 0 || catalog.length === 0) {
    problems.push('mtconnectSemanticId: found no seeded DATA_ITEM_TYPE or example MTConnect metric -- the file\'s shape changed, so this check is no longer checking anything');
  } else {
    const derived = (name) => mtconnectSemanticId(name.split('/').pop());
    const strays = [
      ...vocabulary.filter(([, type, id]) => mtconnectSemanticId(type) !== id)
        .map(([, type, id]) => `vocabulary ${type}: seeded ${id}, form derives ${mtconnectSemanticId(type)}`),
      ...catalog.filter(([, name, concept]) => derived(name) !== vocabularyId.get(concept))
        .map(([, name, concept]) => `example ${name}: carries ${concept}'s id ${vocabularyId.get(concept)}, form derives ${derived(name)}`),
    ];
    if (strays.length) problems.push(`mtconnectSemanticId: ${strays.slice(0, 5).join('; ')}`);
    else ok.push(`mtconnectSemanticId: ${vocabulary.length} data item types and ${catalog.length} example metrics agree`);
  }
}

// -------------------------------------------------------------------------------------------------
// 8. The ASHRAE 223P metric group. The form's prefill (utils/ashrae223.js) and the seed must name the
// same one, it must be the only group registered under the standard, and the example metrics must
// file under it: they forked once (#456), the form filing under `Building` while the seeded metrics
// sat under an unregistered `BMS`.
// -------------------------------------------------------------------------------------------------
{
  const js = need(read('frontend/src/utils/ashrae223.js'), /export const ASHRAE223_GROUP = '([^']+)'/,
    'ASHRAE223_GROUP in utils/ashrae223.js');
  const registered = [...SCHEMA.matchAll(
    /INSERT INTO public\.metric_groups \(id, name, description, standard\)\s*VALUES \('[^']*', '([^']+)',\s*'(?:[^']|'')*',\s*'ASHRAE 223P'\)/g
  )].map((m) => m[1]);
  // The example metrics' INSERT ... SELECT over a VALUES list, which names the standard once.
  const seededGroups = new Set(
    [...EXAMPLES.matchAll(/INSERT INTO public\.metric_catalog \([^)]*\)\s*SELECT[^;]*?'ASHRAE 223P'[^;]*?FROM \(VALUES([\s\S]*?)\) AS /g)]
      .flatMap((m) => [...m[1].matchAll(/\(\s*'([^'/]+)\/[^']*',/g)].map((v) => v[1]))
  );
  if (js && seededGroups.size === 0) {
    problems.push('ashrae223Group: found no example ASHRAE 223P metric -- the file\'s shape changed, so half of this check is no longer checking anything');
  }
  if (js && registered.length !== 1) {
    problems.push(`ashrae223Group: expected one metric group registered under ASHRAE 223P, found ${JSON.stringify(registered)}`);
  } else if (js) {
    compare('ashrae223Group', 'the group 223P metrics file under', js[1], registered[0]);
    const strays = [...seededGroups].filter((g) => g !== registered[0]);
    if (strays.length) {
      problems.push(`ashrae223Group: example 223P metrics file under ${JSON.stringify(strays)}, not the registered '${registered[0]}'`);
    }
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
  `\nAll ${ok.length} mirrored values agree between the frontend and the applied migration ` +
    `chain (${MIGRATION_FILES.length} files, last definition wins).`
);

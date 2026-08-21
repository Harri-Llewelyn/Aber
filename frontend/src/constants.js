import { readFlag, readSetting } from './config';

export const SPARKPLUG_TYPES = {
  1: 'Int8', 2: 'Int16', 3: 'Int32', 4: 'Int64',
  5: 'UInt8', 6: 'UInt16', 7: 'UInt32', 8: 'UInt64',
  9: 'Float', 10: 'Double', 11: 'Boolean', 12: 'String',
  13: 'DateTime', 14: 'Text',
};

export const PERMISSION_UUIDS = {
  QUARANTINE_VIEW:    'cb46a943-42e1-4c1d-8706-933e08544e30',
  QUARANTINE_APPROVE: 'cb46a943-42e1-4c1d-8706-933e08544e31',
  QUARANTINE_REJECT:  'a123b456-7890-4c1d-8706-933e08544e32',
  DEVICE_MANAGE:      'd987c654-3210-4c1d-8706-933e08544e33',
  CELL_MANAGE:        'c456d789-0123-4c1d-8706-933e08544e34',
  GATEWAY_MANAGE:     'e789a012-3456-4c1d-8706-933e08544e35',
  TELEMETRY_READ:     'f012a345-6789-4c1d-8706-933e08544e36',
  ARCHIVE_MANAGE:     'b345c678-9012-4c1d-8706-933e08544e37',
  DOCUMENT_MANAGE:    'a012b345-6789-4c1d-8706-933e08544e38',
  AUTHZ_MANAGE:       'e012c345-6789-4c1d-8706-933e08544e39',
  SCHEMA_MANAGE:      'f123d456-7890-4c1d-8706-933e08544e40',
  GITOPS_MANAGE:      'c234e567-8901-4c1d-8706-933e08544e41',
  DIGITAL_THREAD_READ: 'd345e678-9012-4c1d-8706-933e08544e42',
};

/**
 * Every value `digital_thread.action` can hold, with the label the filter offers for it.
 *
 * SHARED BECAUSE TWO PLACES MUST AGREE AND NEITHER COULD SEE THE OTHER. The Digital Thread filter
 * renders these as options; `api.js` uses the same keys as an ALLOW-LIST before turning the choice
 * into a SQL predicate. That allow-list was `['INSERT', 'UPDATE', 'DELETE']` written out by hand,
 * so when migration 0026 added SCHEMA_REJECTION the filter could not have selected it -- and the
 * failure would not have been an error. An unlisted action fell through the `if` and applied NO
 * predicate at all, so asking for one kind of event returned EVERY kind. That is the same trap the
 * empty-entityIds guard beside it exists to close: a filter that matches nothing must return
 * nothing, never everything.
 *
 * THE LABELS NAME THE DATABASE ACTION, deliberately, and do not reuse the marker vocabulary. The
 * timeline colours events by a DERIVED classification -- Created / Operational / Configuration /
 * Lifecycle (see MARKERS) -- and the filter previously borrowed two of those words for a different
 * taxonomy: its "Created" meant INSERT, while the legend's "Lifecycle" spans a DELETE and any
 * UPDATE that archived or quarantined a row. Two overlapping vocabularies on one screen, reported
 * as issue #37. These labels match the raw badge shown in the event drawer instead, so the filter
 * and the badge name the same thing.
 */
export const DIGITAL_THREAD_ACTIONS = {
  INSERT:           'Insert',
  UPDATE:           'Update',
  DELETE:           'Delete',
  SCHEMA_REJECTION: 'Schema rejection',
};

export const VALID_TABS = [
  'overview', 'cells', 'gateways', 'devices', 'digital-thread', 'schemas', 'vocabulary', 'directory',
  'archives'
];

// Realtime rollout flag and the polling intervals paired with it.
//
// REALTIME_ENABLED gates every supabase.channel() subscription in the app. When it is off the
// tabs fall back to the original 3s poll, so the feature can be turned off in a deployment
// without a code change.
//
// The two intervals are the point of the migration: with Realtime carrying updates, polling
// stops being the refresh mechanism and becomes a reconciliation loop. It is NOT deleted --
// Realtime has no replay, so a dropped socket loses every change in the gap, and usePolling
// also carries the 401 stop and exponential backoff a channel subscription has no equivalent
// for. See frontend/src/hooks/useRealtimeTable.js.
export const REALTIME_ENABLED = readFlag('VITE_ENABLE_REALTIME');
export const POLL_INTERVAL_MS = 3000;
export const RECONCILE_INTERVAL_MS = 60000;

/**
 * Where the Report Bug button files an issue.
 *
 * Configurable because a fork does not want its bug reports landing on the upstream tracker --
 * which is exactly what was happening: the URL was hardcoded to
 * `Harri-Llewelyn/acs-cymru`, a repository that is not this one, so every report
 * filed through that button went somewhere nobody working on this code was reading.
 *
 * A FALLBACK IS KEPT, unlike VITE_SUPABASE_URL which throws when missing. The distinction is what
 * breaks: a missing Supabase URL means the app cannot function and should say so loudly, whereas
 * a missing repo URL should never leave someone trying to report a bug staring at a dead button.
 * A wrong-but-present default is recoverable; a broken reporting path hides every other defect.
 */
export const GITHUB_REPO_URL = readSetting(
  'VITE_GITHUB_REPO_URL',
  'https://github.com/Harri-Llewelyn/ACS-Cymru'
).replace(/\/+$/, '');

/**
 * Grafana, as the BROWSER reaches it -- for the "View in Grafana" link on an active alert.
 *
 * THE DEFAULT IS 3002, NOT GRAFANA'S OWN 3000. The container listens on 3000 and docker-compose.yml
 * publishes it on 3002, because the frontend already has 3000. A link to the wrong port is worse
 * than no link: it lands on this dashboard, which is where the operator already was, and reads as
 * "Grafana is broken" rather than as a misconfiguration. Same value as GRAFANA_PUBLIC_URL, which
 * 0002_seed_data.sql registers as the OAuth redirect origin and grafana.ini builds root_url from --
 * so a deployment that moves Grafana has to set both, and setting only this one produces a dead link
 * rather than a broken login.
 *
 * A FALLBACK IS KEPT for the same reason GITHUB_REPO_URL keeps one: a wrong-but-present default is
 * recoverable, whereas throwing would take the whole dashboard down over a hyperlink.
 */
export const GRAFANA_URL = readSetting('VITE_GRAFANA_URL', 'http://localhost:3002')
  .replace(/\/+$/, '');

/**
 * The Grafana alert page for one rule.
 *
 * BY RULE NAME ONLY. It also carried `label:sparkplug_id=<id>`, to land on the one device's instance
 * rather than on the rule covering all six, and that filter returned an EMPTY LIST every time.
 *
 * `/alerting/list` searches RULE DEFINITIONS, so its `label:` prefix matches the static labels a rule
 * declares in alert-rules.yaml -- which is `severity` and nothing else. `sparkplug_id` is a column in
 * the rule's SQL: it becomes a label on each evaluated SERIES, so it exists on instances and never on
 * the definition being searched. The two filters ANDed, and the conjunct that matched nothing took
 * the whole result with it. Worse, it failed silently and plausibly: an empty alert list reads as
 * "the alert has cleared", which is the one wrong answer somebody following this link would act on.
 *
 * NOT A RULE-UID DEEP LINK EITHER, though the UIDs are stable and pinned (`acs-thermal-excursion` and
 * friends). They live in the provisioning YAML and nowhere in `platform_alerts` -- the Alertmanager
 * payload the webhook receives does not carry one -- so using them would mean a name-to-UID map in
 * the frontend that drifts from the YAML the first time a rule is renamed, with nothing to catch it.
 * The rule NAME is what Grafana itself put in the row, so this cannot disagree with the rule it
 * points at.
 */
export const grafanaAlertUrl = (alertName) =>
  (alertName
    ? `${GRAFANA_URL}/alerting/list?search=${encodeURIComponent(`rule:"${alertName}"`)}`
    : `${GRAFANA_URL}/alerting/list`);

// How often tabs that render wall-clock-derived state re-render (see hooks/useClockTick.js).
// Gateway heartbeat staleness is the case: a gateway going quiet writes nothing, so it emits
// no Realtime event, and at a 60s reconciliation it would otherwise show STALE up to ~120s
// late. 15s keeps detection close to the pre-Realtime behaviour at no network cost.
export const STALENESS_TICK_MS = 15000;

/** Refresh interval a tab should use given whether Realtime is carrying its updates. */
export const refreshInterval = (realtimeEnabled = REALTIME_ENABLED) =>
  (realtimeEnabled ? RECONCILE_INTERVAL_MS : POLL_INTERVAL_MS);

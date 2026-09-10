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
  // Renamed from DOCUMENT_MANAGE by 0049. THE UUID IS UNCHANGED and must stay so:
  // role_permissions references it by id, so this is a variable rename, not an authorisation
  // change. Only the permission's `name` string moved, in 0049.
  LINK_MANAGE:        'a012b345-6789-4c1d-8706-933e08544e38',
  AUTHZ_MANAGE:       'e012c345-6789-4c1d-8706-933e08544e39',
  SCHEMA_MANAGE:      'f123d456-7890-4c1d-8706-933e08544e40',
  GITOPS_MANAGE:      'c234e567-8901-4c1d-8706-933e08544e41',
  DIGITAL_THREAD_READ: 'd345e678-9012-4c1d-8706-933e08544e42',
  // Added by 0086. The first WRITE grant Operator has ever held, and it is a write to a queue
  // rather than to an asset -- the asset write policies are unchanged.
  PROPOSAL_CREATE:    'b678f901-2345-4c1d-8706-933e08544e43',
};

/**
 * Every value `digital_thread.action` can hold, with the label the filter offers for it.
 *
 * Shared because the Digital Thread filter renders these as options and `api.js` uses the same
 * keys as an allow-list before building a SQL predicate: an unlisted action would apply no
 * predicate and return every kind. The labels name the database action rather than reusing the
 * marker vocabulary (Created / Operational / Configuration / Lifecycle), so the filter and the
 * event drawer's badge name the same thing.
 */
export const DIGITAL_THREAD_ACTIONS = {
  INSERT:           'Insert',
  UPDATE:           'Update',
  DELETE:           'Delete',
  SCHEMA_REJECTION: 'Schema rejection',
  // NOT WRITTEN BY THE AUDIT TRIGGER, like SCHEMA_REJECTION above. 0041 records a broker credential
  // minted for a gateway; 0043 records a long-lived token signed for a service principal. Both are
  // filterable because both are the reason somebody opens this page -- "who was given what, when".
  CREDENTIAL_ISSUED: 'Credential issued',
  TOKEN_MINTED:      'Token minted',
  // The pair is the question: "who was given what" is only half an answer without "and when was
  // it taken away".
  TOKEN_REVOKED:     'Token revoked',
  // An approval writes one row naming both parties, and is filterable because "what has been
  // approved lately" is a question this page answers. Rejected and withdrawn proposals are absent:
  // neither changed anything, and the proposal row carries the refusal.
  PROPOSAL_APPLIED:  'Proposal applied',
  // Written by the expiry timer, with `changed_by` NULL because a timer is not a person.
  PROPOSAL_EXPIRED:  'Proposal expired',
  // Written by `log_role_assignment()`, not the generic audit trigger (`user_roles` has no `id`).
  // Named rather than INSERT/DELETE because what happened is that somebody became an Administrator.
  ROLE_GRANTED:      'Role granted',
  ROLE_REVOKED:      'Role revoked',
};

/**
 * Every entity type the Digital Thread records, in the order the timeline draws them.
 *
 * One list: the timeline's sections, the filter dropdown and `api.js` each held their own and
 * disagreed silently (a kind missing from the api.js map matched no row and read as "no events").
 * `table` is the string the trigger stores (TG_TABLE_NAME, or `service_principals` written by
 * hand for identities in GoTrue's schema). `kind` is the UI's spelling, which a handover from
 * another page arrives carrying; both forms normalise through here. Adding a kind here makes it
 * drawable, filterable and resolvable at once, and `digitalThreadEntityTypes.test.js` fails if
 * any consumer is left behind.
 */
export const DIGITAL_THREAD_ENTITY_TYPES = [
  { kind: 'CELL',             table: 'cells',              label: 'Cells' },
  { kind: 'GATEWAY',          table: 'gateways',           label: 'Gateways' },
  { kind: 'DEVICE',           table: 'devices',            label: 'Devices' },
  // The security lane (0070), in the order a reader meets it: who holds what, what the machines
  // are, then the contracts and settings that shape both.
  { kind: 'ACCESS',           table: 'user_roles',         label: 'Role assignments' },
  { kind: 'SERVICE IDENTITY', table: 'service_principals', label: 'Service identities' },
  { kind: 'SCHEMA',           table: 'schemas',            label: 'Schemas' },
  { kind: 'SETTING',          table: 'system_settings',    label: 'Settings' },
  // Without these two a proposal row lands with no kind, unlabelled and unfilterable.
  // `device_nameplate` is keyed by the device id, so a nameplate approval also belongs to that
  // device's own history (the entity thread in api.js unions the two).
  { kind: 'NAMEPLATE',        table: 'device_nameplate',   label: 'Device nameplates' },
  { kind: 'PROPOSAL',         table: 'change_proposals',   label: 'Change proposals' },
];

/** Stored `entity_type` -> the UI's spelling. What the timeline reads rows through. */
export const ENTITY_KIND_BY_TABLE = Object.fromEntries(
  DIGITAL_THREAD_ENTITY_TYPES.map(e => [e.table, e.kind])
);

/** The UI's spelling -> stored `entity_type`. What a filter has to become before it is a query. */
export const ENTITY_TABLE_BY_KIND = Object.fromEntries(
  DIGITAL_THREAD_ENTITY_TYPES.map(e => [e.kind, e.table])
);

/**
 * Every tab id the router will accept. This list and `TABS` in App.jsx must agree:
 * `handleNavClick` returns early on an id that is not here, so a tab declared there and forgotten
 * here renders and does nothing when clicked. `appRouting.test.jsx` asserts the two match.
 */
export const VALID_TABS = [
  'overview', 'approvals', 'cells', 'gateways', 'devices', 'digital-thread', 'schemas', 'vocabulary', 'directory',
  'capture', 'archives', 'cold-storage', 'access-control', 'settings'
];

// Realtime rollout flag and the polling intervals paired with it. REALTIME_ENABLED gates every
// supabase.channel() subscription; off, the tabs fall back to the 3s poll. With Realtime on,
// polling becomes a reconciliation loop rather than the refresh mechanism, and it is kept because
// Realtime has no replay and usePolling carries the 401 stop and backoff (hooks/useRealtimeTable.js).
export const REALTIME_ENABLED = readFlag('VITE_ENABLE_REALTIME');
export const POLL_INTERVAL_MS = 3000;
export const RECONCILE_INTERVAL_MS = 60000;

/**
 * Where the Report Bug button files an issue. Configurable so a fork's reports do not land on the
 * upstream tracker. A fallback is kept, unlike VITE_SUPABASE_URL: a wrong-but-present default is
 * recoverable, and a dead reporting button hides every other defect.
 */
export const GITHUB_REPO_URL = readSetting(
  'VITE_GITHUB_REPO_URL',
  'https://github.com/Harri-Llewelyn/ACS-Cymru'
).replace(/\/+$/, '');

/**
 * Grafana, as the browser reaches it, for the "View in Grafana" link on an active alert. The
 * default is 3002 (docker-compose.yml publishes it there; the frontend has 3000). Same value as
 * GRAFANA_PUBLIC_URL, which the seed registers as the OAuth redirect origin, so a deployment that
 * moves Grafana sets both. A fallback is kept for the reason GITHUB_REPO_URL keeps one.
 */
export const GRAFANA_URL = readSetting('VITE_GRAFANA_URL', 'http://localhost:3002')
  .replace(/\/+$/, '');

/**
 * Supabase Studio's door, as the browser reaches it. Not a link (Studio is reached from the
 * Directory); this exists for sign-out alone (`utils/studioSignOut.js`). The fallback matches
 * STUDIO_PUBLIC_URL's, `127.0.0.1` and not `localhost`: cookies key on host, so a session opened
 * on one cannot be ended on the other.
 */
export const STUDIO_URL = readSetting('VITE_STUDIO_URL', 'http://127.0.0.1:54323')
  .replace(/\/+$/, '');

/**
 * The forge's door, as the browser reaches it (GITEA_ROOT_URL on the server side). A link as
 * well as a sign-out. The fallback is the Compose default, `localhost`, matching GITEA_ROOT_URL's.
 */
export const GITEA_URL = readSetting('VITE_GITEA_URL', 'http://localhost:3003')
  .replace(/\/+$/, '');

/**
 * The organisation every gateway repository lives in. Named here and in
 * supabase/functions/_shared/forge.ts, and the two must agree. A repository is
 * `<organisation>/gateway-<sparkplug_id>`.
 */
export const FORGE_ORGANISATION = 'gateways'

/**
 * The Grafana alert page for one rule, by rule name only. `/alerting/list` searches rule
 * definitions, so a `label:sparkplug_id=` filter (a label on evaluated series, not on the
 * definition) matches nothing and reads as "the alert has cleared". Not a rule-UID link either:
 * the UIDs live in the provisioning YAML and nowhere in `platform_alerts`, so a name-to-UID map
 * here would drift.
 */
export const grafanaAlertUrl = (alertName) =>
  (alertName
    ? `${GRAFANA_URL}/alerting/list?search=${encodeURIComponent(`rule:"${alertName}"`)}`
    : `${GRAFANA_URL}/alerting/list`);

// How often tabs that render wall-clock-derived state re-render (hooks/useClockTick.js). A
// gateway going quiet writes nothing, so it emits no Realtime event; 15s keeps STALE detection
// close to the polling behaviour at no network cost.
export const STALENESS_TICK_MS = 15000;

/** Refresh interval a tab should use given whether Realtime is carrying its updates. */
export const refreshInterval = (realtimeEnabled = REALTIME_ENABLED) =>
  (realtimeEnabled ? RECONCILE_INTERVAL_MS : POLL_INTERVAL_MS);

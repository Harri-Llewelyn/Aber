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

export const VALID_TABS = [
  'overview', 'cells', 'gateways', 'devices', 'digital-thread', 'schemas', 'vocabulary', 'directory',
  'archives'
];

export const PERSONAS = [
  { id: 'admin@factoryplus.local',    label: 'Administrator (Full Access)' },
  { id: 'manager@factoryplus.local',  label: 'Shopfloor Manager (Ops & Approval)' },
  { id: 'operator@factoryplus.local', label: 'Operator (Read-Only View)' },
  { id: 'auditor@factoryplus.local',  label: 'Auditor (Digital Thread Trace)' },
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
 * `Harri-Llewelyn/factoryplus-asset-tracking`, a repository that is not this one, so every report
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

// How often tabs that render wall-clock-derived state re-render (see hooks/useClockTick.js).
// Gateway heartbeat staleness is the case: a gateway going quiet writes nothing, so it emits
// no Realtime event, and at a 60s reconciliation it would otherwise show STALE up to ~120s
// late. 15s keeps detection close to the pre-Realtime behaviour at no network cost.
export const STALENESS_TICK_MS = 15000;

/** Refresh interval a tab should use given whether Realtime is carrying its updates. */
export const refreshInterval = (realtimeEnabled = REALTIME_ENABLED) =>
  (realtimeEnabled ? RECONCILE_INTERVAL_MS : POLL_INTERVAL_MS);

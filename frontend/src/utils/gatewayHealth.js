/**
 * What a Remote gateway's health rows say is wrong, in one place, so a row's colour and the Health
 * block's summary cannot disagree. The drawer folds the rows into one closed block, and the summary
 * is what shows while it is closed: the worst state in words, never a colour alone.
 */

import { certExpiryDays, CERT_EXPIRY_WARN_DAYS, formatBytes, holdsOlderRoot } from './gatewayStatus';
import { enrolmentStands, hadEnrolled } from './credentialState';
import { FLOW_DRIFT_GRACE_MS, flowDriftState, isFlowDrift } from './flowDrift';

export const TONE_DANGER = 'danger';
export const TONE_WARNING = 'warning';

const GIB = 1024 ** 3;

/**
 * Free disk below which the Fleet Health dashboard's Disk free column turns red, and the step below
 * which it turns orange. The drawer reads the same figure, so the two say the same thing about one
 * gateway; scripts/drift-checks/435 holds them equal to the dashboard's thresholds.
 */
export const DISK_FREE_DANGER_BYTES = 1 * GIB;
export const DISK_FREE_WARN_BYTES = 5 * GIB;

/** What the block's summary says when no figure needs attention, and when none was reported. */
export const HEALTH_ALL_CLEAR = 'Nothing needs attention';
export const HEALTH_NO_FIGURES = 'No figures reported yet';

/** A reported figure is a number or a string; null, undefined and '' are the absent ones. */
const present = (value) => value !== null && value !== undefined && value !== '';

/**
 * The health rows that need attention, worst first (danger before warning, then in the order the
 * drawer draws the rows): `{ row, tone, text }`, `row` being the drawer row's label. A figure the
 * appliance has not reported is never a problem: unknown is not wrong. Memory and load have no
 * threshold anywhere in the product, so they are never named.
 *
 * @param {object} gateway The gateways row, with the appliance's columns.
 * @param {object} [options]
 * @param {string|null} [options.rootNotAfter] When the root the platform publishes expires, to tell a
 *   gateway that holds an older one.
 * @param {number} [options.now] The clock, for the CA's days.
 */
export function gatewayHealthProblems(gateway, { rootNotAfter = null, now = Date.now() } = {}) {
  const found = [];
  const add = (row, tone, text) => found.push({ row, tone, text });

  // CA Expires: inside the alert's window or gone, else behind the platform's root.
  const days = certExpiryDays(gateway?.cert_expires_at, now);
  if (days !== null && days < CERT_EXPIRY_WARN_DAYS) {
    add('CA Expires', TONE_DANGER, days < 0 ? 'CA expired' : days < 1 ? 'CA expires today' : `CA expires in ${Math.round(days)}d`);
  } else if (holdsOlderRoot(gateway?.cert_expires_at, rootNotAfter)) {
    add('CA Expires', TONE_DANGER, 'CA holds an older root');
  }

  const free = present(gateway?.disk_free_bytes) ? Number(gateway.disk_free_bytes) : null;
  if (free !== null && Number.isFinite(free) && free < DISK_FREE_WARN_BYTES) {
    add('Disk Free', free < DISK_FREE_DANGER_BYTES ? TONE_DANGER : TONE_WARNING, `Disk ${formatBytes(free)} free`);
  }

  if (isFlowDrift(flowDriftState(gateway, now))) add('Flow', TONE_DANGER, 'Flow differs from main');

  const platform = gateway?.forge_appliance_platform_outcome;
  if (present(platform) && platform !== 'converged') add('Platform', TONE_DANGER, `Platform ${platform}`);

  if (gateway?.forge_appliance_custom_outcome === 'failed') add('Custom', TONE_DANGER, 'Custom playbook failed');

  return found.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === TONE_DANGER ? -1 : 1));
}

/** The tone one row carries, or undefined. */
export const rowTone = (problems, label) => problems.find(p => p.row === label)?.tone;

/**
 * Whether a Remote gateway's appliance should have reported to its forge branch by now and never
 * has: it enrolled, with a repository, two of flow-sync's passes ago or more. flow-sync makes that
 * report, and its log says why there is none. The health figures come on the heartbeat instead, so
 * having none of those is not this.
 *
 * @param {object} gateway The gateways row, with the forge's columns.
 * @param {number} [now] The clock, for the two passes.
 */
export function applianceReportMissing(gateway, now = Date.now()) {
  return hadEnrolled(gateway) && enrolmentStands(gateway) && !gateway.is_archived
    && present(gateway.forge_repository_at) && !present(gateway.forge_appliance_sha)
    && now - new Date(gateway.enrolled_at).getTime() >= FLOW_DRIFT_GRACE_MS;
}

/**
 * The Health block's summary line and its tone, from the rows the block holds: the worst state
 * named, with how many more there are, or that nothing needs attention, or that no figure arrived.
 *
 * @param {Array} problems gatewayHealthProblems()'s answer.
 * @param {Array} rows The block's rows, `{ label, value }`: a problem in a row the block does not
 *   hold is left out.
 * @returns {{ text: string, tone: string|undefined }}
 */
export function healthSummary(problems, rows) {
  const labels = new Set(rows.map(r => r.label));
  const here = problems.filter(p => labels.has(p.row));
  if (here.length > 0) {
    const more = here.length - 1;
    return { text: more > 0 ? `${here[0].text} and ${more} more` : here[0].text, tone: here[0].tone };
  }
  return { text: rows.some(r => present(r.value)) ? HEALTH_ALL_CLEAR : HEALTH_NO_FIGURES, tone: undefined };
}

/**
 * The drawer's fields with every row marked `health: true` folded into one closed group, where the
 * first of them stood. No such row: the fields as they were, so a kind that shows none has no block.
 * `id` names the group, and a drawer that shows another gateway has another id, so it starts closed.
 *
 * @param {Array} fields The drawer's fields, already filtered for the gateway's kind.
 * @param {Array} problems gatewayHealthProblems()'s answer.
 * @param {string} id Distinct for each gateway.
 */
export function foldHealthRows(fields, problems, id) {
  const rows = fields.filter(f => f.health);
  if (rows.length === 0) return fields;
  const { text, tone } = healthSummary(problems, rows);
  const group = { group: 'Health', id, summary: text, tone, fields: rows };
  const first = fields.findIndex(f => f.health);
  return [...fields.slice(0, first), group, ...fields.slice(first).filter(f => !f.health)];
}

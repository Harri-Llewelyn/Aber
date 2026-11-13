import { compare, lastDefinition, need, ok, problems, read } from './lib.mjs';

// 2. Gateway staleness, derived at read time on both sides, so the two thresholds must agree. The
// view is built inside `ensure_gateway_status_view()`, which later migrations call after adding a
// gateways column; the latest redeclaration is the one that runs.
export default function check() {
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

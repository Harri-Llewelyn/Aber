import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { usePolling } from './usePolling';
import { ARRIVALS_POLL_MS } from '../utils/gatewayArrivals';

/**
 * What arrives from one gateway, read while its drawer is open: the three Prometheus figures from
 * `gateway_arrivals` and each device's last reading from the historian. Each read is its own call,
 * so one failing leaves the other standing, and a failed read is a settled result and never a
 * throw: a figure in a drawer must not report the page as having stopped updating.
 *
 * Reads at once when the drawer opens or turns to another gateway, then again every
 * ARRIVALS_POLL_MS. Null until the first read of this gateway settles, so another gateway's figures
 * are never shown under this one's name.
 *
 * @param {?string} gatewayId The gateway the drawer shows, or null when it is closed.
 * @param {boolean} [enabled] False for a gateway the figures do not apply to.
 * @returns {?{ gatewayId: string, arrivals: PromiseSettledResult, readings: PromiseSettledResult }}
 */
export function useGatewayArrivals(gatewayId, enabled = true) {
  const [read, setRead] = useState(null);
  const active = enabled && Boolean(gatewayId);

  const load = useCallback(async (signal) => {
    if (!gatewayId) return;
    // Started inside a promise, so a function that is missing or throws settles as a failed read.
    const [arrivals, readings] = await Promise.allSettled([
      Promise.resolve().then(() => api.gatewayArrivals(gatewayId)),
      Promise.resolve().then(() => api.gatewayDevicesLastReading(gatewayId)),
    ]);
    if (signal?.aborted) return;
    setRead({ gatewayId, arrivals, readings });
  }, [gatewayId]);

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [active, load]);

  usePolling(load, ARRIVALS_POLL_MS, active);

  return active && read?.gatewayId === gatewayId ? read : null;
}

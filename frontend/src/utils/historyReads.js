/**
 * The reads the Metric tab makes for one metric across many devices: the carried buckets for every
 * device, in parts of the devices one read may carry at its resolution, and the changes of a text or a
 * flag. Kept apart from utils/history.js, which is pure: these call the API.
 */
import { HISTORY_CHANGE_SERIES, api } from '../api'
import { inReads } from './history'

/**
 * `metric` for `keys` (telemetry keys) over [startMs, endMs) at `resolution` (pickResolution()'s
 * answer, whose `perRead` is how many devices one read carries): `byAsset`, each device's carried
 * rows, `changes`, each device's change row (only with `stateKind`, a text or a flag), and `reads`,
 * how many parts the carried read took. A `derived` metric is read by derived_series() instead, which
 * returns its rows in the same shape. Throws what the API throws.
 */
export async function readDeviceSeries({ keys, metric, startMs, endMs, resolution, stateKind = false, derived = false, signal }) {
  const bounds = {
    from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString(), bucketMinutes: resolution.minutes, metricNames: [metric],
  }
  const parts = inReads(keys, resolution.perRead)
  const changeParts = stateKind ? inReads(keys, HISTORY_CHANGE_SERIES) : []
  const [rows, changeRows] = await Promise.all([
    Promise.all(parts.map(assetIds => (derived ? api.readDerivedSeries : api.readCarriedTelemetry)({ ...bounds, assetIds }, { signal }))),
    Promise.all(changeParts.map(assetIds => api.readTelemetryChanges({ ...bounds, assetIds }, { signal }))),
  ])
  const byAsset = new Map()
  for (const row of rows.flat()) {
    if (!byAsset.has(row.asset_id)) byAsset.set(row.asset_id, [])
    byAsset.get(row.asset_id).push(row)
  }
  return { byAsset, changes: new Map(changeRows.flat().map(row => [row.asset_id, row])), reads: parts.length }
}

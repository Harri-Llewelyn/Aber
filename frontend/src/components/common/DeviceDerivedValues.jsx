import React, { useEffect, useState } from 'react'
import { api } from '../../api'
import { DerivedTag } from './DerivedTag'
import { currentWords, derivedDefinitions, derivedReportedBy, unitOf } from '../../utils/derivedMetric'
import { deviceMetrics, readingWords, telemetryKey } from '../../utils/history'

/**
 * The Devices drawer's derived metrics: each derived metric whose inputs the device reports, with its
 * current value by the rule derived_current() holds (a counter rate and a time in state over the last
 * hour, a sum at the last whole minute), the unit, its tag and the window in words. One read when the
 * drawer opens on the device, so a value is as old as the opening. A device with no value yet says so,
 * and a read that fails says that: neither is shown as zero.
 */
export function DeviceDerivedValues({ device, names, catalog }) {
  const [state, setState] = useState({ loading: true })
  const key = `${device.asset_id}\n${names.join('\n')}`
  useEffect(() => {
    let live = true
    setState({ loading: true })
    api.readDerivedCurrent({ assetIds: [telemetryKey(device)], metricNames: names })
      .then(rows => { if (live) setState({ rows }) })
      .catch(e => { if (live) setState({ error: e?.message || 'The values could not be read.' }) })
    return () => { live = false }
    // The device and the names by value: a new array of the same names is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const definitions = derivedDefinitions(catalog)
  const units = new Map((catalog || []).map(m => [m.name, unitOf(m)]))
  const byName = new Map((state.rows || []).map(r => [r.metric_name, r]))
  return (
    <ul className="derived-values">
      {names.map(name => {
        const row = byName.get(name)
        return (
          <li key={name}>
            <span className="mono">{name}</span>
            {' '}
            <DerivedTag />
            {' '}
            {state.loading ? (
              <span className="cell-meta">Reading…</span>
            ) : state.error ? (
              <span className="cell-meta">Could not be read.</span>
            ) : row ? (
              <span>
                <span className="derived-value">{readingWords(row.value, units.get(name))}</span>
                {' '}
                <span className="cell-meta">{currentWords(definitions.get(name))}</span>
              </span>
            ) : (
              <span className="cell-meta">No value yet.</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The drawer's field for a device, or null when no derived metric applies to it: the ones whose inputs
 * it reports, by the rule History's pickers use (deviceMetrics()).
 */
export function derivedValuesField({ device, schemas, catalog }) {
  if (!device) return null
  const names = derivedReportedBy(new Set(deviceMetrics(device, schemas)), catalog)
  if (names.length === 0) return null
  return {
    label: 'Derived Metrics',
    full: true,
    value: <DeviceDerivedValues device={device} names={names} catalog={catalog} />,
    help: 'Metrics Aber computes from the ones this device reports. A rate and a share of time are over the last hour, a sum is its value at the last minute. No device publishes them.',
  }
}

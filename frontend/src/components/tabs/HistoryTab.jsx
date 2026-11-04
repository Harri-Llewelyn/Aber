import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { CardHeading } from '../common/CardHeading'
import { TabStrip } from '../common/TabStrip'
import { SearchInput } from '../common/SearchInput'
import { TimeWindowControl } from '../common/TimeWindowControl'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { RouteLink } from '../common/RouteLink'
import { SortHeader } from '../common/SortHeader'
import { IconChartLine, IconCpu } from '../common/Icons'
import { HISTORY_TABS } from '../../navigation'
import { navigate, pathSegments, useUrl, useUrlState } from '../../hooks/useUrlState'
import { useTimeWindow } from '../../hooks/useTimeWindow'
import { useSortableRows } from '../../hooks/useTableSort'
import { deviceIdentifiers } from '../../utils/sparkplugId'
import {
  DEFAULT_HISTORY_WINDOW, HISTORY_RANGES, HISTORY_SPANS, deviceMatches, historyDevices, historyPath, pickedAddress,
} from '../../utils/history'
import { HistoryDevice } from './HistoryDevice'

/** A read the page can go on without: its rows, or [] when it failed. */
const tolerated = (load) => load.then(rows => rows || [], () => [])

/** The picker's sortable columns; with none chosen, the devices are in name order. */
const PICKER_SORT = {
  device: { type: 'text', value: d => d.asset_name },
  cell: { type: 'text', value: d => d.cell_name },
  area: { type: 'text', value: d => d.area_name },
}

/**
 * The devices as a table, each a link to its charts: the Device tab with no device chosen. The
 * toolbar's search narrows it, and a heading sorts it.
 */
function DevicePicker({ devices, search, win }) {
  const matching = useMemo(() => devices.filter(d => deviceMatches(d, search)), [devices, search])
  const [shown, sort] = useSortableRows(matching, PICKER_SORT)
  if (devices.length === 0) {
    return <EmptyState icon={<IconCpu size={36} />} message="No device is registered yet, so there is nothing to chart." />
  }
  if (shown.length === 0) {
    return <EmptyState icon={<IconCpu size={36} />} message={`No device matches "${search.trim()}".`} />
  }
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Choose a device to chart its readings</caption>
        <thead>
          <tr>
            <SortHeader sort={sort} column="device">Device</SortHeader>
            <SortHeader sort={sort} column="cell">Cell</SortHeader>
            <SortHeader sort={sort} column="area">Area</SortHeader>
          </tr>
        </thead>
        <tbody>
          {shown.map(d => (
            <tr key={d.asset_id}>
              <td>
                <RouteLink to={pickedAddress(d.asset_id, win)} className="count-link" title={`Chart ${d.asset_name}'s readings`}>
                  {d.asset_name}
                </RouteLink>
                {d.is_archived && <span className="badge badge-sm badge-neutral history-picker-badge">Archived</span>}
              </td>
              <td className="cell-meta">{d.cell_name ?? '—'}</td>
              <td className="cell-meta">{d.area_name ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The History page: a site's readings over time. Its one tab is Device, each metric of one device
 * charted over the window the time control sets. Ungated, as the Site Map is: what it charts is
 * what the telemetry views let the viewer read; its Export CSV needs `telemetry:read`. The address
 * names the device and the window (`/history/device/<id>?range=24h`); `/history` picks a device.
 */
export function HistoryTab({ hasPermission, showToast }) {
  const url = useUrl()
  const { deviceId } = historyPath(pathSegments(url))
  const [win, setWin] = useTimeWindow({ ranges: HISTORY_RANGES, fallback: DEFAULT_HISTORY_WINDOW, spans: HISTORY_SPANS })
  const [search, setSearch] = useUrlState('search', '')
  const [loaded, setLoaded] = useState(null)
  const [error, setError] = useState(null)
  // The refresh timer, in seconds, as Logs keeps it: in the page, not the address.
  const [every, setEvery] = useState(0)

  useEffect(() => {
    let live = true
    Promise.all([
      api.get('/api/v1/devices'),
      tolerated(api.get('/api/v1/cells')),
      tolerated(api.get('/api/v1/areas')),
      tolerated(api.get('/api/v1/schemas')),
      tolerated(api.get('/api/v1/metric-catalog')),
    ]).then(([devices, cells, areas, schemas, catalog]) => {
      if (live) setLoaded({ devices: historyDevices(devices || [], cells, areas), schemas, catalog })
    }).catch(e => { if (live) setError(e.message || 'The devices could not be read.') })
    return () => { live = false }
  }, [])

  const device = useMemo(
    () => (deviceId && loaded ? loaded.devices.find(d => deviceIdentifiers(d).includes(deviceId)) || null : null),
    [deviceId, loaded]
  )

  // A tab click starts the tab afresh, as the tab bars elsewhere do: the picker, at its own window.
  const openTab = () => navigate('/history')

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          <CardHeading
            icon={<IconChartLine size={15} />}
            title="History"
            description="A device's readings over a period you choose, each metric charted on one time axis."
          />
          <TabStrip ariaLabel="History" value="device" onChange={openTab} hrefFor={() => '/history'} tabs={HISTORY_TABS} />

          {error ? (
            <div className="callout callout-danger">{`The devices could not be read: ${error}`}</div>
          ) : !loaded ? (
            <LoadingState label="devices" />
          ) : deviceId ? (
            device ? (
              <HistoryDevice
                key={device.asset_id}
                device={device}
                devices={loaded.devices}
                schemas={loaded.schemas}
                catalog={loaded.catalog}
                win={win}
                setWin={setWin}
                every={every}
                setEvery={setEvery}
                hasPermission={hasPermission}
                showToast={showToast}
              />
            ) : (
              <EmptyState icon={<IconCpu size={36} />} message="No device answers to this address. It may have been deleted.">
                <RouteLink to={pickedAddress('', win)} className="count-link">Choose another device</RouteLink>
              </EmptyState>
            )
          ) : (
            <>
              <div className="filter-bar">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="Find a device…"
                  ariaLabel="Find a device by its name, id, cell or area"
                />
                <TimeWindowControl value={win} onChange={setWin} ranges={HISTORY_RANGES} spans={HISTORY_SPANS} />
              </div>
              <DevicePicker devices={loaded.devices} search={search} win={win} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

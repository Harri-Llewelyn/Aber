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
import { IconChartLine, IconCpu, IconLayoutDashboard } from '../common/Icons'
import { HISTORY_TABS } from '../../navigation'
import { navigate, pathSegments, useUrl, useUrlState } from '../../hooks/useUrlState'
import { useTimeWindow } from '../../hooks/useTimeWindow'
import { useSortableRows } from '../../hooks/useTableSort'
import { deviceIdentifiers } from '../../utils/sparkplugId'
import {
  CELL_PATH, CELL_TAB, DEFAULT_HISTORY_WINDOW, HISTORY_RANGES, HISTORY_SPANS, OVERVIEW_PATH, cellAddress, cellIdFrom, deviceHistoryPath,
  deviceMatches, historyCells, historyDevices, historyPath, pickedAddress,
} from '../../utils/history'
import { HistoryDevice } from './HistoryDevice'
import { HistoryAlerts } from './HistoryAlerts'
import { ALERTS_PATH, ALERTS_TAB } from '../../utils/alertHistory'
import { HistoryOverview } from './HistoryOverview'
import { HistoryCell } from './HistoryCell'

/** Each tab's own address, where a tab click starts it afresh. */
const TAB_PATHS = { overview: OVERVIEW_PATH, device: deviceHistoryPath(''), [CELL_TAB]: CELL_PATH, [ALERTS_TAB]: ALERTS_PATH }

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

/** The picker's sortable columns for cells; with none chosen, the cells are in name order. */
const CELL_SORT = {
  cell: { type: 'text', value: c => c.name },
  area: { type: 'text', value: c => c.area_name },
  machines: { type: 'number', value: c => c.machines.length },
}

/**
 * The cells as a table, each a link to its machines compared: the Cell tab with no cell chosen. The
 * toolbar's search narrows it by cell or area, and a heading sorts it.
 */
function CellPicker({ cells, search, win }) {
  const needle = search.trim().toLowerCase()
  const matching = useMemo(
    () => cells.filter(c => !needle || `${c.name} ${c.area_name ?? ''}`.toLowerCase().includes(needle)),
    [cells, needle]
  )
  const [shown, sort] = useSortableRows(matching, CELL_SORT)
  if (cells.length === 0) {
    return <EmptyState icon={<IconLayoutDashboard size={36} />} message="No cell is set up yet, so there are no machines to compare." />
  }
  if (shown.length === 0) {
    return <EmptyState icon={<IconLayoutDashboard size={36} />} message={`No cell matches "${search.trim()}".`} />
  }
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Choose a cell to compare its machines</caption>
        <thead>
          <tr>
            <SortHeader sort={sort} column="cell">Cell</SortHeader>
            <SortHeader sort={sort} column="area">Area</SortHeader>
            <SortHeader sort={sort} column="machines">Machines</SortHeader>
          </tr>
        </thead>
        <tbody>
          {shown.map(c => (
            <tr key={c.cell_id}>
              <td>
                <RouteLink to={cellAddress(c.cell_id, win)} className="count-link" title={`Compare the machines in ${c.name}`}>
                  {c.name}
                </RouteLink>
                {c.is_archived && <span className="badge badge-sm badge-neutral history-picker-badge">Archived</span>}
              </td>
              <td className="cell-meta">{c.area_name ?? '—'}</td>
              <td className="cell-meta">{c.machines.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The History page: a site's readings over time. Overview, its first tab and its default, shows
 * where readings arrived across every device; Device charts each metric of one device. Both take
 * the window the time control sets. Ungated, as the Site Map is: what it shows is what the
 * telemetry views let the viewer read; Export CSV, on the Device, Overview and Cell tabs, is for an
 * Administrator or a Shopfloor Manager. The
 * address names the tab, the device and the window: `/history` and `/history/overview` are the
 * Overview, `/history/device` picks a device, and `/history/device/<id>?range=24h` charts one.
 * The Cell tab compares one metric across the machines of a cell, `/history/cell` picks the cell and
 * `/history/cell/<id>?metric=…` compares them. The Alerts tab (`/history/alerts`) lists the alerts that fired over the same window; a row's
 * subject opens through `onSelectDevice` and `onSelectGateway`, and `userRole` lets its empty state
 * say what the viewer may not see. `userRole` also decides who may Export (an Administrator or a
 * Shopfloor Manager), and `showToast` is what an export reports to.
 */
export function HistoryTab({ showToast, userRole, onSelectDevice, onSelectGateway }) {
  const url = useUrl()
  const segments = pathSegments(url)
  const { tab: pathTab, deviceId } = historyPath(segments)
  // The Cell and Alerts tabs (HistoryCell.jsx, HistoryAlerts.jsx); historyPath() knows the other two.
  const tab = segments[1] === ALERTS_TAB ? ALERTS_TAB : segments[1] === CELL_TAB ? CELL_TAB : pathTab
  const cellId = cellIdFrom(segments)
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
      if (live) setLoaded({ devices: historyDevices(devices || [], cells, areas), cells, areas, schemas, catalog })
    }).catch(e => { if (live) setError(e.message || 'The devices could not be read.') })
    return () => { live = false }
  }, [])

  const device = useMemo(
    () => (deviceId && loaded ? loaded.devices.find(d => deviceIdentifiers(d).includes(deviceId)) || null : null),
    [deviceId, loaded]
  )

  const cells = useMemo(() => (loaded ? historyCells(loaded.cells, loaded.devices, loaded.areas) : []), [loaded])
  const cell = useMemo(() => (cellId ? cells.find(c => c.cell_id === cellId) || null : null), [cellId, cells])

  // A tab click starts the tab afresh, as the tab bars elsewhere do: at its own window, the Device
  // tab at its picker.
  const tabPath = (id) => TAB_PATHS[id] ?? `/history/${id}`
  const openTab = (id) => navigate(tabPath(id))

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          <CardHeading
            icon={<IconChartLine size={15} />}
            title="History"
            description="Where readings arrived across the site, a device's readings charted, and a cell's machines compared, over a period you choose."
          />
          <TabStrip ariaLabel="History" value={tab} onChange={openTab} hrefFor={tabPath} tabs={HISTORY_TABS} />

          {error ? (
            <div className="callout callout-danger">{`The devices could not be read: ${error}`}</div>
          ) : !loaded ? (
            <LoadingState label="devices" />
          ) : tab === 'overview' ? (
            <HistoryOverview
              devices={loaded.devices}
              cells={loaded.cells}
              areas={loaded.areas}
              schemas={loaded.schemas}
              win={win}
              setWin={setWin}
              every={every}
              setEvery={setEvery}
              userRole={userRole}
              showToast={showToast}
            />
          ) : tab === CELL_TAB ? (
            cellId ? (
              cell ? (
                <HistoryCell
                  key={cell.cell_id}
                  cell={cell}
                  cells={cells}
                  schemas={loaded.schemas}
                  catalog={loaded.catalog}
                  win={win}
                  setWin={setWin}
                  every={every}
                  setEvery={setEvery}
                  userRole={userRole}
                  showToast={showToast}
                />
              ) : (
                <EmptyState icon={<IconLayoutDashboard size={36} />} message="No cell answers to this address. It may have been deleted.">
                  <RouteLink to={cellAddress('', win)} className="count-link">Choose another cell</RouteLink>
                </EmptyState>
              )
            ) : (
              <>
                <div className="filter-bar">
                  <SearchInput value={search} onChange={setSearch} placeholder="Find a cell…" ariaLabel="Find a cell by its name or area" />
                  <TimeWindowControl value={win} onChange={setWin} ranges={HISTORY_RANGES} spans={HISTORY_SPANS} />
                </div>
                <CellPicker cells={cells} search={search} win={win} />
              </>
            )
          ) : tab === ALERTS_TAB ? (
            <HistoryAlerts
              devices={loaded.devices}
              win={win}
              setWin={setWin}
              every={every}
              setEvery={setEvery}
              userRole={userRole}
              onSelectDevice={onSelectDevice}
              onSelectGateway={onSelectGateway}
            />
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
                userRole={userRole}
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

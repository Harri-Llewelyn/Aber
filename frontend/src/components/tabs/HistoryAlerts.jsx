import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ALERT_HISTORY_LIMIT, api } from '../../api'
import { SearchInput } from '../common/SearchInput'
import { TimeWindowControl } from '../common/TimeWindowControl'
import { FilterDropdown } from '../common/FilterChecklist'
import { ClearFilters } from '../common/ClearFilters'
import { RefreshButton } from '../common/RefreshButton'
import { SortHeader } from '../common/SortHeader'
import { Badge } from '../common/Badge'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { OverflowText } from '../common/OverflowText'
import { RouteLink } from '../common/RouteLink'
import { Tooltip } from '../common/Tooltip'
import { IconAlertTriangle, IconBellOff, IconCheck } from '../common/Icons'
import { usePolling } from '../../hooks/usePolling'
import { useSetting } from '../../hooks/useSettings'
import { useSortableRows } from '../../hooks/useTableSort'
import { useUrlList, useUrlState } from '../../hooks/useUrlState'
import { deviceUrl, gatewayUrl } from '../../routes'
import { formatDateTime } from '../../utils/format'
import { reasonLabel } from '../../utils/alertAcknowledgement'
import { holdsNow, sameWindow, windowBounds } from '../../utils/timeWindow'
import {
  DEFAULT_HISTORY_WINDOW, ENDED_WINDOW_REASON, HISTORY_RANGES, HISTORY_REFRESH_EVERY, HISTORY_SPANS,
} from '../../utils/history'
import {
  ALERT_RETENTION_DAYS, ALERT_SORT, acknowledgerName, alertSubject, assetOptions, lengthText, occurrenceMatches,
  occurrenceRow, retentionWords, severityOf, subjectIndex,
} from '../../utils/alertHistory'

/** No asset chosen: every alert. Hoisted: useUrlList's default is compared, not copied. */
const ALL_ASSETS = Object.freeze([])

/** A read the tab can go on without: its rows, or [] when it failed. */
const tolerated = (load) => load.then(rows => rows || [], () => [])

/**
 * The Alert cell: the alert's name, and the summary its writer gave under it. Marks about the
 * occurrence itself go here, after the name.
 */
function AlertCell({ row }) {
  return (
    <div className="alert-history-name">
      <OverflowText className="alert-history-title">{row.alert_name}</OverflowText>
      {row.suppression_window_id && <SuppressedMark />}
      {row.summary && <OverflowText className="cell-meta">{row.summary}</OverflowText>}
    </div>
  )
}

/**
 * A suppression window covered the occurrence: the alert counter's crossed bell and word. The row's
 * stamp names the window that first covered it, not whether one covers it now or until when, so
 * no "until".
 */
function SuppressedMark() {
  return (
    <Tooltip text="A suppression window covered this alert while it fired. For that time it was not counted, and nothing was sent.">
      <span className="alert-pill-ack-words cell-meta" tabIndex={0}>
        <IconBellOff size={12} className="alert-pill-suppression-mark" aria-hidden="true" />
        <span>Suppressed</span>
      </span>
    </Tooltip>
  )
}

/**
 * The Subject cell: the device or gateway, a link that opens its drawer, as the alert counter's row
 * does; a platform or machine-identity alert in words, a link where it has a page of its own.
 */
function SubjectCell({ subject, onSelectDevice, onSelectGateway }) {
  if (subject.kind === 'device' || subject.kind === 'gateway') {
    if (!subject.sparkplugId) return <span className="cell-meta">—</span>
    const device = subject.kind === 'device'
    const onSelect = device ? onSelectDevice : onSelectGateway
    return (
      <RouteLink
        to={device ? deviceUrl(subject.sparkplugId) : gatewayUrl(subject.sparkplugId)}
        onNavigate={onSelect ? () => onSelect(subject.sparkplugId) : undefined}
        className={`count-link alert-history-subject${subject.known ? '' : ' mono'}`}
        title={`Show ${subject.name} on the ${device ? 'Devices' : 'Gateways'} page`}
      >
        <OverflowText>{subject.name}</OverflowText>
      </RouteLink>
    )
  }
  if (subject.page) {
    return (
      <RouteLink to={subject.page.to} className="count-link alert-history-subject" title={subject.page.title}>
        <OverflowText>{subject.name}</OverflowText>
      </RouteLink>
    )
  }
  return <span className="cell-meta">{subject.name}</span>
}

/**
 * The Ended cell: when it resolved, Firing while it still is, or, for one a later occurrence of the
 * same alert replaced, when that one started.
 */
function EndedCell({ row }) {
  if (row.firing) return <Badge tone="danger" size="sm" icon={<IconAlertTriangle size={11} aria-hidden="true" />}>Firing</Badge>
  if (row.replaced) {
    return (
      <Tooltip text="No resolve arrived for this occurrence. The same alert fired again at this time, and the next occurrence carries on.">
        <span tabIndex={0}>
          {formatDateTime(row.ended_at)} <span className="cell-meta">(fired again)</span>
        </span>
      </Tooltip>
    )
  }
  return <span>{formatDateTime(row.ended_at)}</span>
}

/** The Acknowledged cell: who, with a tick, then why and when, then their note; a dash for nobody. */
function AcknowledgedCell({ row }) {
  if (!row.acknowledged_at) return <span className="cell-meta">—</span>
  return (
    <div className="alert-history-ack">
      <span className="alert-history-ack-who">
        <IconCheck size={12} aria-hidden="true" /> <OverflowText>{acknowledgerName(row)}</OverflowText>
      </span>
      <span className="cell-meta">{reasonLabel(row.acknowledgement_reason)} · {formatDateTime(row.acknowledged_at)}</span>
      {row.acknowledgement_note && <OverflowText className="cell-meta">{row.acknowledgement_note}</OverflowText>}
    </div>
  )
}

/** The status line: how many alerts, how many still firing, and when the limit held some back. */
function countWords(rows, more) {
  const firing = rows.filter(r => r.firing).length
  const count = `${rows.length.toLocaleString()} ${rows.length === 1 ? 'alert' : 'alerts'}`
  const still = firing ? `, ${firing} still firing` : ''
  if (more) return `The newest ${count} in this window${still}. More fired: choose a shorter window or fewer assets.`
  return `${count} in this window${still}`
}

/**
 * History's Alerts tab: every alert occurrence that overlapped the window, from every writer, as
 * the viewer may read it (alert_occurrences(), 0243), newest first. One that started before the
 * window and was still firing in it is listed too. The toolbar's search narrows the rows; Asset
 * keeps the devices and gateways chosen, in the read itself. The window, the assets and the search
 * are in the address (`/history/alerts?from=…&to=…&asset=…`). Refresh and its timer are the
 * page's, as on the Device tab. A row's subject opens its drawer. Nothing here writes.
 */
export function HistoryAlerts({ devices, win, setWin, every, setEvery, userRole, onSelectDevice, onSelectGateway }) {
  const [gateways, setGateways] = useState(null)
  const [search, setSearch] = useUrlState('search', '')
  const [reading, setReading] = useState(null)
  const retentionDays = useSetting('alerts.retention_days', ALERT_RETENTION_DAYS)
  // Each read's number: only the newest may land, so a slow read never draws over a later one.
  const latestRead = useRef(0)

  useEffect(() => {
    let live = true
    tolerated(api.get('/api/v1/gateways')).then(rows => { if (live) setGateways(rows) })
    return () => { live = false }
  }, [])

  const options = useMemo(() => (gateways ? assetOptions(devices, gateways) : []), [devices, gateways])
  const offered = useMemo(() => (gateways ? options.map(o => o.value) : null), [gateways, options])
  const [assets, setAssets] = useUrlList('asset', ALL_ASSETS, { allowed: offered })
  const index = useMemo(() => subjectIndex(devices, gateways || []), [devices, gateways])

  const windowKey = JSON.stringify(win)
  const assetsKey = assets.join(',')
  const read = useCallback(async (signal) => {
    const id = ++latestRead.current
    const at = Date.now()
    const { start, end } = windowBounds(win, at)
    if (!start || !end || end <= start) {
      setReading({ problem: 'Set both ends of the custom range to list its alerts.' })
      return
    }
    setReading(r => ({ ...(r?.rows ? r : {}), loading: true }))
    try {
      const data = await api.readAlertOccurrences({
        from: start.toISOString(), to: end.toISOString(), sparkplugIds: assets.length ? assets : null,
      }, { signal })
      if (id !== latestRead.current) return
      setReading({ rows: data.slice(0, ALERT_HISTORY_LIMIT).map(occurrenceRow), more: data.length > ALERT_HISTORY_LIMIT, at, start: start.getTime() })
    } catch (e) {
      if (e?.name !== 'AbortError' && !signal?.aborted && id === latestRead.current) {
        setReading({ error: e?.message || 'The alerts could not be read.' })
      }
      // Rethrown so usePolling backs off on a failing read rather than hammering it.
      throw e
    }
    // The window and the assets by value: a new object of the same window is the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey, assetsKey])

  useEffect(() => {
    const controller = new AbortController()
    read(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [read])

  const live = holdsNow(win, Date.now())
  usePolling(read, every * 1000, live && every > 0)

  const rows = useMemo(
    () => (reading?.rows || []).map(r => ({ ...r, now: reading.at, subject: alertSubject(r, index) })),
    [reading, index]
  )
  const matching = useMemo(() => rows.filter(r => occurrenceMatches(r, r.subject, search)), [rows, search])
  const [shown, sort] = useSortableRows(matching, ALERT_SORT)

  const filterCount = [!sameWindow(win, DEFAULT_HISTORY_WINDOW), assets.length > 0].filter(Boolean).length
  const clear = () => { setWin(DEFAULT_HISTORY_WINDOW); setAssets(ALL_ASSETS) }
  const busy = Boolean(reading?.loading) || reading === null
  const mayReadEvery = userRole === 'Administrator'
  const retention = reading?.rows ? retentionWords(reading.start, reading.at, retentionDays) : null

  return (
    <>
      <div className="filter-bar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Find an alert…"
          ariaLabel="Find an alert by its name, summary, subject or who acknowledged it"
        />
        <TimeWindowControl value={win} onChange={setWin} ranges={HISTORY_RANGES} spans={HISTORY_SPANS} zoom />
        <FilterDropdown
          label="Asset"
          noun="asset"
          plural="assets"
          options={options}
          value={assets}
          onChange={setAssets}
          words={v => (v.length === 0 ? 'Every asset' : null)}
          width="sm"
          tip="List only the alerts on the devices and gateways you choose"
        />
        <div className="filter-bar-actions">
          <ClearFilters count={filterCount} onClear={clear} />
          <RefreshButton
            onRefresh={() => read().catch(() => {})}
            busy={busy}
            every={live ? every : 0}
            onEveryChange={setEvery}
            choices={HISTORY_REFRESH_EVERY}
            everyDisabledReason={live ? null : ENDED_WINDOW_REASON}
          />
        </div>
      </div>

      {reading?.problem ? (
        <EmptyState icon={<IconAlertTriangle size={36} />} message={reading.problem} />
      ) : reading?.error ? (
        <div className="callout callout-danger">{`The alerts could not be read: ${reading.error}`}</div>
      ) : !reading?.rows ? (
        <LoadingState label="alerts" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<IconAlertTriangle size={36} />}
          filtered={assets.length > 0}
          message={mayReadEvery
            ? 'No alert fired in this window.'
            : 'No alert you may see fired in this window. Alerts about a machine identity are listed for Administrators only.'}
          filteredMessage="No alert fired on the assets chosen in this window."
        >
          {retention && <p className="form-hint">{retention}</p>}
        </EmptyState>
      ) : (
        <>
          <div className="groups-header">
            <p className="history-meta" role="status">
              {countWords(rows, reading.more)}
              {retention && ` ${retention}`}
              {reading.loading && ' · reading again…'}
            </p>
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={<IconAlertTriangle size={36} />} message={`No alert in this window matches "${search.trim()}".`} />
          ) : (
            <div className="table-wrap alert-history-table">
              <table>
                <caption className="sr-only">The alerts that fired in this window, newest first</caption>
                <thead>
                  <tr>
                    <SortHeader sort={sort} column="alert" title="The alert's name, with the summary it was raised with">Alert</SortHeader>
                    <SortHeader sort={sort} column="severity" title="How serious its rule says it is">Severity</SortHeader>
                    <SortHeader sort={sort} column="subject" title="The device or gateway it was about. Select it to open its drawer.">Subject</SortHeader>
                    <SortHeader sort={sort} column="started" title="When it started firing">Started</SortHeader>
                    <SortHeader sort={sort} column="ended" title="When it stopped firing, or Firing while it still is">Ended</SortHeader>
                    <SortHeader sort={sort} column="length" title="How long it fired, so far while it still is">Duration</SortHeader>
                    <SortHeader sort={sort} column="acknowledged" title="Who acknowledged it, why and when, and their note">Acknowledged</SortHeader>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(r => (
                    <tr key={r.id}>
                      <td><AlertCell row={r} /></td>
                      <td><Badge tone={severityOf(r.severity).tone} size="sm">{severityOf(r.severity).label}</Badge></td>
                      <td><SubjectCell subject={r.subject} onSelectDevice={onSelectDevice} onSelectGateway={onSelectGateway} /></td>
                      <td className="alert-history-time">{formatDateTime(r.starts_at)}</td>
                      <td className="alert-history-time"><EndedCell row={r} /></td>
                      <td className="alert-history-time">{lengthText(r, reading.at)}</td>
                      <td><AcknowledgedCell row={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  )
}

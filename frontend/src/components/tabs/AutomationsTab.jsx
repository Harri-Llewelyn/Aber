import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { REALTIME_ENABLED, refreshInterval } from '../../constants'
import { navigate, pathSegments, queryOf, useUrl, useUrlState } from '../../hooks/useUrlState'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useSortableRows } from '../../hooks/useTableSort'
import { automationUrl, automationsUrl, newAutomationUrl } from '../../routes'
import { ActionButton } from '../common/ActionButton'
import { CardHeading } from '../common/CardHeading'
import { ClearFilters } from '../common/ClearFilters'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { OverflowText } from '../common/OverflowText'
import { RouteLink } from '../common/RouteLink'
import { SearchInput } from '../common/SearchInput'
import { SortHeader, ColumnHeader } from '../common/SortHeader'
import { Tooltip } from '../common/Tooltip'
import { IconDownload, IconPlus, IconUpload, IconX, IconZap } from '../common/Icons'
import { ApplyAutomationsModal } from '../modals/ApplyAutomationsModal'
import { AutomationDetail } from './AutomationDetail'
import { AUTOMATION_FILE_MAX_BYTES, renderAutomationsYaml } from '../../utils/automationYaml'
import { downloadBlob } from '../../utils/downloadBlob'
import { formatDateTime, formatRelative, plural } from '../../utils/format'
import { isUuid } from '../../utils/isUuid'
import { severityOf } from '../../utils/alertHistory'
import {
  APPLIES_BECAUSE, AUTOMATIONS_FILE_NAME, AUTOMATION_WRITE_TITLE, automationEntries, mayWriteAutomations, reasonsByKey, worstSeverity,
} from '../../utils/automations'

/** The list's sortable columns; with none chosen, the automations are in name order. */
const COLUMNS = {
  alias: { type: 'text', value: e => e.alias },
  enabled: { type: 'number', value: e => (e.enabled ? 1 : 0) },
  firing: { type: 'number', value: e => e.firing.length },
  last: { type: 'time', value: e => e.lastFiredAt },
}

/** The key a path segment names, or null for a segment that is not valid percent-encoding. */
const keyFrom = (segment) => {
  if (!segment) return null
  try { return decodeURIComponent(segment) } catch { return null }
}

/**
 * The Automations list: every automation with its alias, what its triggers watch in words, whether it
 * is enabled, whether it is firing now and when it last fired. Search narrows it; `?entity=<uuid>`
 * narrows it to the automations that apply to one device, each with why. A row's switch enables or
 * disables it at once (set_automation_enabled(), audited), and a row's checkbox picks it for the
 * toolbar's Export, which exports the selection, or every automation with none.
 */
function AutomationList({ showToast, canWrite, onExport, onUpload, version }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [search, setSearch] = useUrlState('search', '')
  const [entityId, setEntityId] = useUrlState('entity', '', { allowed: v => v === '' || isUuid(v) })
  // The entity the filter names, and the reason each automation applies to it.
  const [entity, setEntity] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [changing, setChanging] = useState(null)

  const load = useCallback(async (signal) => {
    try {
      setData(await api.readAutomations({ signal }))
      setError(null)
    } catch (e) {
      setError(e.message || 'The automations could not be read.')
      throw e
    }
  }, [])
  usePolling(load, refreshInterval())
  // An alert firing or resolving changes what the list says; the polling is the reconciliation.
  useRealtimeTable('platform_alerts', load, { enabled: REALTIME_ENABLED })
  // After an upload or any other write elsewhere on the page.
  useEffect(() => { if (version > 0) load().catch(() => {}) }, [version, load])

  const filtered = entityId !== ''
  useEffect(() => {
    if (!filtered) { setEntity(null); return undefined }
    let live = true
    Promise.all([
      api.automationsForEntity(entityId),
      api.resolveId(entityId).catch(() => []),
    ]).then(([rows, found]) => {
      if (live) setEntity({ id: entityId, name: found[0]?.name ?? null, reasons: reasonsByKey(rows) })
    }).catch(() => { if (live) setEntity({ id: entityId, name: null, reasons: new Map() }) })
    return () => { live = false }
  }, [entityId, filtered, version])

  const entries = useMemo(() => (data ? automationEntries(data) : []), [data])
  const needle = search.trim().toLowerCase()
  const shown = useMemo(() => entries
    .filter(e => !filtered || !entity || entity.reasons.has(e.key))
    .filter(e => !needle || e.search.includes(needle)), [entries, filtered, entity, needle])
  const [rows, sort] = useSortableRows(shown, COLUMNS)

  const clear = () => { setSearch(''); setEntityId('') }
  const filterCount = (needle ? 1 : 0) + (entityId ? 1 : 0)

  const toggle = (e) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(e.key)) next.delete(e.key); else next.add(e.key)
      return next
    })
  }
  const allShown = rows.length > 0 && rows.every(r => selected.has(r.key))
  const someShown = rows.some(r => selected.has(r.key))
  const headBox = useRef(null)
  useEffect(() => { if (headBox.current) headBox.current.indeterminate = someShown && !allShown }, [someShown, allShown])
  const toggleAll = () => setSelected(prev => {
    const next = new Set(prev)
    for (const r of rows) { if (allShown) next.delete(r.key); else next.add(r.key) }
    return next
  })
  // Only what is still in the list: a deleted automation leaves the selection.
  const picked = entries.filter(e => selected.has(e.key)).map(e => e.key)

  const setEnabled = async (e, enabled) => {
    // The switch is disabled for a reader; the database would refuse the call all the same.
    if (!canWrite) return
    setChanging(e.key)
    try {
      await api.setAutomationEnabled(e.key, enabled)
      showToast(`Automation '${e.alias}' ${enabled ? 'enabled' : 'disabled'}`, 'success', { to: automationUrl(e.key) })
      await load().catch(() => {})
    } catch (err) {
      showToast(err.message || 'The automation could not be changed', 'error')
    } finally {
      setChanging(null)
    }
  }

  const chip = entityId ? (
    <span className="automation-chip">
      <span>Applies to <strong>{entity?.name || entityId}</strong></span>
      <Tooltip text="Show every automation again">
        <button type="button" className="automation-chip-clear" aria-label="Show every automation, not only those that apply to this entity" onClick={() => setEntityId('')}>
          <IconX size={11} aria-hidden="true" />
        </button>
      </Tooltip>
    </span>
  ) : null

  const loading = data === null && !error
  const waiting = loading || (filtered && entity === null)

  return (
    <>
      <div className="filter-bar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search automations…"
          ariaLabel="Search automations by name, id, metric or device"
        />
        {chip}
        <div className="filter-bar-actions">
          <ClearFilters count={filterCount} onClear={clear} />
          <ActionButton
            className="btn btn-primary btn-sm"
            permitted={canWrite}
            deniedTitle={AUTOMATION_WRITE_TITLE}
            title="Choose an automations.yaml file. It is checked and shown to you before anything changes"
            onClick={onUpload}
          >
            <IconUpload size={13} aria-hidden="true" /> Upload
          </ActionButton>
          <ActionButton
            className="btn btn-primary btn-sm"
            disabled={entries.length === 0}
            title={picked.length
              ? `Download the ${plural(picked.length, 'automation')} you ticked as ${AUTOMATIONS_FILE_NAME}`
              : entries.length === 0 ? 'There is no automation to export' : `Download every automation as ${AUTOMATIONS_FILE_NAME}. Tick some to export only those`}
            onClick={() => onExport(picked.length ? picked : null)}
          >
            <IconDownload size={13} aria-hidden="true" /> {picked.length ? `Export ${picked.length}` : 'Export'}
          </ActionButton>
          <ActionButton
            className="btn btn-primary btn-sm"
            permitted={canWrite}
            deniedTitle={AUTOMATION_WRITE_TITLE}
            title="Write a new automation in the YAML editor, from an example"
            onClick={() => navigate(newAutomationUrl())}
          >
            <IconPlus size={13} aria-hidden="true" /> New Automation
          </ActionButton>
        </div>
      </div>

      {error && data === null ? (
        <div className="callout callout-danger">{`The automations could not be read: ${error}`}</div>
      ) : waiting ? (
        <LoadingState label="automations" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<IconZap size={36} />}
          filtered={entries.length > 0}
          message="No automation yet. Choose New Automation to write one, or Upload to apply a file of them."
          filteredMessage={needle
            ? <>No automation matches <strong>{search.trim()}</strong>.</>
            : 'No automation applies to this entity. An automation applies when a trigger names it, or is site-wide.'}
        />
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Automations, with what each watches and whether it is firing</caption>
            <thead>
              <tr>
                <th className="automation-select">
                  <input
                    ref={headBox}
                    type="checkbox"
                    aria-label="Select every automation shown"
                    checked={allShown}
                    onChange={toggleAll}
                  />
                </th>
                <SortHeader sort={sort} column="alias" title="The name each automation is given, with its id under it">Automation</SortHeader>
                <ColumnHeader title="What its triggers watch, in words. Open the automation to read them in full.">Watches</ColumnHeader>
                {entity && <ColumnHeader title="Why the automation applies to this entity">Applies because</ColumnHeader>}
                <SortHeader sort={sort} column="enabled" title="Whether it is evaluated. Turning one off resolves its open alerts.">Enabled</SortHeader>
                <SortHeader sort={sort} column="firing" title="How many alerts it is raising now, one for each device that breaches">Firing now</SortHeader>
                <SortHeader sort={sort} column="last" title="When it last raised an alert">Last fired</SortHeader>
              </tr>
            </thead>
            <tbody>
              {rows.map(e => {
                const worst = worstSeverity(e.firing)
                return (
                  <tr key={e.key} className={selected.has(e.key) ? 'row-selected' : undefined}>
                    <td className="automation-select">
                      <input
                        type="checkbox"
                        aria-label={`Select ${e.alias}`}
                        checked={selected.has(e.key)}
                        onChange={() => toggle(e)}
                      />
                    </td>
                    <td>
                      <RouteLink to={automationUrl(e.key)} className="count-link" title={`Open ${e.alias}`}>
                        <strong>{e.alias}</strong>
                      </RouteLink>
                      <div className="cell-meta mono">{e.key}</div>
                    </td>
                    <td className="automation-summary">
                      <Tooltip text={e.summary}>
                        <span tabIndex={0} className="automation-summary-text"><OverflowText>{e.summary}</OverflowText></span>
                      </Tooltip>
                    </td>
                    {entity && (
                      <td>
                        {(entity.reasons.get(e.key) || []).map(reason => (
                          <Tooltip key={reason} text={APPLIES_BECAUSE[reason]?.title}>
                            <span className="badge badge-sm badge-neutral automation-reason" tabIndex={0}>{APPLIES_BECAUSE[reason]?.label ?? reason}</span>
                          </Tooltip>
                        ))}
                      </td>
                    )}
                    <td>
                      <Tooltip text={canWrite ? undefined : AUTOMATION_WRITE_TITLE}>
                        <label className="automation-switch">
                          <input
                            type="checkbox"
                            role="switch"
                            aria-label={`Enabled: ${e.alias}`}
                            checked={e.enabled}
                            disabled={!canWrite || changing === e.key}
                            onChange={ev => setEnabled(e, ev.target.checked)}
                          />
                          <span aria-hidden="true">{e.enabled ? 'On' : 'Off'}</span>
                        </label>
                      </Tooltip>
                    </td>
                    <td>
                      {e.firing.length > 0
                        ? <span className={`badge badge-sm badge-${severityOf(worst).tone}`}>{e.firing.length} firing</span>
                        : <span className="cell-meta">—</span>}
                    </td>
                    <td className="cell-meta">
                      {e.lastFiredAt
                        ? <Tooltip text={formatDateTime(e.lastFiredAt)}><span tabIndex={0}>{formatRelative(e.lastFiredAt)}</span></Tooltip>
                        : 'Never'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/**
 * An alert's link: `/automations?trigger=<trigger id>`. The fingerprint names the trigger and not the
 * automation, so the page finds the automation that owns it and opens that one.
 */
function TriggerRedirect({ triggerId }) {
  const [gone, setGone] = useState(false)
  useEffect(() => {
    let live = true
    api.automationOfTrigger(triggerId).then(
      found => {
        if (!live) return
        if (found) navigate(automationUrl(found.key), { replace: true })
        else setGone(true)
      },
      () => { if (live) setGone(true) }
    )
    return () => { live = false }
  }, [triggerId])
  if (!gone) return <LoadingState label="automation" />
  return (
    <EmptyState icon={<IconZap size={36} />} message="The automation that raised this alert has been deleted.">
      <RouteLink to={automationsUrl()} className="count-link">Show every automation</RouteLink>
    </EmptyState>
  )
}

/**
 * The Automations page: rules that watch a device's readings and raise an alert, each kept as rows
 * and written as YAML. `/automations` is the list, `/automations/<id>` one automation in the editor,
 * `/automations/new` the editor on an example, and `/automations?entity=<uuid>` the list of those
 * that apply to one device. Ungated: every role reads. Administrators and Shopfloor Managers write,
 * and for anyone else the page shows no control that would refuse them.
 */
export function AutomationsTab({ showToast, userRole, hasPermission }) {
  const url = useUrl()
  const segments = pathSegments(url)
  const params = queryOf(url)
  const second = keyFrom(segments[1])
  const canWrite = mayWriteAutomations(userRole)
  const triggerId = params.get('trigger')

  // A file chosen to upload, as text, to be checked and shown before it applies.
  const [upload, setUpload] = useState(null)
  const [version, setVersion] = useState(0)
  const fileRef = useRef(null)

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    // The same file chosen twice must raise the change again.
    e.target.value = ''
    if (!file) return
    if (file.size > AUTOMATION_FILE_MAX_BYTES) {
      showToast(`${file.name} is larger than ${AUTOMATION_FILE_MAX_BYTES / (1024 * 1024)} MiB, more than a file of automations holds`, 'error')
      return
    }
    try {
      setUpload({ name: file.name, text: await file.text() })
    } catch {
      showToast(`${file.name} could not be read`, 'error')
    }
  }

  const exportAutomations = async (keys) => {
    try {
      const { automations, devices } = await api.automationsDocument(keys)
      if (automations.length === 0) {
        showToast('There is no automation to export', 'error')
        return
      }
      const text = renderAutomationsYaml(automations, devices)
      downloadBlob(new Blob([text], { type: 'application/yaml;charset=utf-8' }), AUTOMATIONS_FILE_NAME)
      showToast(`Exported ${plural(automations.length, 'automation')} to ${AUTOMATIONS_FILE_NAME}`, 'success')
    } catch (e) {
      showToast(e.message || 'The automations could not be exported', 'error')
    }
  }

  const applied = () => {
    setUpload(null)
    setVersion(v => v + 1)
  }

  const newRoute = second === 'new' && !params.has('open')
  let body
  if (second !== null && segments.length > 1) {
    body = newRoute
      ? <AutomationDetail key="new" automationKey={null} showToast={showToast} canWrite={canWrite} hasPermission={hasPermission} onExport={exportAutomations} />
      : <AutomationDetail key={second} automationKey={second} showToast={showToast} canWrite={canWrite} hasPermission={hasPermission} onExport={exportAutomations} />
  } else if (triggerId && isUuid(triggerId)) {
    body = <TriggerRedirect triggerId={triggerId} />
  } else {
    body = (
      <AutomationList
        showToast={showToast}
        canWrite={canWrite}
        onExport={exportAutomations}
        onUpload={() => fileRef.current?.click()}
        version={version}
      />
    )
  }

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          <CardHeading
            icon={<IconZap size={15} />}
            title="Automations"
            description="Rules that watch a device's readings and raise an alert. Write one as YAML here, or upload a file of them."
          />
          {body}
          <input
            ref={fileRef}
            type="file"
            className="sr-only"
            accept=".yaml,.yml,text/yaml,application/yaml,application/x-yaml"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="automations-file"
            onChange={onFile}
          />
        </div>
      </div>

      {upload && (
        <ApplyAutomationsModal
          text={upload.text}
          source={upload.name}
          verb="Apply"
          showToast={showToast}
          onApplied={applied}
          onClose={() => setUpload(null)}
        />
      )}
    </div>
  )
}

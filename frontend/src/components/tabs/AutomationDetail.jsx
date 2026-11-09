import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS, refreshInterval } from '../../constants'
import { navigate } from '../../hooks/useUrlState'
import { usePolling } from '../../hooks/usePolling'
import { automationUrl, automationsUrl, deviceUrl, trailUrl } from '../../routes'
import { ActionButton } from '../common/ActionButton'
import CopyableId from '../common/CopyableId'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { OverflowText } from '../common/OverflowText'
import { RouteLink } from '../common/RouteLink'
import { AutomationEditor } from '../common/AutomationEditor'
import { ConfirmModal } from '../modals/ConfirmModal'
import { ApplyAutomationsModal } from '../modals/ApplyAutomationsModal'
import { IconCheck, IconChevronLeft, IconDownload, IconHistory, IconTrash, IconZap } from '../common/Icons'
import { renderAutomationsYaml } from '../../utils/automationYaml'
import { buildFacts } from '../../utils/automationEditorHelp'
import { historyDevices } from '../../utils/history'
import {
  AUTOMATION_EXAMPLE, AUTOMATION_WRITE_TITLE, fingerprintParts, pairsText, recentFirings, schemaComment,
} from '../../utils/automations'
import { severityOf, lengthText } from '../../utils/alertHistory'
import { formatDateTime } from '../../utils/format'

/** A read the editor can go on without: its rows, or [] when it failed. */
const tolerated = (load) => load.then(rows => rows || [], () => [])

/** How many recent firings the page lists. */
const FIRINGS_SHOWN = 20

/**
 * One automation, or a new one: its YAML in the editor, rendered from `automations_document([key])`
 * and written again on every save, then what it has fired. Save checks the text first
 * (ApplyAutomationsModal) and applies it only when confirmed; Delete asks; Enable and Disable act
 * at once, as in the list. The editor is read-only for a role that may not write.
 *
 * `automationKey` is null for a new automation, which starts from the example in docs/automations.md.
 */
export function AutomationDetail({ automationKey, showToast, canWrite, hasPermission, onExport }) {
  const isNew = automationKey === null
  // `base` is what the database rendered; `text` is what the editor holds.
  const [base, setBase] = useState(null)
  const [text, setText] = useState('')
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState(null)
  const [site, setSite] = useState(null)
  const [alerts, setAlerts] = useState({ active: [], history: [] })
  const [refusals, setRefusals] = useState(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [toggling, setToggling] = useState(false)
  const baseText = useRef('')
  baseText.current = base?.text ?? ''
  const editedText = useRef('')
  editedText.current = text

  /** Reads the automation, as the database renders it. `keepEdits` leaves what the person typed. */
  const load = useCallback(async ({ keepEdits = false } = {}) => {
    if (isNew) {
      setBase({ text: AUTOMATION_EXAMPLE, devices: {}, automation: null, row: null })
      if (!keepEdits) setText(AUTOMATION_EXAMPLE)
      return
    }
    try {
      const [doc, row] = await Promise.all([api.automationsDocument([automationKey]), api.automationRow(automationKey)])
      if (doc.automations.length === 0 || !row) {
        setMissing(true)
        return
      }
      setMissing(false)
      const rendered = renderAutomationsYaml(doc.automations, doc.devices)
      const clean = editedText.current === baseText.current
      setBase({ text: rendered, devices: doc.devices, automation: doc.automations[0], row })
      if (!keepEdits || clean) setText(rendered)
      setError(null)
    } catch (e) {
      setError(e.message || 'The automation could not be read.')
    }
  }, [automationKey, isNew])

  useEffect(() => { load() }, [load])

  // What the editor knows of this site. Each read is tolerated: the editor completes less without one.
  useEffect(() => {
    let live = true
    Promise.all([
      tolerated(api.get('/api/v1/devices')),
      tolerated(api.get('/api/v1/cells')),
      tolerated(api.get('/api/v1/areas')),
      tolerated(api.get('/api/v1/schemas')),
      tolerated(api.get('/api/v1/metric-catalog')),
    ]).then(([devices, cells, areas, schemas, catalog]) => {
      if (live) setSite({ devices: historyDevices(devices, cells, areas), schemas, catalog })
    })
    return () => { live = false }
  }, [])

  const facts = useMemo(
    () => (site ? buildFacts({ ...site, documentDevices: base?.devices ?? {} }) : null),
    [site, base]
  )

  const loadAlerts = useCallback(async (signal) => {
    setAlerts(await api.readAutomationAlerts({ signal }))
  }, [])
  usePolling(loadAlerts, refreshInterval(), !isNew)

  const dirty = base !== null && text !== base.text
  // Closing or reloading the tab with edits unsaved asks first, as the browser does for any page.
  useEffect(() => {
    if (!dirty) return undefined
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const change = (next) => {
    setText(next)
    // Marks of a refusal are for the text it refused; any edit makes them stale.
    setRefusals(null)
  }

  const alias = base?.automation?.alias ?? automationKey
  const enabled = base?.automation?.enabled

  const entry = useMemo(() => (base?.row
    ? { triggerIds: new Set((base.row.automation_triggers || []).map(t => t.id)) }
    : null), [base])
  const firings = useMemo(() => (entry ? recentFirings(entry, alerts.history, FIRINGS_SHOWN) : []), [entry, alerts])
  const firingNow = useMemo(() => firings.filter(f => f.firing), [firings])

  const toggle = async () => {
    setToggling(true)
    try {
      await api.setAutomationEnabled(automationKey, !enabled)
      showToast(`Automation '${alias}' ${enabled ? 'disabled' : 'enabled'}`, 'success', { to: automationUrl(automationKey) })
      await load({ keepEdits: true })
    } catch (e) {
      showToast(e.message || 'The automation could not be changed', 'error')
    } finally {
      setToggling(false)
    }
  }

  const applied = async (results) => {
    setSaving(false)
    const written = results.filter(r => r.status === 'new' || r.status === 'changed')
    const only = written.length === 1 ? written[0] : null
    // Saved under another id: that automation's page is the one to show; the old one is as it was.
    if (only && only.key !== automationKey) navigate(automationUrl(only.key), { replace: isNew })
    else await load()
  }

  const remove = async () => {
    await api.deleteAutomation(automationKey)
    setDeleting(false)
    showToast(`Automation '${alias}' deleted`, 'success', { to: automationsUrl() })
    navigate(automationsUrl())
  }

  const canReadTrail = hasPermission?.(PERMISSION_UUIDS.AUDIT_TRAIL_READ)
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  const back = (
    <RouteLink to={automationsUrl()} className="btn btn-ghost btn-sm" title="Back to every automation">
      <IconChevronLeft size={13} aria-hidden="true" /> Automations
    </RouteLink>
  )

  if (missing) {
    return (
      <>
        <div className="filter-bar">{back}</div>
        <EmptyState icon={<IconZap size={36} />} message={<>No automation has the id <strong className="mono">{automationKey}</strong>. It may have been deleted.</>} />
      </>
    )
  }
  if (error && !base) return <div className="callout callout-danger">{`The automation could not be read: ${error}`}</div>
  if (!base) return <LoadingState label="automation" />

  return (
    <>
      <div className="filter-bar">
        {back}
        <div className="filter-bar-actions">
          {!isNew && (
            <ActionButton
              className="btn btn-primary btn-sm"
              permitted={canWrite}
              deniedTitle={AUTOMATION_WRITE_TITLE}
              pending={toggling}
              pendingLabel={enabled ? 'Disabling…' : 'Enabling…'}
              title={enabled
                ? 'Turn this automation off. Its open alerts resolve.'
                : 'Turn this automation on. It needs a trigger that names a live device.'}
              onClick={toggle}
            >
              {enabled ? 'Disable' : 'Enable'}
            </ActionButton>
          )}
          {!isNew && (
            <ActionButton
              className="btn btn-primary btn-sm"
              title="Download this automation as automations.yaml"
              onClick={() => onExport([automationKey])}
            >
              <IconDownload size={13} aria-hidden="true" /> Export
            </ActionButton>
          )}
          {!isNew && (
            <ActionButton
              className="btn btn-primary btn-sm"
              permitted={canWrite}
              deniedTitle={AUTOMATION_WRITE_TITLE}
              title="Delete this automation. Its open alerts resolve"
              onClick={() => setDeleting(true)}
            >
              <IconTrash size={13} aria-hidden="true" /> Delete
            </ActionButton>
          )}
          <ActionButton
            className="btn btn-primary btn-sm"
            permitted={canWrite}
            deniedTitle={AUTOMATION_WRITE_TITLE}
            disabled={!isNew && !dirty}
            title={!isNew && !dirty ? 'Nothing has changed since this was read' : 'Check the YAML, and see what saving it would do, before anything is written'}
            onClick={() => setSaving(true)}
          >
            <IconCheck size={13} aria-hidden="true" /> Save
          </ActionButton>
        </div>
      </div>

      <div className="automation-body card-fill-scroll">
        <div className="automation-head">
          <h4 className="automation-title">{isNew ? 'New automation' : alias}</h4>
          {!isNew && (
            <span className={`badge badge-sm ${enabled ? 'badge-success' : 'badge-neutral'}`}>{enabled ? 'Enabled' : 'Disabled'}</span>
          )}
          {firingNow.length > 0 && (
            <span className={`badge badge-sm badge-${severityOf(worstOf(firingNow)).tone}`}>{firingNow.length} firing now</span>
          )}
          {isNew && <span className="automation-hint">Starts from the example in the reference. Replace its device with one of yours.</span>}
        </div>

        <p className="automation-note">
          Comments you type here are not kept: put words in <code>description:</code>. The name beside each device id is written again every time this opens.
        </p>

        <AutomationEditor
          value={text}
          onChange={change}
          facts={facts}
          refusals={refusals}
          readOnly={!canWrite}
        />

        <div className="automation-schema-line">
          <span>In VS Code, start your own file with this line to get the same help:</span>
          <CopyableId value={schemaComment(origin)} label="schema line" onNotify={showToast} truncate="end" />
        </div>

        {!isNew && (
          <section className="automation-section" aria-labelledby="automation-firings">
            <h4 className="automation-section-title" id="automation-firings">Recent firings</h4>
            {firings.length === 0 ? (
              <p className="automation-note">This automation has not fired yet.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">The most recent times this automation raised an alert, newest first</caption>
                  <thead>
                    <tr>
                      <th>Started</th>
                      <th>Device</th>
                      <th>Metric</th>
                      <th>Severity</th>
                      <th>State</th>
                      <th>Labels</th>
                      <th>Values</th>
                    </tr>
                  </thead>
                  <tbody>
                    {firings.map(f => {
                      const parts = fingerprintParts(f.fingerprint)
                      const named = base.devices?.[f.entity_id ?? parts?.deviceId]
                      const severity = severityOf(f.severity)
                      return (
                        <tr key={f.id}>
                          <td className="cell-meta">{formatDateTime(f.starts_at)}</td>
                          <td>
                            {f.entity_id ? (
                              <RouteLink to={deviceUrl(f.entity_id)} className="count-link" title="Open this device">
                                {named?.name || f.sparkplug_id || f.entity_id}
                              </RouteLink>
                            ) : '—'}
                          </td>
                          <td className="mono">{parts?.metric ?? '—'}</td>
                          <td><span className={`badge badge-sm badge-${severity.tone}`}>{severity.label}</span></td>
                          <td className="cell-meta">{f.firing ? `Firing · ${lengthText(f)}` : `Ended · ${lengthText(f)}`}</td>
                          <td className="automation-pairs"><OverflowText>{pairsText(f.labels) || '—'}</OverflowText></td>
                          <td className="automation-pairs"><OverflowText>{pairsText(f.values) || '—'}</OverflowText></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {!isNew && canReadTrail && base.row && (
          <p className="automation-trail">
            <RouteLink to={trailUrl(base.row.id, 'AUTOMATION')} className="count-link" title="Open the Audit Trail on this automation's own history">
              <IconHistory size={13} aria-hidden="true" /> View Audit Trail
            </RouteLink>
          </p>
        )}
      </div>

      {saving && (
        <ApplyAutomationsModal
          text={text}
          verb="Save"
          showToast={showToast}
          onChecked={setRefusals}
          onApplied={applied}
          onClose={() => setSaving(false)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete automation"
          icon={<IconTrash size={18} />}
          message={<>Delete <strong>{alias}</strong>? Its open alerts resolve and it stops watching every device it names. The Audit Trail keeps the record of it. This cannot be undone.</>}
          confirmLabel="Delete Automation"
          pendingLabel="Deleting…"
          onConfirm={remove}
          onCancel={() => setDeleting(false)}
        />
      )}
    </>
  )
}

/** The most serious severity among rows. */
function worstOf(rows) {
  const order = ['critical', 'warning', 'info']
  return [...rows].map(r => r.severity).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]
}

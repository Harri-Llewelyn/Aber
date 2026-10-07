import React, { useId, useState } from 'react'
import { api } from '../../api'
import { downloadJSON } from '../../utils/downloadJSON'
import { downloadBlob } from '../../utils/downloadBlob'
import { withReference } from '../../utils/edgeFunctionError'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconDownload } from '../common/Icons'

const FORMATS = [
  { id: 'json', label: 'AAS JSON (V3)', hint: 'The Asset Administration Shell as AAS Part 5 JSON.' },
  { id: 'aasx', label: 'AASX package', hint: 'The shell as an AASX (OPC) package, with any attached 3D model inside it.' },
  {
    id: 'bundle',
    label: 'Bundle (with history)',
    hint: "The AASX with the device's Audit Trail, the readings still in the live historian and a manifest naming the cold objects. A copy is kept beside the cold tier."
  }
]

/**
 * One device's export, in the format the reader picks: AAS JSON (V3), an AASX package, or the
 * bundle. The dialog runs the export itself (the request, the download, the progress and the
 * toasts) and closes when it succeeds, so a caller only opens and closes it. A failure stays in the
 * dialog, which can then be retried.
 *
 *   <DeviceExportModal device={{ id, name }} initialFormat="bundle" bundleDisabledReason={null}
 *     onClose={() => setExportFor(null)} showToast={showToast} />
 *
 * @param {{ id: string, name: string }} device `id` is the device UUID the export routes take, an
 * archived device's included; `name` titles the dialog and names the file.
 *
 * @param {'json'|'aasx'|'bundle'} [initialFormat] The format chosen on opening. A withheld bundle
 * falls back to JSON.
 *
 * @param {string|null} [bundleDisabledReason] Null offers the bundle; a sentence disables it and is
 * shown beneath it.
 *
 * @param {Function} onClose Called on Cancel, Escape and the close button, and after a successful
 * export. Ignored while the export runs.
 *
 * @param {Function} showToast Reports what was exported.
 */
export function DeviceExportModal({ device, initialFormat = 'json', bundleDisabledReason = null, onClose, showToast }) {
  const uid = useId()
  const bundleAllowed = !bundleDisabledReason
  const [format, setFormat] = useState(() => {
    const known = FORMATS.some(f => f.id === initialFormat)
    return known && (initialFormat !== 'bundle' || bundleAllowed) ? initialFormat : 'json'
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const { id, name } = device

  /** The bundle: the AASX with the trail, the live telemetry and the cold-object manifest. */
  const exportBundle = async () => {
    const result = await api.post('/api/v1/devices/asset-export', { device_id: id })
    downloadBlob(result.blob, result.filename || `${name}-bundle.aasx`)
    const b = result.stats?.bundle || {}
    const summary = `${b.raw_rows ?? 0} raw and ${b.hourly_rows ?? 0} hourly readings, ${b.trail_rows ?? 0} audit trail rows, ${b.cold_objects ?? 0} cold object${b.cold_objects === 1 ? '' : 's'} named`
    if (b.stored === false) {
      showToast?.(withReference(`Bundle downloaded for '${name}' (${summary}) — it was NOT stored on the platform: ${b.reason || 'unknown reason'}. Keep the file.`, b), 'warning')
    } else if (b.truncated) {
      showToast?.(`Bundle exported for '${name}' (${summary}) — a cap was reached; the manifest says what is not included`, 'warning')
    } else {
      showToast?.(`Bundle exported for '${name}' (${summary})`, 'success')
    }
  }

  /**
   * The shell alone, composed server-side by the `aas-export` edge function, which holds the
   * service role needed to read `asset_config` and the whole catalog.
   */
  const exportShell = async () => {
    const result = await api.post('/api/v1/devices/aas-export', { device_id: id, format })
    // The AASX is already a packaged ZIP, which downloadJSON would re-serialise into a corrupt file.
    if (format === 'aasx') downloadBlob(result.blob, `${name}.aasx`)
    else downloadJSON(result.aas, `${name}_aas_v3.json`)

    // An unmapped metric is a warning, not a failure: `semantic_id` is nullable and a local
    // extension legitimately has none. An unreachable model URL outranks it.
    const stats = result.stats || {}
    const unmapped = stats.unmapped_semantic_ids || 0
    const label = format === 'aasx' ? 'AASX package' : 'AAS JSON'
    const summary = `${stats.submodels || 0} submodels, ${stats.telemetry_metrics || 0} metrics`
    if (result.warning) {
      showToast?.(`${label} exported for '${name}' — ${result.warning}`, 'warning')
    } else if (unmapped > 0) {
      showToast?.(
        `${label} exported for '${name}' (${summary}) — ${unmapped} metric${unmapped === 1 ? '' : 's'} carried no semantic id`,
        'warning'
      )
    } else {
      showToast?.(`${label} exported for '${name}' (${summary})`, 'success')
    }
  }

  const run = async () => {
    setPending(true)
    setError(null)
    try {
      if (format === 'bundle') await exportBundle()
      else await exportShell()
      setPending(false)
      onClose()
    } catch (e) {
      setError(e.message || 'Export failed')
      setPending(false)
    }
  }

  // Closing is refused while the export runs: the download and its toast would land after the
  // dialog had gone.
  const close = pending ? () => {} : onClose

  return (
    <Modal
      title={`Export ${name}`}
      icon={<IconDownload size={18} />}
      size="md"
      onClose={close}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={close} disabled={pending}>Cancel</button>
          <ActionButton pending={pending} pendingLabel="Exporting…" onClick={run}>
            <IconDownload size={13} /> Export
          </ActionButton>
        </>
      }
    >
      <div className="form-group">
        <div className="form-label" id={`${uid}-label`}>Format</div>
        <div className="device-export-formats" role="radiogroup" aria-labelledby={`${uid}-label`}>
          {FORMATS.map(f => {
            const withheld = f.id === 'bundle' && !bundleAllowed
            return (
              <div key={f.id}>
                <label className={`device-export-choice${withheld ? ' is-disabled' : ''}`}>
                  <input
                    type="radio"
                    name={`${uid}-format`}
                    value={f.id}
                    checked={format === f.id}
                    disabled={withheld || pending}
                    onChange={() => { setFormat(f.id); setError(null) }}
                    aria-describedby={`${uid}-${f.id}-hint`}
                  />
                  {f.label}
                </label>
                <div className="form-hint device-export-hint" id={`${uid}-${f.id}-hint`}>
                  {f.hint}
                  {withheld && <> <strong>Not available:</strong> {bundleDisabledReason}</>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

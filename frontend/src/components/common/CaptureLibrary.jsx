import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { IconDownload, IconFileCode, IconShieldAlert, IconTrash, IconUpload } from './Icons'

/** Bytes → a short human string. Local for the same reason FlowBackupUploader's is. */
function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Broker captures stored against one gateway.
 *
 * WHY THIS EXISTS. `ingestion/capture.py` records live Sparkplug traffic to a file and publishes it
 * back rebased onto now — a dashboard verified against a machine that was on site for two hours, a
 * fault reproduced by editing a value by hand, a load test at a multiple of real time. Until this
 * panel a capture was a file on whoever's laptop happened to run the recorder, which is the wrong
 * place for the only copy of a fault nobody can reproduce on demand.
 *
 * ---------------------------------------------------------------------------------------------
 * THE PREFIX IS THE GATEWAY A CAPTURE PLAYS BACK AS, NOT THE ONE IT WAS RECORDED FROM.
 *
 * Those are different by construction. mosquitto.acl pins the topic's edge-node segment to the
 * connecting username, so `capture.py play` cannot publish under a recorded identity — it rewrites
 * every captured identity onto one gateway's own assets. Filing a capture under that gateway is the
 * only prefix that is a fact about the file rather than a guess about it.
 *
 * A consequence worth knowing at the panel: a capture filed here can NAME other gateways, because it
 * records whatever was on the wire.
 *
 * ---------------------------------------------------------------------------------------------
 * THE ROLE GATES MIRROR THE STORAGE RLS, THEY DO NOT IMPLEMENT IT.
 *
 * supabase/storage-policies.sql is the control: read for Administrator, Shopfloor_Manager and
 * Auditor; write and delete for the first two. `canRead` is passed in rather than inferred from the
 * list length because storage-api returns an EMPTY ARRAY to an unauthorised caller, so an empty list
 * cannot be told from a denial at this layer — it would read as "no captures exist".
 */
export function CaptureLibrary({ gateway, canRead, canManage, showToast }) {
  const [captures, setCaptures] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState(null)
  const fileRef = useRef(null)

  const sparkplugId = gateway?.sparkplug_id

  const refresh = useCallback(async () => {
    if (!canRead || !sparkplugId) return
    setLoading(true)
    setError(null)
    try {
      setCaptures(await api.listCaptures(sparkplugId))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [canRead, sparkplugId])

  useEffect(() => { refresh() }, [refresh])

  const handleFile = useCallback(async (file) => {
    if (!file || !canManage) return
    setBusy(true)
    setError(null)
    try {
      const { messages } = await api.uploadCapture(sparkplugId, file)
      showToast?.(`Capture stored for '${gateway.gateway_name}' (${messages} messages)`, 'success')
      await refresh()
    } catch (err) {
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
      // Cleared so re-picking the SAME file fires a change event again — otherwise a rejected
      // upload cannot be retried without choosing a different file first.
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [canManage, sparkplugId, gateway, refresh, showToast])

  const download = useCallback(async (capture) => {
    try {
      const url = await api.captureUrl(capture.path)
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      showToast?.(err.message, 'error')
    }
  }, [showToast])

  const remove = useCallback(async (capture) => {
    if (!canManage) return
    setBusy(true)
    try {
      await api.deleteCapture(capture.path)
      showToast?.('Capture deleted', 'success')
      await refresh()
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [canManage, refresh, showToast])

  // OPERATOR SEES NOTHING AT ALL, matching the storage policy, which grants them nothing. Not an
  // empty panel and not a locked one: a disabled control invites a request for access that was
  // never intended.
  if (!canRead) return null

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
        <div className="form-label" style={{ margin: 0 }}>Broker captures</div>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {loading ? 'Loading…' : `${captures.length} stored`}
        </span>
      </div>

      {/* THE ONE THING THAT CHANGES WHAT PLAYBACK MEANS, SAID WHERE THE CAPTURES LIVE. Playing onto
          a gateway that is not flagged simulated writes synthetic readings into the historian with
          nothing marking them as synthetic — the data is ingested identically either way, which is
          the point of the feature and exactly why the flag is the only thing telling them apart.
          Shown rather than enforced: filing a capture here is not the act that does it. */}
      {!gateway?.is_simulated && (
        <div style={{ fontSize: '11px', color: 'var(--warning-text)', margin: '6px 0' }}>
          <IconShieldAlert size={11} /> This gateway is not marked simulated, so anything played
          back as it will be recorded as ordinary telemetry. Tick <strong>Telemetry is simulated or
          replayed</strong> in Edit Details before playing a capture into a stack anyone reads.
        </div>
      )}

      {error && (
        <div style={{ fontSize: '11px', color: 'var(--danger)', margin: '6px 0' }}>
          <IconShieldAlert size={11} /> {error}
        </div>
      )}

      {captures.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
          {captures.map(c => (
            <li
              key={c.path}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px',
                border: '1px solid var(--border)', borderRadius: '6px', marginBottom: '4px',
                fontSize: '12px'
              }}
            >
              <IconFileCode size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
              <span className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={c.name}>
                {c.name}
              </span>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{formatSize(c.size)}</span>
              <button
                className="btn btn-ghost btn-icon btn-sm"
                onClick={() => download(c)}
                title="Download this capture (a signed link, valid for 60 seconds)"
              >
                <IconDownload size={12} />
              </button>
              {/* AUDITOR GETS NO DELETE, for the same reason they get none on a flow backup: a
                  read-only role that can remove evidence is not read-only. */}
              {canManage && (
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => remove(c)}
                  disabled={busy}
                  title="Delete this capture"
                >
                  <IconTrash size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {captures.length === 0 && !loading && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0' }}>
          No captures yet. Record one with{' '}
          <span className="mono">python ingestion/capture.py record --out shift.json</span> and
          upload it here.
        </div>
      )}

      {canManage && (
        <>
          <div
            role="button"
            tabIndex={0}
            onClick={() => !busy && fileRef.current?.click()}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) fileRef.current?.click() }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              handleFile(e.dataTransfer?.files?.[0])
            }}
            style={{
              marginTop: '8px', padding: '12px', textAlign: 'center', cursor: busy ? 'wait' : 'pointer',
              border: `1px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: '8px',
              background: dragging ? 'rgba(0,212,255,0.06)' : 'transparent',
              fontSize: '12px', color: 'var(--text-muted)'
            }}
            title="Upload a capture recorded with capture.py"
          >
            <IconUpload size={14} />
            <div style={{ marginTop: '4px' }}>
              {busy ? 'Uploading…' : 'Drop a capture here, or click to choose'}
            </div>
            <div style={{ fontSize: '11px', marginTop: '4px' }}>
              Recorded traffic — a capture names the devices that spoke and what they said
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </>
      )}

      {/* PLAYBACK MEETS QUARANTINE FIRST, AND SILENCE IS THE FAILURE MODE. A capture played onto a
          device id nobody registered is held and dropped until an Administrator approves it --
          zero-touch onboarding working exactly as designed, and correct. But from the operator's
          side it looks identical to a playback that did nothing: the command reports success, the
          messages are published, and no telemetry appears. Saying so here is the difference between
          "there is a step left" and "this is broken".

          STATIC RATHER THAN COMPUTED, and not for want of trying. The panel could parse each stored
          capture and compare the ids it names against the directory -- but those ids are rewritten
          at playback, so what gets quarantined is decided by the --map targets chosen at the
          command line, which this panel never sees. A computed warning would be confidently wrong
          about the file it was looking at. */}
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
        Playing a capture onto a device that is not registered here does not fail — it lands in{' '}
        <strong>Quarantine</strong> and waits for approval, and until then no telemetry is stored.
        Map onto devices that already exist to skip that step.
      </div>

      {/* Shown to a reader who cannot write, so the absent dropzone is explained rather than
          looking like a missing feature. */}
      {!canManage && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
          Read-only: your role can download captures but not add or remove them.
        </div>
      )}
    </div>
  )
}

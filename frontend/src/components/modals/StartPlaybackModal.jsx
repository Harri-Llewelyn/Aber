import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconPlay, IconShieldAlert } from '../common/Icons'
import { plural } from '../../utils/format'

/**
 * Speeds offered, rather than a free number. Speed divides both the send schedule and the timestamp
 * rebasing, and the historian inserts `ON CONFLICT (time, asset_id, metric_name) DO NOTHING`, so a
 * burst would silently discard almost every row. The list stops at 60.
 */
const SPEEDS = [
  { value: 0.5, label: '0.5× — half speed' },
  { value: 1, label: '1× — real time' },
  { value: 4, label: '4×' },
  { value: 10, label: '10×' },
  { value: 60, label: '60× — an hour a minute' }
]

/**
 * Play back a stored capture through the Playback gateway. The device map is built from dropdowns
 * off the gateway's devices, only a shadow gateway is offered, and whether it holds a broker
 * credential is shown before the click. None of that is the control: `start_playback_job()`
 * re-checks the credential and the device map, and refuses any gateway that is not a shadow. The
 * captured ids come from the manifest; a capture recorded before the manifest carried them falls
 * back to reading the file.
 */
export function StartPlaybackModal({ capture, onConfirm, onCancel }) {
  const [targets, setTargets] = useState(null)
  const [worker, setWorker] = useState(undefined)   // undefined = not loaded, null = never reported
  // sparkplug_ids whose credential was re-issued after the worker last picked one up (#217).
  const [stale, setStale] = useState([])
  const [targetId, setTargetId] = useState('')
  const [deviceMap, setDeviceMap] = useState({})
  const [speed, setSpeed] = useState(1)
  const [capturedDevices, setCapturedDevices] = useState(null)
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()
  // Its OWN pending flag, not `run`'s. Sharing one would put the Start button into its pending
  // state while lanes are being prepared, which reads as "the playback has begun".
  const [preparing, runPrepare] = usePendingAction()

  useEffect(() => {
    let cancelled = false
    api.playbackTargets()
      .then(rows => { if (!cancelled) setTargets(rows) })
      .catch(err => { if (!cancelled) { setTargets([]); setError(err.message) } })
    // Non-fatal: a status read that fails leaves the dialog as it was. A courtesy, not a control.
    api.playbackWorkerStatus()
      .then(row => { if (!cancelled) setWorker(row) })
      .catch(() => { if (!cancelled) setWorker(null) })
    // Also non-fatal, and an empty list on failure is the safe direction: this narrows what the
    // dialog offers, so failing to read it offers what it always did and `start_playback_job()`
    // still refuses a stale target.
    api.playbackStaleCredentials()
      .then(rows => { if (!cancelled) setStale(rows.map(r => r.sparkplug_id)) })
      .catch(() => { if (!cancelled) setStale([]) })
    return () => { cancelled = true }
  }, [])

  // The device ids the capture publishes under. From the manifest when it has them.
  useEffect(() => {
    let cancelled = false
    const fromManifest = capture?.manifest?.device_ids
    if (Array.isArray(fromManifest)) { setCapturedDevices(fromManifest); return }

    // Fallback for a capture recorded before the manifest carried these. A failure leaves an empty
    // map rather than blocking the dialog: a capture with no devices is legitimate.
    api.captureUrl(capture.storage_path)
      .then(url => fetch(url).then(r => r.json()))
      .then(doc => { if (!cancelled) setCapturedDevices(doc?.identities?.devices || []) })
      .catch(() => { if (!cancelled) setCapturedDevices([]) })
    return () => { cancelled = true }
  }, [capture])

  const target = useMemo(
    () => (targets || []).find(t => t.id === targetId) || null,
    [targets, targetId]
  )

  // Reset the map whenever the target changes: a device id from the previous gateway is what
  // `start_playback_job()` refuses.
  useEffect(() => { setDeviceMap({}) }, [targetId])

  /**
   * Is the worker running, and can it publish as this target? Stale is treated as down: the worker
   * restates its credentials every 30 seconds. Two minutes rather than thirty, so a slow tick is
   * not read as a death.
   */
  // 90 seconds is the window `gateway_status` derives staleness from, so a heartbeat inside it is
  // the same "currently live" this stack means everywhere else.
  const isLive = (t) => !!t?.last_heartbeat
    && (Date.now() - new Date(t.last_heartbeat).getTime()) < 90 * 1000

  const WORKER_STALE_MS = 2 * 60 * 1000
  const workerLive = !!worker?.reported_at
    && (Date.now() - new Date(worker.reported_at).getTime()) < WORKER_STALE_MS
  const heldByWorker = workerLive ? (worker.held_edge_nodes || []) : []
  const workerHolds = (t) => !!t && heldByWorker.includes(t.sparkplug_id)
  /* Held and CURRENT are different facts (#217). A re-issue replaces the password the broker will
     accept without changing which ids the worker reports, so this is the one that decides whether a
     playback would actually connect. */
  const workerHoldsCurrent = (t) => workerHolds(t) && !stale.includes(t.sparkplug_id)

  const unmapped = (capturedDevices || []).filter(d => !deviceMap[d])

  /**
   * Mint the replay lanes and fill the map from what came back. The target list is refreshed
   * afterwards, because `target.devices` is what the dropdowns render and was read before these
   * lanes existed.
   */
  const prepareLanes = () => runPrepare(async () => {
    setError(null)
    try {
      const map = await api.ensureShadowLanes(capture.id)
      setTargets(await api.playbackTargets())
      setDeviceMap(m => ({ ...m, ...map }))
    } catch (err) {
      setError(err.message)
    }
  })
  // The worker check is not part of `ready` when the status is unknown: a dialog that refuses
  // because it could not read a courtesy row would be worse than the failure it prevents.
  const ready = !!target
    && target.gateway_has_broker_credential
    && (worker === undefined || !workerLive || workerHoldsCurrent(target))
    && unmapped.length === 0

  const submit = () => run(async () => {
    setError(null)
    try {
      await onConfirm({ targetGatewayId: targetId, deviceMap, speed })
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title={`Play back capture${capture.note ? ` — ${capture.note}` : ''}`}
      icon={<IconPlay size={18} />}
      onClose={pending ? () => {} : onCancel}
      lead={<>
        {plural(capture.message_count, 'message')} recorded from{' '}
        <code>{capture.subject_sparkplug_id}</code>. Playing back rewrites every captured identity
        onto the Playback gateway's own devices — the broker pins each topic's edge-node segment to
        the account that publishes it, so a capture can never be played back under the identity it
        was recorded from.
      </>}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton
            className="btn btn-primary"
            pending={pending}
            pendingLabel="Starting…"
            disabled={!ready}
            // Stated rather than left to a greyed-out button, which explains nothing about why.
            title={ready ? undefined : (
              !target ? 'Choose the Playback gateway'
                : !target.gateway_has_broker_credential ? 'The Playback gateway holds no broker credential'
                  : (workerLive && !workerHolds(target))
                    ? 'The playback worker was not given this gateway’s password'
                    : (workerLive && !workerHoldsCurrent(target))
                      ? 'This credential was re-issued after the worker last picked one up — wait about a minute'
                      : `${plural(unmapped.length, 'device')} still to map`
            )}
            onClick={submit}
          >
            Play back
          </ActionButton>
        </>
      }
    >
      {/* Warned only when it is true: a missing birth costs metrics only when the recording uses
          aliases, which `uses_aliases` records at capture time. */}
      {capture.manifest?.birth_captured === false && capture.manifest?.uses_aliases && (
        <div className="callout callout-warning">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            This capture contains no <code>NBIRTH</code> or <code>DBIRTH</code> and its metrics are
            carried by <strong>alias</strong>. Nothing can resolve them, so every aliased metric is
            dropped on ingest — the playback will report success and write nothing.
          </div>
        </div>
      )}
      {capture.manifest?.birth_captured === false && !capture.manifest?.uses_aliases && (
        <p className="form-hint">
          This capture has no birth certificate. Its metrics carry full names, so they will play back
          normally — but the Playback gateway's devices are not announced and stay OFFLINE until
          they birth on their own.
        </p>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor="playback-target">Playback gateway</label>
        {targets === null && <p className="form-hint">Loading the Playback gateway…</p>}
        {targets !== null && targets.length === 0 && (
          <div className="callout callout-warning">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              The <strong>Playback gateway</strong> is the only place a capture can be played back,
              and it is missing or archived here. Restore it from Archived Entities.
            </div>
          </div>
        )}
        {targets !== null && targets.length > 0 && (
          <>
            <select
              id="playback-target"
              className="form-control"
              value={targetId}
              onChange={e => setTargetId(e.target.value)}
              disabled={pending}
            >
              <option value="">Choose the Playback gateway…</option>
              {targets.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.sparkplug_id})
                  {!t.gateway_has_broker_credential
                    ? ' — no broker credential'
                    : (workerLive && !workerHolds(t) ? ' — worker has no password'
                      : (workerLive && !workerHoldsCurrent(t) ? ' — worker still has the old password' : ''))}
                </option>
              ))}
            </select>
            <p className="form-hint">
              Only the Playback gateway is listed: nothing else publishes as it, so a playback never
              shares a live publisher's sequence numbers.
            </p>
          </>
        )}
      </div>

      {/* The credential check, shown before the click. Not `status = ONLINE`: the Playback gateway
          is legitimately OFFLINE until a playback runs. */}
      {target && !target.gateway_has_broker_credential && (
        <div className="callout callout-danger">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            <strong>{target.name}</strong> holds no broker credential, so nothing can authenticate
            as it. Issue one from the Access Control page. The platform then delivers the password
            to the playback worker itself.
          </div>
        </div>
      )}

      {/* The re-issue case, which is the ordinary one: the broker keeps one password per gateway,
          so every mint after the first replaces one and the worker holds the previous password
          until delivery reaches it. */}
      {target && workerLive && workerHolds(target) && !workerHoldsCurrent(target) && (
        <div className="callout callout-warning">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            <strong>{target.name}</strong>&apos;s broker credential was re-issued after the playback
            worker last picked one up, so the worker still holds the previous password and the
            broker would refuse it.
            <br />
            Delivery is automatic and takes about a minute. Reopen this dialog then — nothing needs
            doing here.
          </div>
        </div>
      )}

      {/* Issued and held are different facts, and only the worker knows the second, which it
          reports on a heartbeat. */}
      {target && target.gateway_has_broker_credential && workerLive && !workerHolds(target) && (
        <div className="callout callout-danger">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            <strong>{target.name}</strong> has a credential, but the playback worker was not given
            its password, so it cannot authenticate as this gateway.
            <br />
            Issuing a credential delivers the password to the worker automatically, within about a
            minute. To supply one yourself, set the Helm value{' '}
            <code>secrets.mqttPlaybackCredentials</code> to{' '}
            <code>{`{"${target.sparkplug_id}":"<password>"}`}</code> and upgrade the release. The
            password is shown only when the credential is issued, so issue a new one from Access
            Control if it was not kept.
          </div>
        </div>
      )}

      {/* Something is already publishing as this gateway, which makes it the wrong target rather
          than an unready one: two publishers on one edge node interleave sequence numbers and the
          daemon reports message loss for both. A warning, not a refusal, because re-recording onto
          a deliberately quiesced machine is legitimate. */}
      {target && isLive(target) && (
        <div className="callout callout-warning">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            <strong>{target.name}</strong> is publishing right now. A playback would be a second
            publisher on the same edge node, so the two sets of Sparkplug sequence numbers
            interleave and the daemon reports both as losing messages.
            <br />
            The Playback gateway is meant to have no other publisher. Stop whatever is publishing
            as it before starting a playback.
          </div>
        </div>
      )}

      {/* "Holds nothing" and "is not running" are different problems; the heartbeat tells them
          apart. */}
      {worker !== undefined && !workerLive && (
        <div className="callout callout-warning">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            The playback worker has not reported recently, so which gateways it can publish as is
            unknown. A job started now will queue and wait. Check that the <code>playback</code>
            {' '}service is running.
          </div>
        </div>
      )}

      {target && capturedDevices !== null && capturedDevices.length > 0 && (
        <div className="form-group">
          <label className="form-label">Device mapping</label>
          <p className="form-hint">
            Every device in the capture has to become a device of {target.name}. An unmapped id
            would publish under the Playback gateway's edge node carrying another gateway's device
            segment, which quarantines that device — and reads as a fleet fault rather than a
            mapping one.
          </p>
          {/* The button writes: it creates one replay lane per captured device and returns the map
              the playback job needs. Reused on the next run. */}
          {unmapped.length > 0 && (
            <div className="form-group">
              <ActionButton
                className="btn btn-ghost btn-sm"
                pending={preparing}
                pendingLabel="Preparing…"
                disabled={pending}
                onClick={prepareLanes}
                title="Create a replay lane for each device in this capture, bound to this gateway"
              >
                Prepare replay lanes ({unmapped.length})
              </ActionButton>
            </div>
          )}
          {target.devices.length === 0 && unmapped.length === 0 && (
            <div className="callout callout-danger">
              <IconShieldAlert size={14} className="callout-icon" />
              <div>
                {target.name} has no devices, so there is nothing to map onto. Add one on the
                Devices page and bind it to this gateway.
              </div>
            </div>
          )}
          {target.devices.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>In the capture</th><th>Publishes as</th></tr>
                </thead>
                <tbody>
                  {capturedDevices.map(captured => (
                    <tr key={captured}>
                      <td className="mono cell-meta">{captured}</td>
                      <td>
                        <select
                          className="form-control"
                          aria-label={`Target device for ${captured}`}
                          value={deviceMap[captured] || ''}
                          onChange={e => setDeviceMap(m => ({ ...m, [captured]: e.target.value }))}
                          disabled={pending}
                        >
                          <option value="">Choose a device…</option>
                          {target.devices.map(d => (
                            <option key={d.id} value={d.sparkplug_id}>
                              {d.name} ({d.sparkplug_id})
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {target && capturedDevices !== null && capturedDevices.length === 0 && (
        <p className="form-hint">
          This capture publishes no device-level traffic, so there is nothing to map — only the
          edge node's own messages will be played back.
        </p>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor="playback-speed">Speed</label>
        <select
          id="playback-speed"
          className="form-control"
          value={speed}
          onChange={e => setSpeed(Number(e.target.value))}
          disabled={pending}
        >
          {SPEEDS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <p className="form-hint">
          Timestamps are rebased by the same divisor as the schedule, so every message is
          in-window whatever speed is chosen. There is deliberately no "as fast as possible":
          the historian discards same-millisecond duplicates, so a burst would write one row per
          metric and report success.
        </p>
      </div>
    </Modal>
  )
}

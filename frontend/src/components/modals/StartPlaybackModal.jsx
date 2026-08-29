import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { IconShieldAlert } from '../common/Icons'

/**
 * Speeds offered, rather than a free number.
 *
 * `--speed 0` IS REFUSED AND THERE IS NO BURST MODE, which is why the list stops at 60. Speed
 * divides both the send schedule and the timestamp rebasing, so as it rises every message converges
 * on one millisecond -- and the historian inserts `ON CONFLICT (time, asset_id, metric_name) DO
 * NOTHING`. A burst replay of 100,000 messages would write one row per metric and silently discard
 * the rest: a successful-looking run against an almost-empty table.
 */
const SPEEDS = [
  { value: 0.5, label: '0.5× — half speed' },
  { value: 1, label: '1× — real time' },
  { value: 4, label: '4×' },
  { value: 10, label: '10×' },
  { value: 60, label: '60× — an hour a minute' }
]

/**
 * Publish a stored capture onto a simulated gateway.
 *
 * THIS DIALOG IS THE THING THE CLI CANNOT DO. `capture.py play` needs `--map dev…=dev…` for every
 * captured device, typed by hand, and it can only WARN that a target might not be a playback
 * gateway because it has no view of the directory. The page has one, so:
 *
 *   * the device map is built from dropdowns, off the devices actually bound to the target;
 *   * a target that is not `is_simulated` is never offered, because the gate refuses it outright;
 *   * whether the target holds a broker credential is shown BEFORE the click, using the gate's own
 *     predicate as a computed field rather than a second opinion about what "ready" means.
 *
 * NONE OF THAT IS THE CONTROL. `start_playback_job()` re-checks all three, and an API caller that
 * never saw this dialog is refused identically. What the dialog buys is that the refusal is rare
 * and the reason is visible while there is still something to do about it.
 *
 * THE CAPTURED IDS COME FROM THE MANIFEST, not from the file. A capture can be 100 MiB, and
 * downloading one to populate a select would be a strange price for opening a dialog. Captures
 * recorded before the manifest carried them fall back to reading the file, which is slower and
 * correct.
 */
export function StartPlaybackModal({ capture, onConfirm, onCancel }) {
  const [targets, setTargets] = useState(null)
  const [worker, setWorker] = useState(undefined)   // undefined = not loaded, null = never reported
  const [targetId, setTargetId] = useState('')
  const [deviceMap, setDeviceMap] = useState({})
  const [speed, setSpeed] = useState(1)
  const [capturedDevices, setCapturedDevices] = useState(null)
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()
  // Its OWN pending flag, not `run`'s. Sharing one would put the Start button into its pending
  // state while lanes are being prepared, which reads as "the playback has begun".
  const [preparing, runPrepare] = usePendingAction()

  useEscapeKey(pending ? () => {} : onCancel)

  useEffect(() => {
    let cancelled = false
    api.playbackTargets()
      .then(rows => { if (!cancelled) setTargets(rows) })
      .catch(err => { if (!cancelled) { setTargets([]); setError(err.message) } })
    // Non-fatal: a status read that fails leaves the dialog exactly as it was before this existed
    // -- the gate and the worker still refuse what they always refused. It is a courtesy, not a
    // control, and it must not be able to stop a playback that would have worked.
    api.playbackWorkerStatus()
      .then(row => { if (!cancelled) setWorker(row) })
      .catch(() => { if (!cancelled) setWorker(null) })
    return () => { cancelled = true }
  }, [])

  // The device ids the capture publishes under. From the manifest when it has them.
  useEffect(() => {
    let cancelled = false
    const fromManifest = capture?.manifest?.device_ids
    if (Array.isArray(fromManifest)) { setCapturedDevices(fromManifest); return }

    // FALLBACK FOR A CAPTURE RECORDED BEFORE THE MANIFEST CARRIED THESE. Reading the file is what
    // the manifest exists to avoid, so it is done only when there is no alternative -- and a
    // failure here leaves an empty map rather than blocking the dialog, because a capture with no
    // devices at all is legitimate (a gateway that published only node-level traffic).
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

  // Reset the map whenever the target changes: a device id from the previous gateway is exactly
  // what `start_playback_job()` refuses, and silently carrying one over would turn a dropdown
  // change into a refusal the operator did not cause.
  useEffect(() => { setDeviceMap({}) }, [targetId])

  /**
   * Is the worker running, and can it publish as this target?
   *
   * STALE IS TREATED AS DOWN. The worker restates its credentials every 30 seconds, so a report
   * older than a couple of minutes means the process is gone — and a list of gateways from a dead
   * worker is worse than no list, because it describes what playback COULD do rather than what it
   * can. Two minutes rather than thirty seconds so a slow tick is not read as a death.
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

  const unmapped = (capturedDevices || []).filter(d => !deviceMap[d])

  /**
   * Mint the replay lanes and fill the map from what came back.
   *
   * THE TARGET LIST IS REFRESHED AFTERWARDS, and that is not belt-and-braces. `target.devices` is
   * what the dropdowns render, and it was read before these lanes existed -- so without the reload
   * the map holds device ids that the select beside it cannot display, and the row renders blank
   * while claiming to be mapped.
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
  // The worker check is NOT part of `ready` when the status is unknown -- see the loader. A dialog
  // that refuses because it could not read a courtesy row would be worse than the failure it is
  // trying to prevent.
  const ready = !!target
    && target.gateway_has_broker_credential
    && (worker === undefined || !workerLive || workerHolds(target))
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
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title">
          Play back capture{capture.note ? ` — ${capture.note}` : ''}
        </div>

        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '10px 0 0' }}>
          {capture.message_count} message{capture.message_count === 1 ? '' : 's'} recorded from{' '}
          <code>{capture.subject_sparkplug_id}</code>. Publishing rewrites every captured identity
          onto the target's own assets — the broker pins each topic's edge-node segment to the
          account that publishes it, so a capture can never be replayed under the identity it was
          recorded from.
        </p>

        {/* WARNED ONLY WHEN IT IS TRUE. This used to fire on every birthless capture and say the
            playback would write nothing, which is wrong for any recording whose metrics carry their
            full names -- which is most of them. `uses_aliases` is the condition that actually
            matters, and it is recorded at capture time. */}
        {capture.manifest?.birth_captured === false && capture.manifest?.uses_aliases && (
          <div className="callout callout-warning" style={{ marginTop: '12px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>
              This capture contains no <code>NBIRTH</code> or <code>DBIRTH</code> and its metrics are
              carried by <strong>alias</strong>. Nothing can resolve them, so every aliased metric is
              dropped on ingest — the playback will report success and write nothing.
            </div>
          </div>
        )}
        {capture.manifest?.birth_captured === false && !capture.manifest?.uses_aliases && (
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '10px 0 0' }}>
            This capture has no birth certificate. Its metrics carry full names, so they will replay
            normally — but the target's devices are not announced and stay OFFLINE until they birth
            on their own.
          </p>
        )}

        {/* ---------------------------------------------------------------------------------- */}
        <div className="form-group" style={{ marginTop: '16px' }}>
          <label className="form-label" htmlFor="playback-target">Publish as</label>
          {targets === null && (
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading targets…</p>
          )}
          {targets !== null && targets.length === 0 && (
            <div className="callout" style={{ borderColor: 'var(--warning)' }}>
              <IconShieldAlert size={14} className="callout-icon" />
              <div style={{ fontSize: '12px' }}>
                No gateway is marked <strong>simulated</strong>. A capture can only be published onto
                one that is: the historian records a replayed reading identically to an observed one,
                and that flag is the only thing downstream that says otherwise. Mark a gateway
                simulated on the Gateways page, or create one for playback.
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
                <option value="">Choose a simulated gateway…</option>
                {targets.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.sparkplug_id})
                    {!t.gateway_has_broker_credential
                      ? ' — no broker credential'
                      : (workerLive && !workerHolds(t) ? ' — worker has no password' : '')}
                  </option>
                ))}
              </select>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                Only simulated gateways are listed, because the database refuses any other target.
              </p>
            </>
          )}
        </div>

        {/* THE CREDENTIAL CHECK, SHOWN BEFORE THE CLICK. Not `status = ONLINE`: a playback target is
            legitimately OFFLINE, because nothing publishes as it until a playback runs. Requiring
            liveness would refuse every first playback and pass only after one had succeeded. */}
        {target && !target.gateway_has_broker_credential && (
          <div className="callout" style={{ borderColor: 'var(--danger)', marginTop: '10px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>
              <strong>{target.name}</strong> holds no broker credential, so nothing can authenticate
              as it. Issue one from the Access Control page — that is also how you obtain the
              password the playback worker needs, and it is shown only once.
            </div>
          </div>
        )}

        {/* TIER TWO, SAID BEFORE THE CLICK. The platform having issued a credential and the WORKER
            having been given it are two different facts, and only the worker knows the second. It
            reports what it holds on a heartbeat; this is that report, read back. Without it the
            dialog showed a green target and the job failed a second later with the same sentence. */}
        {target && target.gateway_has_broker_credential && workerLive && !workerHolds(target) && (
          <div className="callout" style={{ borderColor: 'var(--danger)', marginTop: '10px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            {/* THE MESSAGE NAMED A VARIABLE AND NOT WHERE IT LIVES, and the first person to read it
                asked whether the password went in the capture file. It does not: this is a
                server-side secret in the stack's `.env`, because the worker is a container and the
                broker password is not something a browser may hold. */}
            <div style={{ fontSize: '12px' }}>
              <strong>{target.name}</strong> has a credential, but the playback worker was not given
              its password, so it cannot authenticate as this gateway.
              <br />
              This is a server-side setting, not part of the capture file. In the stack's{' '}
              <code>.env</code>, add:
              <br />
              <code style={{ display: 'inline-block', margin: '4px 0' }}>
                {`MQTT_PLAYBACK_CREDENTIALS={"${target.sparkplug_id}":"<password>"}`}
              </code>
              <br />
              then <code>docker compose up -d playback</code>. The password is shown only at the
              moment the credential is minted — issue a new one from Access Control if it was not
              kept.
            </div>
          </div>
        )}

        {/* SOMETHING IS ALREADY PUBLISHING AS THIS GATEWAY, which is the one thing that makes a
            target wrong rather than unready — and nothing said so.

            A playback target is legitimately OFFLINE: nothing publishes as it until a playback
            runs, which is why the gate deliberately does NOT require ONLINE. The inverse is the
            warning. A gateway that is beating right now has a live publisher, and a playback adds
            a second one on the same edge node — so their Sparkplug sequence numbers interleave and
            the daemon reports permanent message loss for both. That is exactly what
            `playback_jobs_one_per_target` exists to prevent between two playbacks; it cannot see a
            simulator or a real appliance doing the same thing.

            A WARNING AND NOT A REFUSAL, because the database cannot tell a gateway that is beating
            from one that will still be beating in a minute, and re-recording a fault onto a
            deliberately-quiesced machine is a legitimate thing to want. */}
        {target && isLive(target) && (
          <div className="callout callout-warning" style={{ marginTop: '10px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>
              <strong>{target.name}</strong> is publishing right now. A playback would be a second
              publisher on the same edge node, so the two sets of Sparkplug sequence numbers
              interleave and the daemon reports both as losing messages.
              <br />
              A playback target is best as a gateway <em>nothing else</em> publishes as — a virtual
              one created for the purpose, rather than one a simulator or an appliance is driving.
            </div>
          </div>
        )}

        {/* "Holds nothing" and "is not running" are different problems with different fixes, and an
            empty list cannot tell them apart. The heartbeat is what separates them. */}
        {worker !== undefined && !workerLive && (
          <div className="callout callout-warning" style={{ marginTop: '10px' }}>
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>
              The playback worker has not reported recently, so which gateways it can publish as is
              unknown. A job started now will queue and wait. Check that the <code>playback</code>
              {' '}service is running.
            </div>
          </div>
        )}

        {/* ---------------------------------------------------------------------------------- */}
        {target && capturedDevices !== null && capturedDevices.length > 0 && (
          <div className="form-group" style={{ marginTop: '16px' }}>
            <label className="form-label">Device mapping</label>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '0 0 8px' }}>
              Every device in the capture has to become a device of {target.name}. An unmapped id
              would publish under the target's edge node carrying another gateway's device segment,
              which quarantines that device — and reads as a fleet fault rather than a mapping one.
            </p>
            {/* THE MAP BUILDS ITSELF, and the button is here rather than on load because it
                writes. `ensure_shadow_devices()` mints one replay lane per captured device --
                bound to this gateway, carrying the original's schema and nothing else -- and
                returns exactly the map `start_playback_job()` wants. Reused on the next run, so
                this is a no-op after the first capture of a given machine. */}
            {unmapped.length > 0 && (
              <div style={{ marginBottom: '10px' }}>
                <ActionButton
                  className="btn btn-secondary btn-sm"
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
              <div className="callout" style={{ borderColor: 'var(--danger)' }}>
                <IconShieldAlert size={14} className="callout-icon" />
                <div style={{ fontSize: '12px' }}>
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
                        <td className="mono" style={{ fontSize: '12px' }}>{captured}</td>
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
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
            This capture publishes no device-level traffic, so there is nothing to map — only the
            edge node's own messages will be replayed.
          </p>
        )}

        {/* ---------------------------------------------------------------------------------- */}
        <div className="form-group" style={{ marginTop: '16px' }}>
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
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Timestamps are rebased by the same divisor as the schedule, so every message is
            in-window whatever speed is chosen. There is deliberately no "as fast as possible":
            the historian discards same-millisecond duplicates, so a burst would write one row per
            metric and report success.
          </p>
        </div>

        {error && (
          <div
            className="callout"
            style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)', marginTop: '12px' }}
          >
            <IconShieldAlert size={14} className="callout-icon" />
            <div style={{ fontSize: '12px' }}>{error}</div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
          <ActionButton
            className="btn btn-primary"
            pending={pending}
            pendingLabel="Starting…"
            disabled={!ready}
            // Stated rather than left to a greyed-out button, which explains nothing about why.
            title={ready ? undefined : (
              !target ? 'Choose a target gateway'
                : !target.gateway_has_broker_credential ? 'This gateway holds no broker credential'
                  : (workerLive && !workerHolds(target))
                    ? 'The playback worker was not given this gateway’s password'
                    : `${unmapped.length} device${unmapped.length === 1 ? '' : 's'} still to map`
            )}
            onClick={submit}
          >
            Publish capture
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

import React, { useState } from 'react'
import CopyableId from '../common/CopyableId'
import { ActionButton } from '../common/ActionButton'
import { LocationPicker, locationIncomplete } from '../common/LocationPicker'
import { IconShieldAlert, IconAlertTriangle } from '../common/Icons'
import { Modal } from '../common/Modal'
import { usePendingKey } from '../../hooks/usePendingAction'
import { gatewayAcceptsDevices } from '../../utils/gatewayType'
import {
  SCOPE_GATEWAY, SCOPE_CELL, SCOPE_AREA_WIDE, SCOPE_SITE_WIDE, SOURCE_UNASSIGNED, followedPlaceFix, followedPlaceLine, resolveDeviceLocation
} from '../../utils/cellResolution'

export function ApproveQuarantineModal({ item, cells, gateways, areas = [], suggestion, onApprove, onMerge, onCancel }) {
  // One key space across both buttons: approving as new and merging into the suggested match are
  // two answers to the same question, so running one locks the other.
  const [busy, runBusy] = usePendingKey()
  // A refusal from approve-quarantine, as it worded it. The dialog stays open on one.
  const [error, setError] = useState(null)
  const decide = (key, act) => runBusy(key, async () => {
    setError(null)
    try {
      await act()
    } catch (err) {
      setError(err.message)
    }
  })

  const isGateway = item.entity_type === 'GATEWAY'
  const [assetName, setAssetName] = useState(item.asset_name)
  // The gateway it arrived through, else the first the picker offers. An archived gateway is never
  // the default: the picker leaves it out, and the database refuses it.
  const offered = gateways.filter(g => !g.is_archived)
  const [gatewayId, setGatewayId] = useState(() =>
    (offered.some(g => g.gateway_id === item.gateway_id) ? item.gateway_id : null) ||
    offered.find(g => gatewayAcceptsDevices(g))?.gateway_id || '')

  // The location is chosen here because the operator is already looking at the device. The same
  // picker as the Devices form: a device follows its gateway unless told otherwise, and forcing a
  // place would pin it where it stops tracking the gateway.
  const [location, setLocation] = useState({ cell_id: '', area_id: '', location_scope: SCOPE_GATEWAY })
  const scope = location.location_scope
  const cellId = scope === SCOPE_CELL ? location.cell_id : ''

  const selectedGateway = gateways.find(g => g.gateway_id === gatewayId)
  const chosenAreaName = areas.find(a => a.area_id === location.area_id)?.area_name

  // Where Follow Gateway puts the device once approved, in the Devices form's words. A gateway with
  // no location, or none at all, leaves the device Unassigned, which the operator is told now.
  const followedLine = followedPlaceLine(selectedGateway, { cells, areas })
  const willBeUnassigned = scope === SCOPE_GATEWAY &&
    resolveDeviceLocation({ location_scope: SCOPE_GATEWAY }, selectedGateway).location_source === SOURCE_UNASSIGNED

  // Area-Wide with no area named and In a cell with no cell would be refused by the database; held here.
  const problem = !isGateway && locationIncomplete(location, { cellRequired: true })
    ? (scope === SCOPE_AREA_WIDE ? 'Choose which area the device serves' : 'Choose which cell the device is in')
    : null

  const handleSave = () => decide('approve', () => onApprove(item.asset_id, {
    asset_name: assetName,
    active_gateway_id: gatewayId,
    cell_id: cellId,
    area_id: scope === SCOPE_AREA_WIDE ? location.area_id : '',
    location_scope: scope
  }))

  const handleAcceptMatch = () => decide('merge', () => onMerge(item.asset_id, suggestion.candidateId))

  return (
    // Escape, the close button and Cancel do nothing while a decision is in flight.
    <Modal
      title={<>Approve Discovered {isGateway ? 'Gateway' : 'Device'} <span className="mono">[{item.asset_name}]</span></>}
      icon={<IconShieldAlert size={18} />}
      size="md"
      onClose={busy ? () => {} : onCancel}
      problem={problem}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={!!busy}>Cancel</button>
          <ActionButton
            pending={busy === 'approve'}
            pendingLabel="Approving…"
            disabled={busy === 'merge' || problem !== null}
            onClick={handleSave}
            title={problem ?? undefined}
          >
            Approve &amp; Onboard
          </ActionButton>
        </>
      }
    >
      {/* What the device put on the wire, and why it was held. For a malformed identifier this is
          the whole diagnosis. */}
      <div className="form-group">
        <label className="form-label">Published Sparkplug ID</label>
        <CopyableId value={item.reported_identity} label="published device id" />
        {item.quarantine_reason && (
          <div className="form-hint hint-danger">
            <IconAlertTriangle size={12} /> {item.quarantine_reason}
          </div>
        )}
      </div>

      {!isGateway && suggestion && (
        <div className="callout callout-warning">
          <IconAlertTriangle size={16} className="callout-icon" />
          <div>
            <strong>This looks like it might be <span className="mono">{suggestion.candidateName}</span></strong>
            <div className="form-hint">
              A provisioned device awaiting its first birth ({suggestion.evidence}). If this was a
              mistyped device name, accepting the match keeps that device's existing configuration and
              discards this quarantined duplicate, rather than approving it as a brand new device.
            </div>
            <ActionButton
              className="btn btn-primary btn-sm"
              pending={busy === 'merge'}
              pendingLabel="Merging…"
              disabled={busy === 'approve'}
              onClick={handleAcceptMatch}
              title="Merge this quarantined device into the suggested provisioned device"
            >
              Accept Match
            </ActionButton>
          </div>
        </div>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor="approve-name">{isGateway ? 'Gateway Name' : 'Device Name'}</label>
        <input id="approve-name" className="form-control" value={assetName} onChange={e => setAssetName(e.target.value)} />
      </div>

      {/* A gateway needs nothing further here. A device still needs its serving gateway and its
          location. */}
      {!isGateway && (
        <>
          <div className="form-group">
            <label className="form-label" htmlFor="approve-gateway">Serving Gateway</label>
            <select id="approve-gateway" className="form-control" value={gatewayId} onChange={e => setGatewayId(e.target.value)}>
              <option value="">— Unassigned Gateway —</option>
              {/* Disabled rather than absent, as at the Devices form's picker: a replay lane is
                  minted by a playback, never approved onto. */}
              {offered.map(g => (
                <option key={g.gateway_id} value={g.gateway_id} disabled={!gatewayAcceptsDevices(g)}>
                  {g.gateway_name} — {g.status}
                  {gatewayAcceptsDevices(g) ? '' : ' — replay lane, not assignable'}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Location</label>
            <LocationPicker
              idPrefix="approve"
              form={location}
              onChange={fields => setLocation(l => ({ ...l, ...fields }))}
              cells={cells}
              areas={areas}
              followGateway
              cellEmptyLabel="— Choose a cell —"
            />

            {willBeUnassigned ? (
              <div className="form-hint hint-warning">
                <IconAlertTriangle size={12} /> {followedLine}. {followedPlaceFix(selectedGateway)}
              </div>
            ) : (
              <div className="form-hint">
                {scope === SCOPE_GATEWAY
                  ? `${followedLine}. It moves when the gateway does.`
                  : scope === SCOPE_SITE_WIDE
                    ? 'Reported as Site-Wide rather than under any cell.'
                    : scope === SCOPE_AREA_WIDE
                      ? `Reported as Area-Wide in ${chosenAreaName || 'the chosen area'} rather than under any cell in it.`
                      : cellId
                        ? 'Set on this device — it stays put even if the gateway is reassigned.'
                        : 'Choose the cell this device is in, or use Follow Gateway to take its gateway’s place.'}
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

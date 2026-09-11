import React, { useState } from 'react'
import CopyableId from '../common/CopyableId'
import { ActionButton } from '../common/ActionButton'
import { LocationPicker, locationIncomplete } from '../common/LocationPicker'
import { IconShieldAlert, IconAlertTriangle } from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { usePendingKey } from '../../hooks/usePendingAction'
import { gatewayAcceptsDevices } from '../../utils/gatewayType'
import { SCOPE_CELL, SCOPE_AREA_WIDE, SCOPE_SITE_WIDE } from '../../utils/cellResolution'

export function ApproveQuarantineModal({ item, cells, gateways, areas = [], suggestion, onApprove, onMerge, onCancel }) {
  // One key space across both buttons: approving as new and merging into the suggested match are
  // two answers to the same question, so running one locks the other.
  const [busy, runBusy] = usePendingKey()

  // Escape closes through the shared stack, so a ConfirmModal opened on top takes the keypress.
  // Inert while a decision is in flight; see ConfirmModal for why the layer stays on the stack.
  useEscapeKey(busy ? () => {} : onCancel)

  const isGateway = item.entity_type === 'GATEWAY'
  const [assetName, setAssetName] = useState(item.asset_name)
  const [connMethod, setConnMethod] = useState('Sparkplug B')
  const [gatewayId, setGatewayId] = useState(item.gateway_id || (gateways[0] ? gateways[0].gateway_id : ''))

  // The location is chosen here because the operator is already looking at the device. The same
  // picker as the Devices form: an empty cell means inherit from the gateway, and forcing a value
  // would store an override that stops tracking the gateway.
  const [location, setLocation] = useState({ cell_id: '', area_id: '', location_scope: SCOPE_CELL })
  const scope = location.location_scope
  const cellId = scope === SCOPE_CELL ? location.cell_id : ''

  const selectedGateway = gateways.find(g => g.gateway_id === gatewayId)
  const derivedCellName = selectedGateway?.cell_id
    ? (cells.find(c => c.cell_id === selectedGateway.cell_id)?.cell_name || null)
    : null
  const chosenAreaName = areas.find(a => a.area_id === location.area_id)?.area_name

  // What the device will resolve to once approved. A gateway with no cell cannot supply one, so the
  // operator is told that leaving the picker alone lands the device in the Unassigned queue.
  const willBeUnassigned = scope === SCOPE_CELL && !cellId && !selectedGateway?.cell_id

  const handleSave = () => runBusy('approve', () => onApprove(item.asset_id, {
    asset_name: assetName,
    connection_method: connMethod,
    active_gateway_id: gatewayId,
    cell_id: cellId,
    area_id: scope === SCOPE_AREA_WIDE ? location.area_id : '',
    location_scope: scope
  }))

  const handleAcceptMatch = () => runBusy('merge', () => onMerge(item.asset_id, suggestion.candidateId))

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconShieldAlert size={18} />
          <span>Approve Discovered {isGateway ? 'Gateway' : 'Device'} <span className="mono">[{item.asset_name}]</span></span>
        </div>

        {/* What the device put on the wire, and why it was held. For a malformed identifier this is
            the whole diagnosis. */}
        <div className="form-group">
          <label className="form-label">Published Sparkplug ID</label>
          <CopyableId value={item.reported_identity} label="published device id" />
          {item.quarantine_reason && (
            <div style={{ fontSize: '11px', color: 'var(--danger)', marginTop: '6px', display: 'flex', alignItems: 'flex-start', gap: '5px' }}>
              <IconAlertTriangle size={12} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>{item.quarantine_reason}</span>
            </div>
          )}
        </div>

        {!isGateway && suggestion && (
          <div style={{ background: 'rgba(255,179,0,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius)', padding: '12px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--warning-text)', fontWeight: 600, marginBottom: '4px' }}>
              <IconAlertTriangle size={16} />
              <span>This looks like it might be <span className="mono">{suggestion.candidateName}</span></span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
              A provisioned device that has never sent a birth message ({suggestion.evidence}). If this was
              a mistyped device name, accepting the match keeps that device's existing configuration and
              discards this quarantined duplicate — rather than approving it as a brand new device.
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
        )}

        <div className="form-group">
          <label className="form-label">{isGateway ? 'Gateway Name' : 'Device Name'}</label>
          <input className="form-control" value={assetName} onChange={e => setAssetName(e.target.value)} title={`Enter human-readable ${isGateway ? 'gateway' : 'device'} name`} />
        </div>

        {/* A gateway needs nothing further here. A device still needs its serving gateway and its
            location. */}
        {!isGateway && (
          <>
            <div className="form-group">
              <label className="form-label">Active Edge Gateway Selection</label>
              <select className="form-control" value={gatewayId} onChange={e => setGatewayId(e.target.value)} title="Select the edge gateway that will serve this device">
                <option value="">— Unassigned Gateway —</option>
                {/* Disabled rather than absent, for the reason DevicesTab states at its own
                    picker (#144): a replay lane is minted by a playback, never approved onto. */}
                {gateways.filter(g => !g.is_archived).map(g => (
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
                cellEmptyLabel={derivedCellName
                  ? `— Inherit from gateway (${derivedCellName}) —`
                  : '— Inherit from gateway (gateway has no cell) —'}
                cellTitle="Where this device sits. Leave on Inherit to follow the gateway above."
              />

              {willBeUnassigned ? (
                <div style={{ fontSize: '11px', color: 'var(--warning-text)', marginTop: '6px', display: 'flex', alignItems: 'flex-start', gap: '5px' }}>
                  <IconAlertTriangle size={12} style={{ flexShrink: 0, marginTop: '1px' }} />
                  <span>
                    {gatewayId
                      ? 'The selected gateway has no cell of its own — a host-run connector never does — so this device will land in the Unassigned queue. Pick a cell now, or mark it Area-Wide or Site-Wide.'
                      : 'With no gateway and no cell, this device will land in the Unassigned queue.'}
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  {scope === SCOPE_SITE_WIDE
                    ? 'Reported as Site-Wide rather than under any cell.'
                    : scope === SCOPE_AREA_WIDE
                      ? `Reported as Area-Wide in ${chosenAreaName || 'the chosen area'} rather than under any cell in it.`
                      : cellId
                        ? 'Set on this device — it stays put even if the gateway is reassigned.'
                        : 'Follows the gateway above, and moves with it.'}
                </div>
              )}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={!!busy} title="Cancel onboarding approval">Cancel</button>
          <ActionButton
            pending={busy === 'approve'}
            pendingLabel="Approving…"
            // Area-Wide with no area named would be refused by the database; held here.
            disabled={busy === 'merge' || (!isGateway && locationIncomplete(location))}
            onClick={handleSave}
            title={!isGateway && locationIncomplete(location) ? 'Choose which area the device serves' : 'Confirm onboarding and register'}
          >
            Approve &amp; Onboard
          </ActionButton>
        </div>
      </div>
    </div>
  )
}

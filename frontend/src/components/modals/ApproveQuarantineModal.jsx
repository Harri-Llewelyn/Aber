import React, { useState } from 'react'
import CopyableId from '../common/CopyableId'
import { IconShieldAlert, IconAlertTriangle } from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'

export function ApproveQuarantineModal({ item, cells, gateways, suggestion, onApprove, onMerge, onCancel }) {
  // Escape closes. Via the shared stack rather than a listener of this component's own,
  // because a ConfirmModal can open on top of this one and a bare document listener on each
  // would let one keypress dismiss both.
  useEscapeKey(onCancel)

  const isGateway = item.entity_type === 'GATEWAY'
  const [assetName, setAssetName] = useState(item.asset_name)
  const [connMethod, setConnMethod] = useState('Sparkplug B')
  const [gatewayId, setGatewayId] = useState(item.gateway_id || (gateways[0] ? gateways[0].gateway_id : ''))

  // The cell IS chosen here again (migration 0036). It was removed with the note that "the old
  // cell picker wrote a value nothing could store" -- devices had no cell_id column. They do
  // now, and this is the one moment an operator is already looking at the device, so making
  // them find it again on the Devices page afterwards is the worse workflow.
  //
  // Empty still means inherit, exactly as on the Devices form: a device approved onto a gateway
  // that has a cell needs no answer here, and forcing one would store an override nobody asked
  // for -- which would then stop tracking the gateway.
  const [cellId, setCellId] = useState('')
  const [siteWide, setSiteWide] = useState(false)

  const selectedGateway = gateways.find(g => g.gateway_id === gatewayId)
  const derivedCellName = selectedGateway?.cell_id
    ? (cells.find(c => c.cell_id === selectedGateway.cell_id)?.cell_name || null)
    : null

  // What the device will resolve to once approved. A gateway with no cell -- which every
  // virtual, host-run gateway has -- cannot supply one, so this is where the operator is told
  // that leaving the picker alone lands the device in the Unassigned queue.
  const willBeUnassigned = !siteWide && !cellId && !selectedGateway?.cell_id

  const handleSave = () => {
    onApprove(item.asset_id, {
      asset_name: assetName,
      connection_method: connMethod,
      active_gateway_id: gatewayId,
      cell_id: siteWide ? '' : cellId,
      location_scope: siteWide ? 'site_wide' : 'cell'
    })
  }

  const handleAcceptMatch = () => {
    onMerge(item.asset_id, suggestion.candidateId)
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconShieldAlert size={18} />
          <span>Approve Discovered {isGateway ? 'Gateway' : 'Device'} <span className="mono">[{item.asset_name}]</span></span>
        </div>

        {/* What the device actually put on the wire, and why it was held. For a malformed
            identifier this is the whole diagnosis -- the id below is what the gateway sent,
            and the reason says how it failed the format contract. */}
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
            <button className="btn btn-primary btn-sm" onClick={handleAcceptMatch} title="Merge this quarantined device into the suggested provisioned device">
              Accept Match
            </button>
          </div>
        )}

        <div className="form-group">
          <label className="form-label">{isGateway ? 'Gateway Name' : 'Device Name'}</label>
          <input className="form-control" value={assetName} onChange={e => setAssetName(e.target.value)} title={`Enter human-readable ${isGateway ? 'gateway' : 'device'} name`} />
        </div>

        {/* A gateway needs nothing further here. It used to be asked for an IP address, which
            0004 removed -- nothing in the monitoring flow read it. A device still needs its
            serving gateway and its location, neither of which applies to a gateway itself. */}
        {!isGateway && (
          <>
            <div className="form-group">
              <label className="form-label">Active Edge Gateway Selection</label>
              <select className="form-control" value={gatewayId} onChange={e => setGatewayId(e.target.value)} title="Select the edge gateway that will serve this device">
                <option value="">— Unassigned Gateway —</option>
                {gateways.filter(g => !g.is_archived).map(g => (
                  <option key={g.gateway_id} value={g.gateway_id}>
                    {g.gateway_name} — {g.status}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Shopfloor Cell Zone</label>
              <select
                className="form-control"
                value={siteWide ? '' : cellId}
                disabled={siteWide}
                onChange={e => setCellId(e.target.value)}
                title="Where this device sits. Leave on Inherit to follow the gateway above."
              >
                <option value="">
                  {derivedCellName
                    ? `— Inherit from gateway (${derivedCellName}) —`
                    : '— Inherit from gateway (gateway has no cell) —'}
                </option>
                {cells.filter(c => !c.is_archived).map(c => (
                  <option key={c.cell_id} value={c.cell_id}>{c.cell_name}</option>
                ))}
              </select>

              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', fontSize: '12px', cursor: 'pointer' }}
                     title="For assets with no single cell — a BMS, an AGV, an ambient sensor">
                <input
                  type="checkbox"
                  checked={siteWide}
                  onChange={e => { setSiteWide(e.target.checked); if (e.target.checked) setCellId('') }}
                />
                <span>Site-Wide — this asset has no single cell</span>
              </label>

              {willBeUnassigned ? (
                <div style={{ fontSize: '11px', color: 'var(--warning-text)', marginTop: '6px', display: 'flex', alignItems: 'flex-start', gap: '5px' }}>
                  <IconAlertTriangle size={12} style={{ flexShrink: 0, marginTop: '1px' }} />
                  <span>
                    {gatewayId
                      ? 'The selected gateway has no cell of its own — a host-run connector never does — so this device will land in the Unassigned queue. Pick a cell now, or mark it Site-Wide.'
                      : 'With no gateway and no cell, this device will land in the Unassigned queue.'}
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  {siteWide
                    ? 'Reported as Site-Wide rather than under any cell.'
                    : cellId
                      ? 'Set on this device — it stays put even if the gateway is reassigned.'
                      : 'Follows the gateway above, and moves with it.'}
                </div>
              )}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} title="Cancel onboarding approval">Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} title="Confirm onboarding and register">Approve & Onboard</button>
        </div>
      </div>
    </div>
  )
}

import React, { useState } from 'react'
import CopyableId from '../common/CopyableId'
import { IconShieldAlert, IconAlertTriangle } from '../common/Icons'

export function ApproveQuarantineModal({ item, cells, gateways, suggestion, onApprove, onMerge, onCancel }) {
  const isGateway = item.entity_type === 'GATEWAY'
  const [assetName, setAssetName] = useState(item.asset_name)
  const [connMethod, setConnMethod] = useState('Sparkplug B')
  const [gatewayId, setGatewayId] = useState(item.gateway_id || (gateways[0] ? gateways[0].gateway_id : ''))
  const [ipAddress, setIpAddress] = useState('')

  // The cell is not chosen here: a device inherits the cell of the gateway it is
  // approved onto. The old cell picker wrote a value nothing could store.
  const selectedGateway = gateways.find(g => g.gateway_id === gatewayId)
  const derivedCellName = selectedGateway?.cell_id
    ? (cells.find(c => c.cell_id === selectedGateway.cell_id)?.cell_name || null)
    : null

  const handleSave = () => {
    onApprove(item.asset_id, {
      asset_name: assetName,
      connection_method: connMethod,
      active_gateway_id: gatewayId,
      ip_address: ipAddress
    })
  }

  const handleAcceptMatch = () => {
    onMerge(item.asset_id, suggestion.candidateId)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 460 }}>
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

        {isGateway ? (
          <div className="form-group">
            <label className="form-label">IP Address</label>
            <input className="form-control" value={ipAddress} onChange={e => setIpAddress(e.target.value)} title="Enter gateway IP address (optional)" placeholder="e.g. 192.168.1.100" />
          </div>
        ) : (
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
              <input
                className="form-control"
                value={derivedCellName || (gatewayId ? '— gateway is not assigned to a cell —' : '— select a gateway —')}
                disabled
                readOnly
                title="A device belongs to the cell its edge gateway is assigned to"
              />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Follows the selected gateway. Assign gateways to cells on the Gateways page.
              </div>
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

import React, { useState } from 'react'
import { IconShieldAlert } from '../common/Icons'

export function ApproveQuarantineModal({ item, cells, gateways, onApprove, onCancel }) {
  const isGateway = item.entity_type === 'GATEWAY'
  const [assetName, setAssetName] = useState(item.asset_id)
  const [cellId, setCellId]       = useState('')
  const [connMethod, setConnMethod] = useState('Sparkplug B')
  const [gatewayId, setGatewayId] = useState(item.gateway_id || (gateways[0] ? gateways[0].gateway_id : ''))
  const [ipAddress, setIpAddress] = useState('')

  const handleSave = () => {
    onApprove(item.asset_id, {
      asset_name: assetName,
      cell_id: cellId ? parseInt(cellId, 10) : null,
      connection_method: connMethod,
      active_gateway_id: gatewayId,
      ip_address: ipAddress
    })
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconShieldAlert size={18} />
          <span>Approve Discovered {isGateway ? 'Gateway' : 'Device'} <span className="mono">[{item.asset_id}]</span></span>
        </div>

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
              <label className="form-label">Shopfloor Cell Zone Assignment</label>
              <select className="form-control" value={cellId} onChange={e => setCellId(e.target.value)} title="Assign device to shopfloor cell zone">
                <option value="">— Select Cell Zone —</option>
                {cells.map(c => <option key={c.cell_id} value={c.cell_id}>{c.cell_name} (Zone #{c.cell_id})</option>)}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Active Edge Gateway Selection</label>
              <select className="form-control" value={gatewayId} onChange={e => setGatewayId(e.target.value)} title="Select primary edge gateway">
                {gateways.filter(g => !g.is_archived).map(g => (
                  <option key={g.gateway_id} value={g.gateway_id}>
                    {g.gateway_name} ({g.gateway_id}) — {g.status}
                  </option>
                ))}
              </select>
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

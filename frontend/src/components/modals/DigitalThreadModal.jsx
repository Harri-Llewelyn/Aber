import React, { useState, useEffect } from 'react'
import { api } from '../../api'
import { IconHistory } from '../common/Icons'

export function DigitalThreadModal({ entityType, entityId, displayName, onClose }) {
  const [events, setEvents]   = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.get(`/api/v1/${entityType}/${entityId}/digital-thread`)
      .then(d => { setEvents(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [entityType, entityId])

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconHistory size={18} />
          <span>Digital Thread — {displayName} <span className="mono">[{entityId}]</span></span>
        </div>

        {loading ? (
          <div className="loading-wrap"><div className="spinner" /> Loading digital trace timeline…</div>
        ) : events.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><IconHistory size={36} /></div>
            <div className="empty-text">No digital thread events recorded yet for this entity.</div>
          </div>
        ) : (
          <div className="timeline" style={{ maxHeight: '420px', overflowY: 'auto', paddingRight: '8px' }}>
            {events.map(e => (
              <div key={e.event_id} className="timeline-item">
                <div className="timeline-dot" />
                <div className="timeline-content">
                  <div className="timeline-header">
                    <div className="timeline-title">
                      <span className="badge badge-neutral">{e.entity_type}</span>
                      <span className="badge badge-warning">{e.event_type}</span>
                    </div>
                    <div className="timeline-time">{new Date(e.timestamp).toLocaleString()}</div>
                  </div>
                  <div className="timeline-desc">{e.description}</div>
                  {e.metadata && Object.keys(e.metadata).length > 0 && (
                    <div className="timeline-meta">
                      {JSON.stringify(e.metadata)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} title="Close modal">Close</button>
        </div>
      </div>
    </div>
  )
}

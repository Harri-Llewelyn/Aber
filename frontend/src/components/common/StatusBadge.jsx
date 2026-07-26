import React from 'react'

export function StatusBadge({ status }) {
  const isOnline = status === 'ONLINE' || status === 'ACTIVE'
  const isOffline = status === 'OFFLINE'
  const cls = isOnline ? 'badge-online' : isOffline ? 'badge-neutral' : 'badge-warning'
  const dotColor = isOffline ? 'var(--text-muted)' : undefined

  return (
    <span className={`badge ${cls}`} title={`Operational Status: ${status}`}>
      <span className="badge-dot" style={dotColor ? { background: dotColor } : {}} />
      {status === 'OFFLINE' ? 'OFFLINE / DDEATH' : status}
    </span>
  )
}

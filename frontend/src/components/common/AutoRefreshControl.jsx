import React, { useState, useEffect } from 'react'
import { IconRefresh } from './Icons'

export function AutoRefreshControl({ onRefresh, intervalOptions = [0, 1, 5, 10, 30, 60], defaultInterval = 0 }) {
  const [refreshInterval, setRefreshInterval] = useState(defaultInterval)

  useEffect(() => {
    if (refreshInterval === 0) return
    const timer = setInterval(() => {
      onRefresh()
    }, refreshInterval * 1000)
    return () => clearInterval(timer)
  }, [refreshInterval, onRefresh])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '2px', background: 'var(--bg-card)', borderRadius: '4px', border: '1px solid var(--border)' }}>
      <button className="btn btn-ghost btn-sm" onClick={onRefresh} style={{ border: 'none', background: 'transparent', color: 'var(--text-primary)' }} title="Refresh now">
        <IconRefresh size={13} /> Refresh
      </button>
      <div style={{ width: '1px', height: '16px', background: 'var(--border)' }} />
      <select 
        value={refreshInterval} 
        onChange={e => setRefreshInterval(Number(e.target.value))}
        style={{ border: 'none', background: 'var(--bg-surface)', color: 'var(--text-primary)', fontSize: '13px', padding: '4px 8px', outline: 'none', cursor: 'pointer', borderRadius: '0 4px 4px 0' }}
        title="Auto-refresh interval"
      >
        <option value={0} style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}>Off</option>
        {intervalOptions.filter(o => o > 0).map(opt => (
          <option key={opt} value={opt} style={{ background: 'var(--bg-surface)', color: 'var(--text-primary)' }}>{opt}s</option>
        ))}
      </select>
    </div>
  )
}

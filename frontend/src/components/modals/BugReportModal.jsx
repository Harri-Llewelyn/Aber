import React, { useState } from 'react'
import { GITHUB_REPO_URL } from '../../constants'
import { IconBug, IconExternalLink } from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'

export function BugReportModal({ onClose, showToast, persona, activeTab }) {
  // Escape closes. Via the shared stack rather than a listener of this component's own,
  // because a ConfirmModal can open on top of this one and a bare document listener on each
  // would let one keypress dismiss both.
  useEscapeKey(onClose)

  const [title, setTitle]       = useState('')
  const [category, setCategory] = useState('UI Dashboard')
  const [severity, setSeverity] = useState('Medium')
  const [desc, setDesc]         = useState('')

  const submitToGithub = () => {
    if (!title.trim()) {
      showToast('Please enter an issue title', 'error')
      return
    }

    const issueTitle = `[${severity.toUpperCase()}] [${category}] ${title}`
    const issueBody = `## 🐛 Bug Report / Issue Summary

**Category:** ${category}
**Severity:** ${severity}
**Active Tab:** /${activeTab}
**User Persona:** ${persona}
**Timestamp:** ${new Date().toISOString()}
**Browser Agent:** ${navigator.userAgent}

### Description & Steps to Reproduce
${desc || 'No detailed steps provided.'}

---
*Generated via ACS-Cymru Asset Tracking Dashboard Bug Reporter.*`

    // Composed from the configured repository rather than a hardcoded one -- see
    // GITHUB_REPO_URL in constants.js for why this was wrong and why it keeps a fallback.
    const fullUrl = `${GITHUB_REPO_URL}/issues/new` +
      `?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent(issueBody)}`

    // noopener: window.open without it leaves the new tab holding a reference to this one
    // through window.opener, which it can use to navigate the dashboard elsewhere.
    window.open(fullUrl, '_blank', 'noopener,noreferrer')
    showToast('Redirected to GitHub Issue creation', 'success')
    onClose()
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconBug size={18} style={{ color: 'var(--danger)' }} /> Report Platform Bug / Create GitHub Issue
        </div>

        <div className="form-group">
          <label className="form-label">Issue Title</label>
          <input className="form-control" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Telemetry metric display error on devices page" title="Short descriptive title" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className="form-group">
            <label className="form-label">Category</label>
            <select className="form-control" value={category} onChange={e => setCategory(e.target.value)}>
              <option value="UI Dashboard">UI Dashboard</option>
              <option value="Ingestion Pipeline">Ingestion Pipeline</option>
              <option value="FastAPI Backend">FastAPI Backend</option>
              <option value="Node-RED Gateway">Node-RED Gateway</option>
              <option value="TimescaleDB">TimescaleDB</option>
              <option value="Other">Other</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Severity</label>
            <select className="form-control" value={severity} onChange={e => setSeverity(e.target.value)}>
              <option value="Low">Low</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
              <option value="Critical">Critical</option>
            </select>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Description & Steps to Reproduce</label>
          <textarea className="form-control" rows={4} value={desc} onChange={e => setDesc(e.target.value)} placeholder="Describe the unexpected behavior or steps to reproduce…" style={{ resize: 'vertical' }} />
        </div>

        <div style={{ padding: '10px 12px', background: 'var(--bg-base)', borderRadius: '8px', border: '1px solid var(--border)', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px' }}>
          <strong>Auto-Captured Environment Context:</strong><br />
          Page Path: <code>/{activeTab}</code> | Persona: <code>{persona}</code>
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submitToGithub} style={{ gap: '6px' }}>
            <IconExternalLink size={13} /> Submit Issue on GitHub ↗
          </button>
        </div>
      </div>
    </div>
  )
}

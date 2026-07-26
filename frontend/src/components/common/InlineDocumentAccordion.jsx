import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import {
  IconFileText,
  IconChevronDown,
  IconChevronRight,
  IconPencil,
  IconExternalLink,
  IconPlus,
  IconImage,
  IconShieldCheck,
  IconTag,
  IconFileCode,
  IconSharePoint,
  IconDrive,
  IconGithub,
  IconGlobe
} from './Icons'

const TAG_ICONS = {
  image:             <IconImage size={12} />,
  health_and_safety: <IconShieldCheck size={12} />,
  procurement:       <IconTag size={12} />,
  schematic:         <IconFileCode size={12} />,
  other:             <IconFileText size={12} />,
}

const TAG_LABELS = {
  image:             'Image',
  health_and_safety: 'Health & Safety',
  procurement:       'Procurement',
  schematic:         'Schematic',
  other:             'Other',
}

function getDomainBadgeIcon(url = '') {
  const lower = url.toLowerCase()
  if (lower.includes('sharepoint.com')) {
    return <span className="badge" style={{ background: 'rgba(0,120,212,0.15)', color: '#0078d4', border: '1px solid #0078d4', gap: '4px' }}><IconSharePoint size={12} /> SharePoint</span>
  }
  if (lower.includes('drive.google.com') || lower.includes('docs.google.com')) {
    return <span className="badge" style={{ background: 'rgba(15,157,88,0.15)', color: '#0f9d58', border: '1px solid #0f9d58', gap: '4px' }}><IconDrive size={12} /> Google Drive</span>
  }
  if (lower.includes('github.com')) {
    return <span className="badge badge-neutral" style={{ gap: '4px' }}><IconGithub size={12} /> GitHub</span>
  }
  return <span className="badge badge-neutral" style={{ gap: '4px' }}><IconGlobe size={12} /> External Link</span>
}

export function InlineDocumentAccordion({ entityType, entityId, entityName, onOpenModal, hasPermission, refreshKey, documentCount = 0 }) {
  const [expanded, setExpanded] = useState(false)
  const [docs, setDocs]         = useState([])
  const [loading, setLoading]   = useState(false)
  const [lastRefreshKey, setLastRefreshKey] = useState(refreshKey)

  const canManage = hasPermission ? hasPermission(PERMISSION_UUIDS.DOCUMENT_MANAGE) : true

  const fetchDocs = useCallback(() => {
    setLoading(true)
    api.get(`/api/v1/documents?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`)
      .then(d => { setDocs(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [entityType, entityId])

  useEffect(() => {
    if (refreshKey !== lastRefreshKey) {
      setLastRefreshKey(refreshKey)
      if (expanded || docs.length > 0) {
        fetchDocs()
      }
    }
  }, [refreshKey, lastRefreshKey, expanded, docs.length, fetchDocs])

  const toggleExpand = () => {
    const next = !expanded
    setExpanded(next)
    if (next) {
      fetchDocs()
    }
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden', background: 'var(--bg-glass)', marginTop: '8px' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', cursor: 'pointer', userSelect: 'none',
          background: expanded ? 'rgba(255,255,255,0.03)' : 'transparent',
          borderBottom: expanded ? '1px solid var(--border)' : 'none'
        }}
        onClick={toggleExpand}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
          {expanded ? <IconChevronDown size={14} style={{ color: 'var(--accent)' }} /> : <IconChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
          <IconFileText size={14} style={{ color: 'var(--accent)' }} />
          <span>Attached Document Links</span>
          <span className="badge badge-neutral" style={{ fontSize: '10px', padding: '2px 7px' }}>{expanded && !loading ? docs.length : (documentCount || docs.length)}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }} onClick={e => e.stopPropagation()}>
          <button className="btn btn-ghost btn-sm" style={{ padding: '3px 8px', fontSize: '11px', gap: '4px' }} onClick={() => onOpenModal()} title={canManage ? 'Manage external document links' : 'View external document links'}>
            {canManage ? <><IconPencil size={11} /> Manage Links</> : <><IconExternalLink size={11} /> View Links</>}
          </button>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '12px', background: 'var(--bg-base)' }}>
          {loading ? (
            <div className="loading-wrap" style={{ padding: '12px', fontSize: '12px' }}><div className="spinner" style={{ width: 14, height: 14 }} /> Loading documents…</div>
          ) : docs.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)', padding: '4px 6px' }}>
              <span>No external document links attached to this {entityType}.</span>
              {canManage && (
                <button className="btn btn-primary btn-sm" style={{ padding: '3px 8px', fontSize: '11px', gap: '4px' }} onClick={() => onOpenModal()}>
                  <IconPlus size={11} /> Add Link
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {docs.map(d => (
                <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: '6px', padding: '8px 10px', gap: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                    <span className="badge badge-neutral" style={{ fontSize: '10px', gap: '4px', padding: '2px 6px', flexShrink: 0 }}>
                      {TAG_ICONS[d.document_tag] || <IconFileText size={12} />}
                      {TAG_LABELS[d.document_tag] || 'Other'}
                    </span>
                    <strong style={{ fontSize: '12px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.display_name}</strong>
                    {getDomainBadgeIcon(d.url)}
                  </div>

                  <a href={d.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm" style={{ padding: '3px 8px', fontSize: '11px', textDecoration: 'none', gap: '4px', flexShrink: 0 }}>
                    <IconExternalLink size={11} /> Open ↗
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { ConfirmModal } from './ConfirmModal'
import {
  IconBookOpen,
  IconX,
  IconPlus,
  IconPencil,
  IconTrash,
  IconExternalLink,
  IconFileText,
  IconImage,
  IconShieldCheck,
  IconTag,
  IconFileCode,
  IconSharePoint,
  IconDrive,
  IconGithub,
  IconGlobe
} from '../common/Icons'

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

export function EntityDocumentsModal({ entityType, entityId, entityName, onClose, showToast, hasPermission }) {
  const [docs, setDocs]               = useState([])
  const [loading, setLoading]         = useState(true)
  const [showForm, setShowForm]       = useState(false)
  const [editingDoc, setEditingDoc]   = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [form, setForm]               = useState({ display_name: '', url: '', document_tag: 'other' })

  const canManage = hasPermission ? hasPermission(PERMISSION_UUIDS.DOCUMENT_MANAGE) : true

  const loadDocs = useCallback(() => {
    setLoading(true)
    api.get(`/api/v1/documents?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`)
      .then(d => { setDocs(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [entityType, entityId])

  useEffect(() => { loadDocs() }, [loadDocs])

  const openNew = () => {
    setEditingDoc(null)
    setForm({ display_name: '', url: '', document_tag: 'other' })
    setShowForm(true)
  }

  const openEdit = (doc) => {
    setEditingDoc(doc)
    setForm({ display_name: doc.display_name, url: doc.url, document_tag: doc.document_tag || 'other' })
    setShowForm(true)
  }

  const save = async () => {
    if (!form.display_name.trim()) {
      showToast('Document name is required', 'error')
      return
    }
    if (!form.url.trim() || (!form.url.startsWith('http://') && !form.url.startsWith('https://'))) {
      showToast('Please enter a valid HTTP/HTTPS URL (e.g. https://...)', 'error')
      return
    }

    try {
      if (editingDoc) {
        await api.put(`/api/v1/documents/${editingDoc.id}`, form)
        showToast(`Document link '${form.display_name}' updated`, 'success')
      } else {
        await api.post('/api/v1/documents', { ...form, entity_type: entityType, entity_id: entityId })
        showToast(`Document link '${form.display_name}' attached`, 'success')
      }
      setShowForm(false)
      loadDocs()
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const removeDoc = async (id, name) => {
    try {
      await api.delete(`/api/v1/documents/${id}`)
      setConfirmDelete(null)
      loadDocs()
      showToast(`Document link '${name}' removed`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <IconBookOpen size={18} style={{ color: 'var(--accent)' }} />
            <span>Document Links — <strong style={{ color: 'var(--accent)' }}>{entityName}</strong></span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Close modal"><IconX size={14} /></button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            Attached External Links ({docs.length})
          </div>

          <button className={`btn btn-primary btn-sm ${!canManage ? 'btn-disabled' : ''}`} disabled={!canManage} onClick={openNew} title="Attach new document link">
            <IconPlus size={13} /> Add Link
          </button>
        </div>

        {showForm && (
          <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-hover)', borderRadius: '8px', padding: '16px', marginBottom: '20px' }}>
            <div style={{ fontWeight: 600, marginBottom: '12px', color: 'var(--accent)', fontSize: '13px' }}>
              {editingDoc ? 'Edit Document Link' : 'Register New External Document Link'}
            </div>
            <div className="form-group">
              <label className="form-label">Document Display Name</label>
              <input className="form-control" value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} placeholder="e.g. Operating Manual, Electrical Schematic, Safety Audit" />
            </div>
            <div className="form-group">
              <label className="form-label">Link URL (SharePoint / Google Drive / Cloud Link)</label>
              <input className="form-control" type="url" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://company.sharepoint.com/documents/manual.pdf" />
            </div>
            <div className="form-group">
              <label className="form-label">Document Classification Tag</label>
              <select className="form-control" value={form.document_tag} onChange={e => setForm(f => ({ ...f, document_tag: e.target.value }))}>
                <option value="image">Image</option>
                <option value="health_and_safety">Health & Safety</option>
                <option value="procurement">Procurement</option>
                <option value="schematic">Schematic</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={save}>Save Link</button>
            </div>
          </div>
        )}

        <div style={{ maxHeight: '340px', overflowY: 'auto' }}>
          {loading ? <div className="loading-wrap"><div className="spinner" /> Loading document links…</div> :
           docs.length === 0 ? (
             <div className="empty-state" style={{ padding: '30px 10px' }}>
               <div className="empty-icon"><IconBookOpen size={30} /></div>
               <div className="empty-text">No document links attached to this {entityType}.</div>
             </div>
           ) : (
             <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
               {docs.map(d => (
                 <div key={d.id} style={{ background: 'var(--bg-glass)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                   <div style={{ minWidth: 0, flex: 1 }}>
                     <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                       <strong style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{d.display_name}</strong>
                       <span className="badge badge-neutral" style={{ fontSize: '10px', gap: '4px' }}>
                         {TAG_ICONS[d.document_tag] || <IconFileText size={12} />}
                         {TAG_LABELS[d.document_tag] || 'Other'}
                       </span>
                       {getDomainBadgeIcon(d.url)}
                     </div>
                     <div className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                       {d.url}
                     </div>
                   </div>

                   <div className="btn-group" style={{ flexShrink: 0 }}>
                     <a href={d.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm" style={{ textDecoration: 'none', gap: '4px' }} title="Open document link in new tab">
                       <IconExternalLink size={12} /> Open ↗
                     </a>
                     {canManage && (
                       <button className="btn btn-ghost btn-sm" onClick={() => openEdit(d)} title="Edit link metadata">
                         <IconPencil size={12} />
                       </button>
                     )}
                     {canManage && (
                       <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(d)} title="Remove document link">
                         <IconTrash size={12} />
                       </button>
                     )}
                   </div>
                 </div>
               ))}
             </div>
           )
          }
        </div>

        {confirmDelete && (
          <ConfirmModal
            message={`Are you sure you want to remove the document link '${confirmDelete.display_name}'?`}
            onConfirm={() => removeDoc(confirmDelete.id, confirmDelete.display_name)}
            onCancel={() => setConfirmDelete(null)}
          />
        )}

        <div className="modal-actions" style={{ marginTop: '20px' }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

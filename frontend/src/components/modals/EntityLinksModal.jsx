import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { ActionButton } from '../common/ActionButton'
import { usePendingAction } from '../../hooks/usePendingAction'
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
  IconClipboardList,
  IconUpload,
  IconSharePoint,
  IconDrive,
  IconGithub,
  IconGlobe
} from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'

/**
 * The tag vocabulary. These keys are stored values and must not be renamed: `links.link_tag`
 * carries no CHECK constraint, so an existing row with an old key falls through to Other. Labels
 * are display text and may be reworded. `asset_register` points at an external register such as
 * EZOfficeInventory; `file_repository` points at where files belong, since this platform stores no
 * such files.
 */
const TAG_ICONS = {
  image:             <IconImage size={12} />,
  health_and_safety: <IconShieldCheck size={12} />,
  procurement:       <IconTag size={12} />,
  schematic:         <IconFileCode size={12} />,
  asset_register:    <IconClipboardList size={12} />,
  file_repository:   <IconUpload size={12} />,
  other:             <IconFileText size={12} />,
}

const TAG_LABELS = {
  image:             'Image',
  health_and_safety: 'Health & Safety',
  procurement:       'Procurement',
  schematic:         'Schematic',
  asset_register:    'Asset Register',
  file_repository:   'File Repository',
  other:             'Other',
}

/** What each tag is for, on the option and on the badge. */
const TAG_HINTS = {
  image:             'A photograph or rendering of the asset',
  health_and_safety: 'Risk assessments, safe systems of work, COSHH sheets',
  procurement:       'Purchase orders, quotations, supplier records',
  schematic:         'Drawings, wiring diagrams, P&IDs',
  asset_register:    'This asset in an external asset tracker, such as EZOfficeInventory',
  file_repository:   'Where files for this asset are saved — measurement data, exports, logs. '
                     + 'The platform stores no such files; this records where they belong.',
  other:             'Anything else with a URL',
}

function getDomainBadgeIcon(url = '') {
  const lower = url.toLowerCase()
  if (lower.includes('sharepoint.com')) {
    return <span className="badge badge-brand badge-sharepoint"><IconSharePoint size={12} /> SharePoint</span>
  }
  if (lower.includes('drive.google.com') || lower.includes('docs.google.com')) {
    return <span className="badge badge-brand badge-drive"><IconDrive size={12} /> Google Drive</span>
  }
  if (lower.includes('github.com')) {
    return <span className="badge badge-neutral" style={{ gap: '4px' }}><IconGithub size={12} /> GitHub</span>
  }
  return <span className="badge badge-neutral" style={{ gap: '4px' }}><IconGlobe size={12} /> External Link</span>
}

export function EntityLinksModal({ entityType, entityId, entityName, onClose, showToast, hasPermission }) {
  // Escape closes through the shared stack, so a ConfirmModal opened on top takes the keypress.
  useEscapeKey(onClose)

  // `links` here and on the wire: the endpoint, the table and the payload key all use the same
  // vocabulary.
  const [links, setLinks]             = useState([])
  const [loading, setLoading]         = useState(true)
  const [showForm, setShowForm]       = useState(false)
  const [editingLink, setEditingLink] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [form, setForm]               = useState({ display_name: '', url: '', link_tag: 'other' })

  const canManage = hasPermission?.(PERMISSION_UUIDS.LINK_MANAGE) ?? false

  const loadLinks = useCallback(() => {
    setLoading(true)
    api.get(`/api/v1/links?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`)
      .then(d => { setLinks(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [entityType, entityId])

  useEffect(() => { loadLinks() }, [loadLinks])

  const openNew = () => {
    setEditingLink(null)
    setForm({ display_name: '', url: '', link_tag: 'other' })
    setShowForm(true)
  }

  const openEdit = (doc) => {
    setEditingLink(doc)
    setForm({ display_name: doc.display_name, url: doc.url, link_tag: doc.link_tag || 'other' })
    setShowForm(true)
  }

  const save = async () => {
    if (!form.display_name.trim()) {
      showToast('Link name is required', 'error')
      return
    }
    if (!form.url.trim() || (!form.url.startsWith('http://') && !form.url.startsWith('https://'))) {
      showToast('Please enter a valid HTTP/HTTPS URL (e.g. https://...)', 'error')
      return
    }

    try {
      if (editingLink) {
        await api.put(`/api/v1/links/${editingLink.id}`, form)
        showToast(`Link '${form.display_name}' updated`, 'success')
      } else {
        await api.post('/api/v1/links', { ...form, entity_type: entityType, entity_id: entityId })
        showToast(`Link '${form.display_name}' attached`, 'success')
      }
      setShowForm(false)
      loadLinks()
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  const removeLink = async (id, name) => {
    try {
      await api.delete(`/api/v1/links/${id}`)
      setConfirmDelete(null)
      loadLinks()
      showToast(`Link '${name}' removed`, 'success')
    } catch (e) {
      showToast(e.message, 'error')
    }
  }

  // The link form's Save. The validation guards above return early WITHOUT a request, so the
  // pending state clears on the same tick -- a rejected form must not leave a button spinning.
  const [savingLink, runSaveLink] = usePendingAction()

  return (
    <div className="modal-overlay">
      <div className="modal modal-lg">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <IconBookOpen size={18} style={{ color: 'var(--accent)' }} />
            <span>Attached Links — <strong style={{ color: 'var(--accent)' }}>{entityName}</strong></span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Close modal"><IconX size={14} /></button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {links.length} attached
          </div>

          <button className={`btn btn-primary btn-sm ${!canManage ? 'btn-disabled' : ''}`} disabled={!canManage} onClick={openNew} title="Attach a new link to this asset">
            <IconPlus size={13} /> Add Link
          </button>
        </div>

        {showForm && (
          <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-hover)', borderRadius: '8px', padding: '16px', marginBottom: '20px' }}>
            <div style={{ fontWeight: 600, marginBottom: '12px', color: 'var(--accent)', fontSize: '13px' }}>
              {editingLink ? 'Edit Link' : 'Add a New Link'}
            </div>
            <div className="form-group">
              <label className="form-label">Display Name</label>
              <input className="form-control" value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} placeholder="e.g. Operating Manual, Asset Register Entry, Measurement Data Share" />
            </div>
            <div className="form-group">
              <label className="form-label">Link URL (SharePoint, Google Drive, an asset tracker, any URL)</label>
              <input className="form-control" type="url" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://company.sharepoint.com/documents/manual.pdf" />
            </div>
            <div className="form-group">
              <label className="form-label">Tag</label>
              {/* Built from TAG_LABELS rather than written out again, so a stored tag is always
                  selectable in the form that wrote it. */}
              <select className="form-control" value={form.link_tag} onChange={e => setForm(f => ({ ...f, link_tag: e.target.value }))}>
                {Object.entries(TAG_LABELS).map(([value, label]) => (
                  <option key={value} value={value} title={TAG_HINTS[value]}>{label}</option>
                ))}
              </select>
              {/* The chosen tag's meaning, under the control. File Repository especially needs it:
                  it is the one tag that names a destination rather than a document. */}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {TAG_HINTS[form.link_tag]}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)} disabled={savingLink}>Cancel</button>
              <ActionButton
                className="btn btn-primary btn-sm"
                pending={savingLink}
                pendingLabel="Saving…"
                onClick={() => runSaveLink(save)}
              >
                Save Link
              </ActionButton>
            </div>
          </div>
        )}

        <div style={{ maxHeight: '340px', overflowY: 'auto' }}>
          {loading ? <div className="loading-wrap"><div className="spinner" /> Loading links…</div> :
           links.length === 0 ? (
             <div className="empty-state" style={{ padding: '30px 10px' }}>
               <div className="empty-icon"><IconBookOpen size={30} /></div>
               <div className="empty-text">No links attached to this {entityType}.</div>
             </div>
           ) : (
             <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
               {links.map(d => (
                 <div key={d.id} style={{ background: 'var(--bg-glass)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                   <div style={{ minWidth: 0, flex: 1 }}>
                     <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                       <strong style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{d.display_name}</strong>
                       <span className="badge badge-neutral" style={{ fontSize: '11px', gap: '4px' }} title={TAG_HINTS[d.link_tag] || TAG_HINTS.other}>
                         {TAG_ICONS[d.link_tag] || <IconFileText size={12} />}
                         {TAG_LABELS[d.link_tag] || 'Other'}
                       </span>
                       {getDomainBadgeIcon(d.url)}
                     </div>
                     <div className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                       {d.url}
                     </div>
                   </div>

                   <div className="btn-group" style={{ flexShrink: 0 }}>
                     <a href={d.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm" style={{ textDecoration: 'none', gap: '4px' }} title="Open this link in a new tab">
                       <IconExternalLink size={12} /> Open ↗
                     </a>
                     {canManage && (
                       <button className="btn btn-ghost btn-sm" onClick={() => openEdit(d)} title="Edit link metadata">
                         <IconPencil size={12} />
                       </button>
                     )}
                     {canManage && (
                       <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(d)} title="Remove this link">
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
            message={`Are you sure you want to remove the link '${confirmDelete.display_name}'?`}
            pendingLabel="Removing…"
            onConfirm={() => removeLink(confirmDelete.id, confirmDelete.display_name)}
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

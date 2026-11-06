import React, { useState, useEffect, useCallback } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { ActionButton } from '../common/ActionButton'
import { Badge } from '../common/Badge'
import { EmptyState } from '../common/EmptyState'
import { FormProblem } from '../common/FormProblem'
import { LoadingState } from '../common/LoadingState'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { entityUrl } from '../../routes'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ConfirmModal } from './ConfirmModal'
import { Tooltip } from '../common/Tooltip'
import {
  IconBookOpen,
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
  image:             'A photograph or rendering',
  health_and_safety: 'Risk assessments, safe systems of work, COSHH sheets',
  procurement:       'Purchase orders, quotations, supplier records',
  schematic:         'Drawings, wiring diagrams, P&IDs',
  asset_register:    'An entry in an external asset tracker, such as EZOfficeInventory',
  file_repository:   'Where files are saved — measurement data, exports, logs. '
                     + 'The platform stores no such files; this records where they belong.',
  other:             'Anything else with a URL',
}

// The badge names the site by the link's host, so a path or query that merely mentions a domain
// cannot borrow its badge. Links are always http(s), which the form requires.
function linkHost(url) {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}
const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`)

function getDomainBadgeIcon(url = '') {
  const host = linkHost(url)
  if (onDomain(host, 'sharepoint.com')) {
    return <Badge tone="brand" brand="sharepoint" size="sm" icon={<IconSharePoint size={12} />}>SharePoint</Badge>
  }
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    return <Badge tone="brand" brand="drive" size="sm" icon={<IconDrive size={12} />}>Google Drive</Badge>
  }
  if (onDomain(host, 'github.com')) {
    return <Badge size="sm" icon={<IconGithub size={12} />}>GitHub</Badge>
  }
  return <Badge size="sm" icon={<IconGlobe size={12} />}>External Link</Badge>
}

export function EntityLinksModal({ entityType, entityId, entityName, onClose, showToast, hasPermission }) {
  const [links, setLinks]             = useState([])
  const [loading, setLoading]         = useState(true)
  const [showForm, setShowForm]       = useState(false)
  const [editingLink, setEditingLink] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [form, setForm]               = useState({ display_name: '', url: '', link_tag: 'other' })
  const [error, setError]             = useState(null)
  // The link form's first edit, so a form that has just opened does not scold.
  const [linkEdited, setLinkEdited]   = useState(false)

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
    setLinkEdited(false)
    setShowForm(true)
  }

  const openEdit = (doc) => {
    setEditingLink(doc)
    setForm({ display_name: doc.display_name, url: doc.url, link_tag: doc.link_tag || 'other' })
    setLinkEdited(false)
    setShowForm(true)
  }

  const setField = (key) => (e) => { setForm(f => ({ ...f, [key]: e.target.value })); setLinkEdited(true) }

  // Why Save Link is off, said above the form's buttons from its first edit.
  const linkProblem = !form.display_name.trim() ? 'Give the link a name'
    : !form.url.trim() ? 'Enter the address it links to'
      : !form.url.startsWith('http://') && !form.url.startsWith('https://') ? 'The address must start with http:// or https://'
        : null

  const save = async () => {
    setError(null)
    if (linkProblem) return

    try {
      if (editingLink) {
        await api.put(`/api/v1/links/${editingLink.id}`, form)
        showToast(`Link '${form.display_name}' updated`, 'success', { to: entityUrl(entityType, entityId) })
      } else {
        await api.post('/api/v1/links', { ...form, entity_type: entityType, entity_id: entityId })
        showToast(`Link '${form.display_name}' attached${entityName ? ` to '${entityName}'` : ''}`, 'success', { to: entityUrl(entityType, entityId) })
      }
      setShowForm(false)
      loadLinks()
    } catch (e) {
      // In this dialog: a toast would be drawn behind it.
      setError(e.message)
    }
  }

  // Run from Remove link's dialog, which shows a refusal and stays open.
  const removeLink = async (id, name) => {
    await api.delete(`/api/v1/links/${id}`)
    setConfirmDelete(null)
    loadLinks()
    showToast(`Link '${name}' removed${entityName ? ` from '${entityName}'` : ''}`, 'success', { to: entityUrl(entityType, entityId) })
  }

  // The link form's Save, held while linkProblem says why.
  const [savingLink, runSaveLink] = usePendingAction()

  return (
    <Modal
      title={<>Attached Links — <strong>{entityName}</strong></>}
      icon={<IconBookOpen size={18} />}
      size="lg"
      onClose={onClose}
      error={error}
      footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}
      fill
    >

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {links.length} attached
          </div>

          <ActionButton
            className="btn btn-primary btn-sm"
            permitted={canManage}
            deniedTitle={requiresRolesTitle(PERMISSION_UUIDS.LINK_MANAGE)}
            onClick={openNew}
            title={`Attach a new link to this ${entityType}`}
          >
            <IconPlus size={13} /> Add Link
          </ActionButton>
        </div>

        {showForm && (
          <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-hover)', borderRadius: '8px', padding: '16px', marginBottom: '20px' }}>
            <div style={{ fontWeight: 600, marginBottom: '12px', color: 'var(--accent)', fontSize: '13px' }}>
              {editingLink ? 'Edit Link' : 'Add a New Link'}
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="link-name">Display Name <RequiredMark /></label>
              <input id="link-name" className="form-control" value={form.display_name} onChange={setField('display_name')} placeholder="e.g. Operating Manual, Asset Register Entry, Measurement Data Share" aria-required="true" />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="link-url">Link URL (SharePoint, Google Drive, an asset tracker, any URL) <RequiredMark /></label>
              <input id="link-url" className="form-control" type="url" value={form.url} onChange={setField('url')} placeholder="https://company.sharepoint.com/documents/manual.pdf" aria-required="true" />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="link-tag">Tag</label>
              {/* Built from TAG_LABELS rather than written out again, so a stored tag is always
                  selectable in the form that wrote it. */}
              <select id="link-tag" className="form-control" value={form.link_tag} onChange={setField('link_tag')}>
                {Object.entries(TAG_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              {/* The chosen tag's meaning, under the control. File Repository especially needs it:
                  it is the one tag that names a destination rather than a document. */}
              <div className="form-hint">
                {TAG_HINTS[form.link_tag]}
              </div>
            </div>
            <FormProblem problem={linkEdited ? linkProblem : null} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForm(false)} disabled={savingLink}>Cancel</button>
              <ActionButton
                className="btn btn-primary btn-sm"
                pending={savingLink}
                pendingLabel="Saving…"
                disabled={linkProblem !== null}
                title={linkProblem ?? undefined}
                onClick={() => runSaveLink(save)}
              >
                Save Link
              </ActionButton>
            </div>
          </div>
        )}

        {/* The list takes the dialog's spare height and scrolls inside it, down to a floor. */}
        <div className="modal-fill" style={{ minHeight: '120px', overflowY: 'auto' }}>
          {loading ? <LoadingState label="links" /> :
           links.length === 0 ? (
             <EmptyState icon={<IconBookOpen size={30} />} message={`No links attached to this ${entityType}.`} />
           ) : (
             <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
               {links.map(d => (
                 <div key={d.id} style={{ background: 'var(--bg-glass)', border: '1px solid var(--border)', borderRadius: '8px', padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                   <div style={{ minWidth: 0, flex: 1 }}>
                     <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                       <strong style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{d.display_name}</strong>
                       <Badge size="sm" icon={TAG_ICONS[d.link_tag] || <IconFileText size={12} />} title={TAG_HINTS[d.link_tag] || TAG_HINTS.other}>
                         {TAG_LABELS[d.link_tag] || 'Other'}
                       </Badge>
                       {getDomainBadgeIcon(d.url)}
                     </div>
                     <div className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                       {d.url}
                     </div>
                   </div>

                   <div className="btn-group" style={{ flexShrink: 0 }}>
                     <Tooltip text="Open this link in a new tab">
                       <a href={d.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm" style={{ textDecoration: 'none', gap: '4px' }}>
                         <IconExternalLink size={12} /> Open ↗
                       </a>
                     </Tooltip>
                     {canManage && (
                       <Tooltip text="Edit link metadata">
                         <button className="btn btn-ghost btn-sm" onClick={() => openEdit(d)} aria-label={`Edit ${d.display_name}`}>
                           <IconPencil size={12} />
                         </button>
                       </Tooltip>
                     )}
                     {canManage && (
                       <Tooltip text="Remove this link">
                         <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(d)} aria-label={`Remove ${d.display_name}`}>
                           <IconTrash size={12} />
                         </button>
                       </Tooltip>
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
            title="Remove link"
            icon={<IconTrash size={18} />}
            message={`Are you sure you want to remove the link '${confirmDelete.display_name}'?`}
            confirmLabel="Remove link"
            pendingLabel="Removing…"
            onConfirm={() => removeLink(confirmDelete.id, confirmDelete.display_name)}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
    </Modal>
  )
}

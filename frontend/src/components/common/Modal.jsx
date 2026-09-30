import React, { useId } from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { IconAlertTriangle, IconX } from './Icons'

const SIZES = { sm: 'modal-sm', md: 'modal-md', lg: 'modal-lg', xl: 'modal-xl', wide: 'modal-wide' }

/**
 * The frame every dialog shares: overlay, header row (icon, title, close button), an optional lead
 * paragraph, the body, an error slot and a footer. It renders `role="dialog"`, `aria-modal` and an
 * `aria-labelledby` pointing at the title, and closes on Escape through the shared `useEscapeKey`
 * stack, so a Modal opened over another one answers the keypress first.
 *
 * ```jsx
 * <Modal
 *   title="Rename area"
 *   icon={<IconEdit size={18} />}
 *   size="md"
 *   onClose={() => setOpen(false)}
 *   lead="The name is shown on the Site Map and in the Audit Trail."
 *   error={saveError}
 *   footer={
 *     <>
 *       <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
 *       <ActionButton className="btn btn-primary" pending={saving} onClick={save}>Save</ActionButton>
 *     </>
 *   }
 * >
 *   <div className="form-group">...</div>
 * </Modal>
 * ```
 *
 * @param {React.ReactNode} title What the dialog is for, naming the act ("Restore metric x"), not
 * "Confirm". A node is allowed, so a name can be set in `mono`.
 *
 * @param {React.ReactNode} [icon] Shown before the title; pass a sized icon element.
 *
 * @param {'sm'|'md'|'lg'|'xl'|'wide'} [size] A step of the width scale in App.css: sm 400px,
 * default 480px, md 560px, lg 640px, xl 720px, wide 900px. Pick by content: sm for a yes/no
 * question, md for a form with a list, lg for a document, xl for two columns, wide for a table.
 *
 * @param {Function} onClose Called by Escape, the close button and (when enabled) the overlay. A
 * dialog that must not close while work runs passes a no-op for that time; the button and the key
 * then do nothing rather than the layer leaving the Escape stack.
 *
 * @param {React.ReactNode} [lead] One paragraph under the header saying what the dialog will do.
 *
 * @param {React.ReactNode} [error] The failure to show, in the danger box above the footer. Falsy
 * renders nothing. Show a failure here rather than only in a toast, which is gone by the time the
 * operator looks back at the dialog.
 *
 * @param {React.ReactNode} [footer] The buttons, as siblings (the row is `.modal-actions`).
 * Convention, not enforced: dismiss on the left (ghost "Cancel", or "Close" for a read-only
 * dialog), the primary act on the right, and a destructive act rightmost and styled
 * `btn btn-danger`.
 *
 * @param {boolean} [closeOnOverlay] Whether a click outside the dialog closes it. Default false:
 * set it only on a dialog that holds no input, where nothing can be discarded by a stray click.
 *
 * @param {React.ReactNode} [headerActions] Controls that sit in the header row beside the close
 * button, for an act on what the dialog shows (an export button on a table).
 *
 * @param {'confirm'} [layer] `confirm` raises the overlay above the ordinary dialog layer, for a
 * dialog that opens over another one.
 */
export function Modal({
  title,
  icon = null,
  size,
  onClose,
  lead = null,
  error = null,
  footer = null,
  closeOnOverlay = false,
  headerActions = null,
  layer,
  children
}) {
  const titleId = useId()
  useEscapeKey(onClose)

  const overlayClass = `modal-overlay${layer === 'confirm' ? ' modal-overlay-confirm' : ''}`
  const modalClass = `modal${SIZES[size] ? ` ${SIZES[size]}` : ''}`

  return (
    <div
      className={overlayClass}
      // The target test, not stopPropagation on the dialog: a click that starts inside and ends on
      // the overlay (selecting text) must not close it, and this keeps clicks reaching the dialog.
      onClick={closeOnOverlay ? e => { if (e.target === e.currentTarget) onClose() } : undefined}
    >
      <div className={modalClass} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-header-row">
          <h2 className="modal-title" id={titleId}>
            {icon}
            <span>{title}</span>
          </h2>
          <div className="modal-header-controls">
            {headerActions}
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={onClose}
              aria-label="Close"
              title="Close (Esc)"
            >
              <IconX size={15} />
            </button>
          </div>
        </div>

        {lead && <p className="modal-lead">{lead}</p>}

        {children}

        {error && (
          <div className="modal-error" role="alert">
            <IconAlertTriangle size={13} className="modal-error-icon" />
            <span>{error}</span>
          </div>
        )}

        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </div>
  )
}

import React, { useId, useLayoutEffect, useRef } from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { FormProblem } from './FormProblem'
import { IconAlertTriangle, IconX } from './Icons'
import { Tooltip } from './Tooltip'

/** The width steps App.css defines. `default` is the bare `.modal`, as leaving `size` out is. */
const SIZES = { sm: 'modal-sm', default: '', md: 'modal-md', lg: 'modal-lg', xl: 'modal-xl', wide: 'modal-wide', full: 'modal-full' }

/** The open dialogs, oldest first. The last is on top, and everything outside it is inert. */
const openDialogs = []

/** What had focus as each dialog opened. Kept after it closes, for a dialog opened from inside it. */
const openers = new WeakMap()

/** The topmost open dialog element, or null. */
export const topDialog = () => openDialogs[openDialogs.length - 1] ?? null

/**
 * Where to append an element that must be usable over the page, such as the clipboard's scratch
 * field or a tooltip: the topmost open dialog, or <body>. While a dialog is open the rest of the
 * page is inert and drawn beneath it, so an element in <body> can be neither seen nor selected.
 */
export const overlayHost = () => topDialog() ?? document.body

const nothingFocused = () => !document.activeElement || document.activeElement === document.body

/** The control `initialFocus` names, when it can take focus; otherwise the dialog itself. */
function focusStart(dialog, initialFocus) {
  const control = initialFocus?.current
  if (control && dialog.contains(control)) {
    control.focus()
    if (document.activeElement === control) return
  }
  dialog.focus()
}

/** The page's main region. It is made focusable for this, and stops being once focus leaves it. */
function focusMain() {
  const main = document.querySelector('main')
  if (!main) return
  if (!main.hasAttribute('tabindex')) {
    main.setAttribute('tabindex', '-1')
    main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true })
  }
  main.focus({ preventScroll: true })
}

/** Focuses `target`. Failing that, the dialog still open beneath, or the page's main region. */
function restoreFocus(target) {
  if (target?.isConnected) target.focus({ preventScroll: true })
  if (target && document.activeElement === target) return
  const below = topDialog()
  if (below) below.focus()
  else focusMain()
}

/**
 * Hands focus back to what opened `dialog`. When that sits in a dialog which has closed too (both
 * closed in one update), focus goes to what opened that one.
 */
function returnFocus(dialog) {
  let target = openers.get(dialog)
  if (!target || target === document.body) return
  for (let host = target.closest?.('dialog'); host && !host.open; host = target?.closest?.('dialog')) {
    target = openers.get(host)
  }
  restoreFocus(target)
  // The opener can be removed later in the same commit, with the row it sat in: look again after.
  queueMicrotask(() => { if (nothingFocused()) restoreFocus(target) })
}

/**
 * The frame every dialog shares: a native `<dialog>` opened with `showModal()`, holding the box
 * (header row with icon, title and close button, an optional lead paragraph, the body, an error
 * slot and a footer). The header and the footer stay in view: only the body (the lead and the
 * children, in `.modal-body`) scrolls when the dialog is taller than the window, and the problem
 * line and the error slot sit above the footer outside it.
 *
 * The browser draws an open dialog above the page and makes the rest of the page inert, so Tab and
 * Shift+Tab stay inside it. Opening moves focus to the dialog itself, which is named by the title
 * and described by the lead, or to `initialFocus`. Closing hands focus back to what had it before,
 * or to the page's `main` when that has gone. Escape goes through the shared `useEscapeKey` stack,
 * so a dialog opened over another one answers first.
 *
 * ```jsx
 * <Modal
 *   title="Edit Area"
 *   subject={area.area_name}
 *   icon={<IconPencil size={18} />}
 *   busy={saving}
 *   onClose={() => setOpen(false)}
 *   lead="Saves the changes to this area."
 *   initialFocus={nameRef}
 *   problem={check.problem}
 *   error={saveError}
 *   dismiss="Cancel"
 *   footer={<ActionButton pending={saving} pendingLabel="Saving…" onClick={() => check.press(save)}>Save Area</ActionButton>}
 * >
 *   <div className="form-group">...</div>
 * </Modal>
 * ```
 *
 * @param {string} title The act, in Title Case ("Edit Area", "Archive Device"), not "Confirm". The
 * record it acts on is `subject`, never written into the title.
 *
 * @param {React.ReactNode} [subject] The record's name, which the title shows after a dash, in `mono`:
 * "Edit Area — Assembly". A long one wraps in the title and is never cut.
 *
 * @param {React.ReactNode} icon The act's icon, sized 18, before the title: the table in
 * frontend/README.md's *A dialog's header names its act* says which. Every dialog has one; drift
 * check 612 holds it.
 *
 * @param {'sm'|'default'|'md'|'lg'|'xl'|'wide'|'full'} [size] A step of the width scale in App.css,
 * named by the content that earns it: sm 400px for a question with no field, default 480px for
 * stacked form fields, md 560px for a form with a list in it, lg 640px for content rather than input,
 * xl 720px for two columns of fields, wide 900px for a table. Leaving it out is the default step.
 * `full` is the window less a margin, in height as well, for a view that is the dialog's whole point
 * (an area's plan, a device's 3D model); pass `fill` with it. A form is never sm, and sibling dialogs
 * share a step: drift check 530 holds both.
 *
 * @param {Function} onClose Called by Escape, the close button, the dismiss button, a close request
 * from the browser (Android's back gesture) and (when enabled) the backdrop.
 *
 * @param {boolean} [busy] Holds the dialog open while its work runs: each of those then does nothing,
 * and the two buttons are greyed. The layer stays on the Escape stack, so the key does not reach the
 * dialog beneath. Never a no-op `onClose`: that locks one way out and leaves another.
 *
 * @param {React.ReactNode} [lead] One paragraph under the header saying what the dialog will do.
 * It is the dialog's accessible description. Every form has one; a viewer or a result may leave it out.
 *
 * @param {React.RefObject<HTMLElement>} [initialFocus] A ref to the control focus starts on, for a
 * dialog whose first field is the obvious place to start. Without it, focus starts on the dialog
 * itself, so a screen reader reads the title and the lead first. Never a button that deletes,
 * revokes or overwrites. Read once, as the dialog opens; `autoFocus` inside a dialog does not work,
 * because the control is focused before the dialog is shown.
 *
 * @param {string|null} [problem] Why the act cannot go ahead, or null: the first problem, shown above
 * the footer in the form's warning hint, in a live region. A form's is `useFormCheck()`'s, which is
 * null until a press asks for it, so a dialog that has just opened does not scold. Leave it out on a
 * dialog that never refuses, and the line is not drawn.
 *
 * @param {React.ReactNode} [error] The failure to show, in the danger box above the footer. Falsy
 * renders nothing. Show a failure here rather than only in a toast: the toasts are behind an open
 * dialog, where they can be neither read nor heard. A refusal from the database or a function goes
 * here as it was worded.
 *
 * @param {boolean} [fill] Makes the body a flex column, so one child with class `modal-fill` takes the
 * height left over (and scrolls inside itself) instead of its own height guess. Without it the body
 * is an ordinary block.
 *
 * @param {'Cancel'|'Close'|'Done'} [dismiss] The dismiss button, which calls `onClose`. "Cancel" while
 * anything can be lost and "Close" when nothing can, both ghost and before the footer's acts; "Done"
 * after a result, the primary and after them.
 *
 * @param {React.ReactNode} [footer] The acts, as siblings, in the row with the dismiss button
 * (`.modal-actions`): a lesser act first as ghost, then the primary, and a destructive act rightmost
 * as `btn btn-danger`.
 *
 * @param {boolean} [closeOnOverlay] Whether a click outside the box closes it. Default false:
 * set it only on a dialog that holds no input, where nothing can be discarded by a stray click.
 *
 * @param {React.ReactNode} [headerActions] Controls that sit in the header row beside the close
 * button, for an act on what the dialog shows (an export button on a table).
 *
 * @param {string} [className] A class on the box beside its step, for a layout rule one dialog needs
 * (the schema detail dialog's footer wraps). Never a width: that is `size`.
 */
export function Modal({
  title,
  subject = null,
  icon = null,
  size,
  onClose,
  busy = false,
  lead = null,
  initialFocus,
  problem,
  error = null,
  dismiss = null,
  footer = null,
  closeOnOverlay = false,
  headerActions = null,
  fill = false,
  className,
  children
}) {
  const titleId = useId()
  const leadId = useId()
  const ref = useRef(null)
  const close = () => { if (!busy) onClose?.() }
  // The listeners below are bound once, as the dialog opens, and read the props through this.
  const latest = useRef(null)
  latest.current = { close, initialFocus }
  useEscapeKey(close)
  const held = busy ? ' btn-disabled' : ''

  useLayoutEffect(() => {
    const dialog = ref.current
    // A close request the Escape stack did not take. Escape reaches the stack first, which cancels
    // the keypress, so this is another kind, such as Android's back gesture.
    const onCancel = (e) => { e.preventDefault(); latest.current.close() }
    // The browser closes a dialog itself when it will not let a close request be cancelled. The
    // dialog goes when React unmounts it, so until then it opens again.
    const onNativeClose = () => { dialog.showModal(); focusStart(dialog, null) }

    openers.set(dialog, document.activeElement)
    dialog.addEventListener('cancel', onCancel)
    dialog.addEventListener('close', onNativeClose)
    dialog.showModal()
    openDialogs.push(dialog)
    focusStart(dialog, latest.current.initialFocus)

    return () => {
      dialog.removeEventListener('cancel', onCancel)
      dialog.removeEventListener('close', onNativeClose)
      openDialogs.splice(openDialogs.lastIndexOf(dialog), 1)
      dialog.close()
      returnFocus(dialog)
    }
  }, [])

  // Focus falls to <body> when the control holding it is removed, as when a dialog moves on to its
  // next step. It goes back to the dialog rather than staying behind it.
  useLayoutEffect(() => {
    if (ref.current === topDialog() && nothingFocused()) ref.current.focus()
  })

  const modalClass = ['modal', SIZES[size], className].filter(Boolean).join(' ')

  return (
    <dialog
      ref={ref}
      className="modal-overlay"
      // The element's own role and modality, stated for code that looks for `[role="dialog"]`.
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={lead ? leadId : undefined}
      tabIndex={-1}
      // A click on the backdrop, or on the dialog around the box, has the dialog as its target.
      onClick={closeOnOverlay ? e => { if (e.target === e.currentTarget) close() } : undefined}
    >
      <div className={modalClass}>
        <div className="modal-header-row">
          <h2 className="modal-title" id={titleId}>
            {icon}
            <span>
              {title}
              {subject && <> — <span className="mono modal-subject">{subject}</span></>}
            </span>
          </h2>
          <div className="modal-header-controls">
            {headerActions}
            <Tooltip text="Close (Esc)">
              <button type="button" className={`btn btn-ghost btn-icon${held}`} onClick={close} disabled={busy} aria-label="Close">
                <IconX size={15} />
              </button>
            </Tooltip>
          </div>
        </div>

        <div className={`modal-body${fill ? ' modal-body-fill' : ''}`}>
          {lead && <p className="modal-lead" id={leadId}>{lead}</p>}
          {children}
        </div>

        {problem !== undefined && (
          <FormProblem problem={problem} className="modal-problem" />
        )}

        {error && (
          <div className="modal-error" role="alert">
            <IconAlertTriangle size={13} className="modal-error-icon" />
            <span>{error}</span>
          </div>
        )}

        {(dismiss || footer) && (
          <div className="modal-actions">
            {dismiss && dismiss !== 'Done' && (
              <button type="button" className={`btn btn-ghost${held}`} onClick={close} disabled={busy}>{dismiss}</button>
            )}
            {footer}
            {dismiss === 'Done' && (
              <button type="button" className={`btn btn-primary${held}`} onClick={close} disabled={busy}>Done</button>
            )}
          </div>
        )}
      </div>
    </dialog>
  )
}

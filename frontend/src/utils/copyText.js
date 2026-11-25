import { overlayHost } from '../components/common/Modal'

/** Whether `el` has the focus a keyboard gave it. A control a pointer pressed does not. */
const keyboardFocused = (el) => {
  try { return Boolean(el?.matches?.(':focus-visible')) } catch { return false }
}

/**
 * Copy the given text, returning true on success. `navigator.clipboard` exists only in a secure
 * context, and the dashboard is served over plain HTTP, so anyone reaching it by IP has none; the
 * execCommand fallback is what makes copy work there. Its field goes in the open dialog when there
 * is one: outside it the page is inert, and an inert field cannot be selected. Selecting that field
 * takes the focus. A control the keyboard is on gets it back, and the dialog has it otherwise, since
 * a control given the focus by script shows its tooltip.
 */
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or a non-secure origin that still exposes the API. Fall through.
    }
  }

  const back = keyboardFocused(document.activeElement) ? document.activeElement : overlayHost()
  const el = document.createElement('textarea')
  el.value = text
  // Keep it out of view and out of the tab order, but still selectable.
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.top = '-9999px'
  try {
    overlayHost().appendChild(el)
    el.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    el.remove()
    back.focus?.({ preventScroll: true })
  }
}

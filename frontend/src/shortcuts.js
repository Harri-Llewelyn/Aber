import { createContext } from 'react'

/*
 * When a keyboard shortcut bound on the whole document may act, in one place. App.jsx's `?`, `/`,
 * `[` and `]`, and Ctrl K's dialog check, read it. A shortcut is a character read from `e.key`,
 * never a key code, so a layout that types it with Shift or AltGr still works.
 */

/**
 * An open dialog or popover: the shared `Modal` and the popovers (`role="dialog"`, `aria-modal`),
 * and a native `<dialog>` opened with showModal(), which carries neither attribute. A shortcut
 * stands down behind one, so the key never reaches the page it covers.
 */
export const OPEN_DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog[open]'

export const dialogIsOpen = (doc = document) => doc.querySelector(OPEN_DIALOG_SELECTOR) !== null

/** A target the character would be typed into: a field, a textarea, a select or contenteditable. */
export function isEditableTarget(el) {
  const tag = el?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el?.isContentEditable
}

/**
 * Ctrl, Cmd or Alt held. AltGr is not: Windows reports it as Ctrl+Alt, and German, French and
 * Nordic layouts need it to type `[` and `]`, so a check without this would never let them through.
 */
export function commandModifierHeld(e) {
  if (e.metaKey) return true
  if (e.getModifierState?.('AltGraph')) return false
  return !!(e.ctrlKey || e.altKey)
}

/** Whether a keydown may act as a shortcut: nothing to type into, no Ctrl, Cmd or Alt, no dialog open. */
export const shortcutAllowed = (e, doc = document) =>
  !isEditableTarget(e.target) && !commandModifierHeld(e) && !dialogIsOpen(doc)

/**
 * The shortcuts that are one character with no modifier. WCAG 2.2 SC 2.1.4 asks for a way to turn
 * them off, since speech input can type them by mistake: the person's Single-key shortcuts setting
 * (Profile > Appearance, user_settings.single_key_shortcuts) turns all four off together. Ctrl K and
 * the arrow keys are not character keys, and it leaves them alone.
 */
export const SINGLE_KEY_SHORTCUTS = ['?', '/', '[', ']']

export const singleKeyShortcutAllowed = (e, enabled, doc = document) =>
  !!enabled && SINGLE_KEY_SHORTCUTS.includes(e.key) && shortcutAllowed(e, doc)

/** The person's Single-key shortcuts setting, for what names a key: a box's `aria-keyshortcuts`, its `/` hint. */
export const SingleKeyShortcutsContext = createContext(true)

/** Not drawn: `display: none` on it or an ancestor, or a `hidden` ancestor where jsdom cannot say. */
export const isShown = (el) => (typeof el.checkVisibility === 'function'
  ? el.checkVisibility()
  : !el.closest('[hidden]'))

/** The tab bar `[` and `]` step through: the open page's TabStrip, inside `main`. */
export const PAGE_TAB_BAR_SELECTOR = 'main nav.tab-strip'

/**
 * Moves the open page's tab bar one tab back (-1) or on (+1) and says whether it moved. It clicks
 * the tab, so the URL, the history entry and whatever the page resets follow as they do for a
 * click, then focuses it, so a screen reader reads its name. Found by where it sits, like
 * focusPageSearch: the first shown tab bar in `main`, its links, the one with
 * `aria-current="page"`. It stops at the first and last tab, and does nothing without a tab bar.
 */
export function stepPageTab(step, doc = document) {
  const list = [...doc.querySelectorAll(PAGE_TAB_BAR_SELECTOR)].find(isShown)
  if (!list) return false
  const tabs = [...list.querySelectorAll('a[href]')]
  const at = tabs.findIndex(t => t.getAttribute('aria-current') === 'page')
  const target = tabs[at + step]
  if (!target) return false
  target.click()
  target.focus()
  return true
}

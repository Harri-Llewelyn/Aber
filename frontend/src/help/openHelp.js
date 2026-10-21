import { HELP_FILES } from './index'

/**
 * Opening the help panel at a file and a heading, from anywhere in the app. The panel
 * (components/common/HelpPanel.jsx) listens; nothing else needs a handle on it. Two ways in:
 *   openHelpAt('guides/glossary', 'quarantine')       from code, such as a search result
 *   <a data-help="guides/glossary#quarantine" href=…>  from markup: the panel takes a plain click
 *                                                     on it, and the href is the fallback
 * See frontend/README.md, Contextual help.
 */

const listeners = new Set()

/**
 * `{ file, anchor }` for a value such as `site/install`, `site/install#upgrading` or
 * `help/site/install.md`, or null when no such file is bundled.
 */
export function helpTarget(value, heading = null) {
  let spec = String(value ?? '').trim()
  const hash = spec.indexOf('#')
  let anchor = heading || null
  if (hash !== -1) {
    anchor = anchor || spec.slice(hash + 1) || null
    spec = spec.slice(0, hash)
  }
  if (spec.startsWith('help/')) spec = spec.slice('help/'.length)
  if (spec.endsWith('.md')) spec = spec.slice(0, -'.md'.length)
  return HELP_FILES[spec] ? { file: spec, anchor } : null
}

/**
 * Opens the help panel at `file` (a key of HELP_FILES, such as `guides/tutorial`), scrolled to the
 * heading `headingId` when one is given. While the panel is open this is a step Back returns from.
 * Returns false, and does nothing, for a file that is not bundled.
 */
export function openHelpAt(file, headingId = null) {
  const target = helpTarget(file, headingId)
  if (!target) return false
  for (const listener of listeners) listener(target)
  return true
}

/** For the panel: calls `listener({ file, anchor })` on each request. Returns the unsubscribe. */
export function onHelpRequest(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

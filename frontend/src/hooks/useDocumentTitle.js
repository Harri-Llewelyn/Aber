import { useEffect } from 'react'

/** The static title in index.html, and what the tab reads while no screen has set its own. */
export const APP_TITLE = 'Aber'

/** Leads the title while the strip under the top bar says the page has stopped updating. */
export const NOT_UPDATING_PREFIX = 'Not updating · '

/**
 * "Aber | Gateways", "(3) Aber | Gateways" while alerts are firing, and "Not updating · Aber |
 * Gateways" while the page cannot refresh. The prefixes lead so a truncated background tab still
 * shows them.
 */
export function documentTitle(page, alertCount = 0, notUpdating = false) {
  const base = page ? `${APP_TITLE} | ${page}` : APP_TITLE
  const counted = alertCount > 0 ? `(${alertCount}) ${base}` : base
  return notUpdating ? `${NOT_UPDATING_PREFIX}${counted}` : counted
}

/**
 * Keeps the browser tab's title in step with the screen. Restores APP_TITLE on unmount, so a
 * screen that sets no title of its own does not inherit the last page and its alert count.
 */
export function useDocumentTitle(page, alertCount = 0, notUpdating = false) {
  const title = documentTitle(page, alertCount, notUpdating)
  useEffect(() => {
    document.title = title
    return () => { document.title = APP_TITLE }
  }, [title])
}

import { useEffect } from 'react'

/** The static title in index.html, and what the tab reads while no screen has set its own. */
export const APP_TITLE = 'Aber'

/**
 * "Aber | Gateways", or "(3) Aber | Gateways" while alerts are firing. The count leads so a
 * truncated background tab still shows it.
 */
export function documentTitle(page, alertCount = 0) {
  const base = page ? `${APP_TITLE} | ${page}` : APP_TITLE
  return alertCount > 0 ? `(${alertCount}) ${base}` : base
}

/**
 * Keeps the browser tab's title in step with the screen. Restores APP_TITLE on unmount, so a
 * screen that sets no title of its own does not inherit the last page and its alert count.
 */
export function useDocumentTitle(page, alertCount = 0) {
  const title = documentTitle(page, alertCount)
  useEffect(() => {
    document.title = title
    return () => { document.title = APP_TITLE }
  }, [title])
}

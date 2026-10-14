import { useEffect } from 'react'

/** The tab's icon, as index.html declares it, and the same mark with a red dot (both in public/). */
export const FAVICON = '/favicon.svg'
export const ALERT_FAVICON = '/favicon-alert.svg'

/**
 * Shows the red-dot icon while `alertCount` is above zero: a pinned tab shows only its icon, not
 * the title's count. Swaps the href of index.html's own icon link, a static file, so the
 * Content-Security-Policy needs no data: URL. Restores the plain icon on unmount.
 */
export function useAlertFavicon(alertCount = 0) {
  const href = alertCount > 0 ? ALERT_FAVICON : FAVICON
  useEffect(() => {
    const link = document.querySelector('link[rel="icon"]')
    if (!link) return undefined
    link.setAttribute('href', href)
    return () => { link.setAttribute('href', FAVICON) }
  }, [href])
}

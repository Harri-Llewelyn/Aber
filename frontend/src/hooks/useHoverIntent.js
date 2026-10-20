import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Hover intent: `open` turns true only once the pointer has rested on the target for `delay`
 * milliseconds, so a pointer crossing it on the way somewhere else opens nothing. Leaving cancels
 * the wait and closes at once. `show` opens at once, for keyboard focus, which has no crossing to
 * filter out; `hide` closes and cancels a wait (Escape, blur).
 *
 * Spread `onMouseEnter` and `onMouseLeave` onto the target, or call them from its own handlers.
 *
 * @param {number} delay How long the pointer must rest, in milliseconds.
 *
 * @returns {{ open: boolean, onMouseEnter: Function, onMouseLeave: Function, show: Function, hide: Function }}
 */
export function useHoverIntent(delay = 150) {
  const [open, setOpen] = useState(false)
  const timer = useRef(null)

  const cancel = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = null
  }, [])

  const onMouseEnter = useCallback(() => {
    cancel()
    timer.current = setTimeout(() => {
      timer.current = null
      setOpen(true)
    }, delay)
  }, [cancel, delay])

  const show = useCallback(() => { cancel(); setOpen(true) }, [cancel])
  const hide = useCallback(() => { cancel(); setOpen(false) }, [cancel])

  // A wait still running when the target unmounts must not set state afterwards.
  useEffect(() => cancel, [cancel])

  return { open, onMouseEnter, onMouseLeave: hide, show, hide }
}

import { useEffect, useRef } from 'react'

/**
 * A pointer down anywhere outside the ref's element closes the layer. Separate from `useEscapeKey`
 * because a pointer event names its target, so no stack is needed. Listens on `mousedown` and
 * `touchstart` in the capture phase: the gesture is judged where it started, and a handler that
 * stops propagation cannot leave the panel open.
 *
 * @param {Function} onOutside Called when a pointer goes down outside the returned ref's element.
 *
 * @param {boolean} active Pass false while the layer is closed.
 *
 * @returns {object} ref for the wrapper, not the panel: the control that toggles the layer must be
 * inside it, or the same click closes and reopens it.
 */
export function useClickOutside(onOutside, active = true) {
  const ref = useRef(null)
  // Held in a ref so a parent re-creating its handler inline on every render does not tear the
  // listener down and rebuild it on every render as well.
  const handler = useRef(onOutside)
  handler.current = onOutside

  useEffect(() => {
    if (!active) return

    const onPointerDown = (e) => {
      const el = ref.current
      // A layer that has unmounted its element mid-gesture is not one this can answer for.
      if (!el) return
      // `composedPath` first, so a click inside a shadow root still resolves to its host; `contains`
      // is the fallback for jsdom and for browsers that do not supply the path.
      const path = typeof e.composedPath === 'function' ? e.composedPath() : null
      const inside = path ? path.includes(el) : el.contains(e.target)
      if (!inside) handler.current?.()
    }

    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('touchstart', onPointerDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('touchstart', onPointerDown, true)
    }
  }, [active])

  return ref
}

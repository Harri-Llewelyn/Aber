import { useEffect, useRef } from 'react'

/**
 * A click anywhere else closes the layer.
 *
 * WHY THIS EXISTS BESIDE `useEscapeKey` RATHER THAN INSIDE IT. Escape needs a stack, because modals
 * here open on top of one another and one keypress must dismiss exactly the topmost. A pointer
 * carries its own answer: the event names the element it landed on, so "is this mine" is a
 * containment test rather than a question about ordering. Merging the two would give this behaviour
 * a stack it has no use for, and give Escape a ref it does not need.
 *
 * IT LISTENS ON `mousedown`, NOT `click`, and the difference shows up in one real case: a press
 * that begins inside the panel and finishes outside it -- selecting the text of an alert summary
 * and releasing over the page. On `click` that is a click outside and the panel vanishes mid-drag,
 * taking the selection with it. On `mousedown` the gesture is judged where it started, which is
 * where the user's intent was.
 *
 * `touchstart` alongside it, because a tap on a touch screen may never synthesise a mouse event at
 * all when the page moves under it.
 *
 * CAPTURE PHASE, so a handler that calls `stopPropagation()` -- an ActionMenu, a portal'd dialog --
 * cannot leave a panel open behind it.
 *
 * @param {Function} onOutside Called when a pointer goes down outside the returned ref's element.
 * @param {boolean}  active    Pass false while the layer is closed. A listener that runs when
 *                             nothing is open is a listener on every click in the application.
 * @returns {object} ref to attach to the element that counts as "inside" -- the WRAPPER, not the
 *                   panel: the control that toggles the layer has to be inside it, or the same
 *                   click closes the layer and immediately reopens it.
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

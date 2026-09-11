import { useEffect, useRef } from 'react'

/**
 * Escape closes the topmost dismissible layer only. Modals stack here (ConfirmModal opens over
 * another dialog), so handlers go on a stack and only the last registered is called. Module scope
 * rather than context because the layers portal to <body> and are not in one React tree. One
 * document listener serves the whole stack.
 */
const stack = []

const onKeyDown = (e) => {
  if (e.key !== 'Escape') return
  const top = stack[stack.length - 1]
  if (!top) return
  // Stop the same keypress reaching anything below -- a native <dialog>, or a listener a
  // library bound first.
  e.stopPropagation()
  top.current?.()
}

function push(ref) {
  if (stack.length === 0) document.addEventListener('keydown', onKeyDown)
  stack.push(ref)
}

function pop(ref) {
  const i = stack.lastIndexOf(ref)
  if (i !== -1) stack.splice(i, 1)
  if (stack.length === 0) document.removeEventListener('keydown', onKeyDown)
}

/**
 * @param {Function} onEscape Called when Escape is pressed and this is the topmost layer.
 *
 * @param {boolean} active Pass false to sit out: a layer that is mounted but not shown must not
 * take the top of the stack.
 */
export function useEscapeKey(onEscape, active = true) {
  // The callback is held in a ref so a parent that re-creates its `onClose` inline on every
  // render does not re-order the stack underneath an open dialog.
  const handler = useRef(onEscape)
  handler.current = onEscape

  useEffect(() => {
    if (!active) return
    push(handler)
    return () => pop(handler)
  }, [active])
}

/** Test-only: the number of layers currently listening. */
export function escapeStackDepth() {
  return stack.length
}

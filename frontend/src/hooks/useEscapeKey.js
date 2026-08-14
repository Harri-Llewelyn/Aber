import { useEffect, useRef } from 'react'

/**
 * Escape closes the TOPMOST dismissible layer, and only that one.
 *
 * Every modal binding its own `document` keydown listener would be simpler, and wrong: modals
 * stack here. ConfirmModal sits at z-index 1100 precisely so it can open ON TOP of another
 * dialog -- Directory's GitOps sync confirmation over the directory page, Archives' purge
 * confirmation over the archives table -- and if both layers listened independently, one Escape
 * would dismiss the confirmation AND the dialog that asked for it. The user would be answering
 * "no" to a question and losing their unsaved form as well.
 *
 * So handlers go on a stack and only the last one registered is called. The stack is module
 * scope rather than context because the layers are not in one React tree: ActionMenu and the
 * modals portal to <body>, and a provider would have to wrap them all to see them.
 *
 * A single listener serves the whole stack, so the page carries one keydown handler regardless
 * of how many layers are open.
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
 * @param {boolean}  active   Pass false to sit out -- a layer that is mounted but not shown must
 *                            not take the top of the stack away from one that is.
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

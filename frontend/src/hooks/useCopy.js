import { useCallback, useEffect, useRef, useState } from 'react'
import { copyText } from '../utils/copyText'

/** How long a copy button says it copied. */
export const COPY_FEEDBACK_MS = 1600

/** Said under the value when the browser refuses a copy. */
export const COPY_REFUSED = 'Could not reach the clipboard — select the value and copy it.'

/**
 * One value's copy: `copy(text)` copies it and answers whether it did; `copied` is true for a moment
 * after one that worked. After a refused one `refusal` is the sentence to show under the value, until
 * the next copy. `brief` takes the refusal away as the tick goes, for a chip in a row.
 *
 *   const { copied, refusal, copy } = useCopy()
 */
export function useCopy({ brief = false } = {}) {
  const [state, setState] = useState(null) // 'copied' | 'refused'
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = useCallback(async (text) => {
    const ok = await copyText(text)
    clearTimeout(timer.current)
    setState(ok ? 'copied' : 'refused')
    if (ok || brief) timer.current = setTimeout(() => setState(null), COPY_FEEDBACK_MS)
    return ok
  }, [brief])

  return { copied: state === 'copied', refusal: state === 'refused' ? COPY_REFUSED : null, copy }
}

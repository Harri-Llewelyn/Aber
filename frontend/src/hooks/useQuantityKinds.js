import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

/**
 * The QUDT quantity kinds, read once, the first time `wanted` is true. The semantic id picker
 * searches them in the browser, and only a dialog that holds a picker needs them: there are over a
 * thousand, so a page that never opens one does not pay for the read. A failed read leaves the
 * kinds empty and is tried again the next time `wanted` turns true.
 */
export function useQuantityKinds(wanted) {
  const [kinds, setKinds] = useState([])
  const requested = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (!wanted || requested.current) return
    requested.current = true
    Promise.resolve()
      .then(() => api.get('/api/v1/qudt-quantity-kinds'))
      .then(rows => { if (mounted.current) setKinds(Array.isArray(rows) ? rows : []) })
      .catch(() => { requested.current = false })
  }, [wanted])
  return kinds
}

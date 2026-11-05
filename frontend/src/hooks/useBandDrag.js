import { useCallback, useEffect, useRef, useState } from 'react'

/** How far a press must move, in pixels, to be a drag: a shorter one is a click. */
export const BAND_DRAG_PX = 4

/**
 * A band dragged across a timeline, by mouse or pen: the Audit Trail's tracks and History's charts.
 * A press inside an element matching `track` starts one, unless it is inside one matching `skip`;
 * touch starts none, so a finger still scrolls the page. `band` is `{ a, b }`, fractions of the
 * pressed track from the press to the pointer, while one is drawn. A release at least BAND_DRAG_PX
 * from the press calls `onBand(a, b)`; Escape drops the band, and keeps the key from a drawer under
 * it. Fractions are measured inside `inset` pixels of padding at each end of the track.
 *
 *   const { band, onPointerDown } = useBandDrag(onBand, { track: '.trail-track', skip: '.trail-node', inset: 14 })
 *   <div onPointerDown={onPointerDown}>…</div>
 */
export function useBandDrag(onBand, { track: trackSelector, skip = null, inset = 0 }) {
  const [band, setBand] = useState(null)
  const latest = useRef(onBand)
  latest.current = onBand
  const stopRef = useRef(null)
  useEffect(() => () => stopRef.current?.(), [])

  const onPointerDown = useCallback((e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return
    const track = e.target.closest?.(trackSelector)
    if (!track || (skip && e.target.closest(skip))) return
    stopRef.current?.()
    const fractionAt = (x) => {
      const r = track.getBoundingClientRect()
      const inner = r.width - 2 * inset
      return inner > 0 ? Math.min(1, Math.max(0, (x - r.left - inset) / inner)) : 0
    }
    const { pointerId, clientX: x0 } = e
    const a = fractionAt(x0)
    const far = (x) => Math.abs(x - x0) >= BAND_DRAG_PX
    let drawn = false

    const move = (ev) => {
      if (ev.pointerId !== pointerId) return
      // No button held: the release was missed (outside the window), so the press is over.
      if (ev.buttons === 0) { stop(); return }
      if (!drawn && !far(ev.clientX)) return
      drawn = true
      setBand({ a, b: fractionAt(ev.clientX) })
    }
    const up = (ev) => {
      if (ev.pointerId !== pointerId) return
      const set = drawn && far(ev.clientX)
      stop()
      if (set) latest.current(a, fractionAt(ev.clientX))
    }
    const key = (ev) => {
      if (ev.key !== 'Escape') return
      if (drawn) { ev.preventDefault(); ev.stopPropagation() }
      stop()
    }
    function stop() {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('keydown', key, true)
      stopRef.current = null
      setBand(null)
    }
    // The track keeps the pointer, so the release reaches it even outside the browser window.
    try { track.setPointerCapture?.(pointerId) } catch { /* a pointer the browser no longer has */ }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', stop)
    // Captured at the window, so it is heard before a drawer's Escape on the document.
    window.addEventListener('keydown', key, true)
    stopRef.current = stop
  }, [trackSelector, skip, inset])

  return { band, onPointerDown }
}

import { useEffect, useRef } from 'react'

/**
 * The ambient canvas behind the sign-in card, adapted from the Codrops Pipeline ambient canvas
 * background.
 *
 * Licence: Codrops permits the resource to be used freely where it is integrated into or built upon
 * in personal or commercial projects, including web apps, and forbids redistributing or selling it
 * as-is. The credit is kept as attribution. The bundled `noise.min.js` is not imported because this
 * effect never referenced it.
 *
 * Changes from the original: it is a component whose animation loop stops on unmount; the trail
 * buffer is faded each frame rather than left to saturate; `checkBounds` actually wraps pipes; no
 * noise library.
 *
 * Colours are resolved from `--bg-base` and `--accent`, so this file holds no palette of its own.
 * Light mode is a different effect: dark ink at low alpha with no blur pass, where dark is additive
 * glow drawn twice.
 */

const PIPE_COUNT = 30
const PROPS_PER_PIPE = 8
const PROPS_LENGTH = PIPE_COUNT * PROPS_PER_PIPE

const TAU = Math.PI * 2
const HALF_PI = Math.PI * 0.5
const TO_RAD = Math.PI / 180

const TURN_COUNT = 8
const TURN_AMOUNT = (360 / TURN_COUNT) * TO_RAD
const TURN_CHANCE_RANGE = 58

const BASE_SPEED = 0.5
const RANGE_SPEED = 1
const BASE_TTL = 100
const RANGE_TTL = 300
const BASE_WIDTH = 2
const RANGE_WIDTH = 4

const rand = n => n * Math.random()
const round = n => Math.round(n)

/** Triangular 0..1..0 envelope over a lifetime, so a pipe fades in and back out. */
const fadeInOut = (t, m) => {
  const half = 0.5 * m
  return Math.abs(((t + half) % m) - half) / half
}

/**
 * Resolve a CSS colour to {h, s, l}. Handles #rrggbb and #rgb; anything else returns null and the
 * caller falls back.
 */
function hexToHsl(input) {
  const value = (input || '').trim()
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
  if (!m) return null

  let hex = m[1]
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]

  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min

  if (d === 0) return { h: 0, s: 0, l: l * 100 }

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6

  return { h: h * 360, s: s * 100, l: l * 100 }
}

/**
 * The per-theme treatment, derived from the stylesheet. `hueSpread` is narrow in light mode, where
 * a spread of hues reads as an inconsistent pen.
 */
function readTheme(isLight) {
  const styles = getComputedStyle(document.documentElement)
  const ground = hexToHsl(styles.getPropertyValue('--bg-base')) || { h: 210, s: 30, l: isLight ? 95 : 6 }
  const accent = hexToHsl(styles.getPropertyValue('--accent')) || { h: 195, s: 100, l: 50 }

  const groundCss = `hsl(${ground.h.toFixed(1)},${ground.s.toFixed(1)}%,${ground.l.toFixed(1)}%)`

  return isLight
    ? {
        groundCss,
        // The ink. Darker and flatter than the accent so it reads as a drawn line.
        hue: accent.h,
        hueSpread: 24,
        saturation: 58,
        lightness: 26,
        // Visible weight is alpha divided by fade: each stroke deposits `alpha`, and every frame
        // the buffer keeps `fade` of it. Dark composites the trail twice (blurred and sharp) and
        // light once, so light's ratio sits near double dark's.
        alpha: 0.18,
        fade: 0.012,
        blur: 0,
      }
    : {
        groundCss,
        hue: accent.h,
        hueSpread: 60,
        saturation: 75,
        lightness: 50,
        alpha: 0.125,
        fade: 0.012,
        blur: 12,
      }
}

export default function AmbientPipeline({ theme }) {
  const hostRef = useRef(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    // A canvas is decoration with no accessible content, so the honest thing is to hide it from
    // assistive technology entirely rather than describe it.
    const view = document.createElement('canvas')
    view.setAttribute('aria-hidden', 'true')
    view.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;'
    host.appendChild(view)

    // The accumulation buffer. Never shown; only ever composited onto `view`.
    const trail = document.createElement('canvas')

    // try/catch, not a null check: `getContext` throws in jsdom and in browsers with canvas
    // disabled, and decoration must not take the sign-in screen down.
    let viewCtx = null
    let trailCtx = null
    try {
      viewCtx = view.getContext('2d')
      trailCtx = trail.getContext('2d', { willReadFrequently: false })
    } catch {
      viewCtx = null
    }
    if (!viewCtx || !trailCtx) {
      if (view.parentNode === host) host.removeChild(view)
      return undefined
    }

    // Set `data-theme` here before reading the tokens. React runs effects children first, so this
    // effect would otherwise read the palette before useTheme in the parent had set the attribute,
    // and paint one theme behind. It writes exactly what useTheme is about to write.
    const isLight = theme === 'light'
    if (theme && document.documentElement.getAttribute('data-theme') !== theme) {
      document.documentElement.setAttribute('data-theme', theme)
    }
    let palette = readTheme(isLight)

    // 1x, not devicePixelRatio: a blurred low-alpha field has no edges to resolve, and higher
    // density multiplies the blur cost for nothing visible.
    let width = 0
    let height = 0

    const props = new Float32Array(PROPS_LENGTH)
    let tick = 0
    let frame = null

    const reduceMotion = window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false

    function initPipe(i) {
      props.set([
        rand(width || 1),                                  // x
        0.5 * (height || 1),                               // y -- all pipes enter from the midline
        round(rand(1)) ? HALF_PI : TAU - HALF_PI,          // direction
        BASE_SPEED + rand(RANGE_SPEED),                    // speed
        0,                                                 // life
        BASE_TTL + rand(RANGE_TTL),                        // ttl
        BASE_WIDTH + rand(RANGE_WIDTH),                    // width
        palette.hue + rand(palette.hueSpread),             // hue
      ], i)
    }

    function initPipes() {
      for (let i = 0; i < PROPS_LENGTH; i += PROPS_PER_PIPE) initPipe(i)
    }

    function updatePipe(i) {
      let x = props[i]
      let y = props[i + 1]
      let direction = props[i + 2]
      const speed = props[i + 3]
      let life = props[i + 4]
      const ttl = props[i + 5]
      const width_ = props[i + 6]
      const hue = props[i + 7]

      trailCtx.strokeStyle =
        `hsla(${hue},${palette.saturation}%,${palette.lightness}%,${fadeInOut(life, ttl) * palette.alpha})`
      trailCtx.lineWidth = 1
      trailCtx.beginPath()
      trailCtx.arc(x, y, width_, 0, TAU)
      trailCtx.stroke()

      life++
      x += Math.cos(direction) * speed
      y += Math.sin(direction) * speed

      // The lattice: a pipe may only turn where it meets a 6px grid line, which is what makes the
      // paths read as orthogonal runs rather than as wander.
      const turnChance =
        !(tick % round(rand(TURN_CHANCE_RANGE))) && (!(round(x) % 6) || !(round(y) % 6))
      if (turnChance) direction += TURN_AMOUNT * (round(rand(1)) ? -1 : 1)

      // Wrapping, which the original intends and does not do.
      if (x > width) x = 0
      else if (x < 0) x = width
      if (y > height) y = 0
      else if (y < 0) y = height

      props[i] = x
      props[i + 1] = y
      props[i + 2] = direction
      props[i + 4] = life

      if (life > ttl) initPipe(i)
    }

    function render() {
      // Reclaim the accumulation buffer a little each frame. Without this the trail canvas only
      // ever gains ink and ends up a solid block.
      trailCtx.save()
      trailCtx.globalCompositeOperation = 'destination-out'
      trailCtx.fillStyle = `rgba(0,0,0,${palette.fade})`
      trailCtx.fillRect(0, 0, width, height)
      trailCtx.restore()

      viewCtx.save()
      viewCtx.fillStyle = palette.groundCss
      viewCtx.fillRect(0, 0, width, height)
      viewCtx.restore()

      if (palette.blur) {
        viewCtx.save()
        viewCtx.filter = `blur(${palette.blur}px)`
        viewCtx.drawImage(trail, 0, 0)
        viewCtx.restore()
      }

      viewCtx.save()
      viewCtx.drawImage(trail, 0, 0)
      viewCtx.restore()
    }

    function step() {
      tick++
      for (let i = 0; i < PROPS_LENGTH; i += PROPS_PER_PIPE) updatePipe(i)
      render()
      frame = window.requestAnimationFrame(step)
    }

    function resize() {
      const rect = host.getBoundingClientRect()
      width = Math.max(1, Math.floor(rect.width))
      height = Math.max(1, Math.floor(rect.height))

      view.width = width
      view.height = height
      trail.width = width
      trail.height = height

      // Sizing a canvas clears it, so the ground has to be repainted or the first frame after a
      // resize shows through to whatever is behind.
      viewCtx.fillStyle = palette.groundCss
      viewCtx.fillRect(0, 0, width, height)
    }

    resize()
    initPipes()

    if (reduceMotion) {
      // A still frame under reduced motion, seeded with a few hundred ticks so it is a composed
      // image rather than a frozen loop.
      for (let n = 0; n < 260; n++) {
        tick++
        for (let i = 0; i < PROPS_LENGTH; i += PROPS_PER_PIPE) updatePipe(i)
      }
      render()
    } else {
      frame = window.requestAnimationFrame(step)
    }

    window.addEventListener('resize', resize)

    return () => {
      window.removeEventListener('resize', resize)
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (view.parentNode === host) host.removeChild(view)
    }
  }, [theme])

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    />
  )
}

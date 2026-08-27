import { useEffect, useRef } from 'react'

/**
 * The ambient canvas behind the sign-in card.
 *
 * Adapted from the Codrops "Pipeline" ambient background. Four things changed on the way in, and
 * each is a correctness or fitness issue rather than taste:
 *
 *   1. IT IS A COMPONENT, NOT A SCRIPT. The original declares module-level `let`s, binds to
 *      `window.load`, and runs a requestAnimationFrame loop that nothing ever stops. Dropped into
 *      a React app that leaks a loop per mount -- sign out and back in a few times and the machine
 *      is running four of them against detached canvases.
 *
 *   2. THE ACCUMULATION BUFFER IS FADED, NOT LEFT TO SATURATE. The original never clears its trail
 *      canvas: strokes pile up forever, which looks right for the thirty seconds a demo page is
 *      open and turns into a solid slab on a terminal parked at a login screen all shift. A
 *      low-alpha ground fill each frame bounds it.
 *
 *   3. `checkBounds` IS ACTUALLY WIRED UP. The original takes x and y BY VALUE, reassigns the
 *      locals, and returns nothing -- so nothing ever wraps and pipes simply leave the viewport
 *      and wait out their TTL offscreen. Wrapping here keeps the density even.
 *
 *   4. `noise.min.js` IS NOT IMPORTED. The demo ships simplex noise beside this effect and this
 *      effect never references it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE COLOURS ARE READ FROM THE STYLESHEET RATHER THAN WRITTEN HERE
 *
 * A canvas cannot use a CSS variable, so the values have to be resolved in JS -- but resolving
 * them from `--bg-base` and `--accent` means this file holds no palette of its own and cannot
 * drift from the theme. That matters here more than most places: authScreenTheme.test.jsx exists
 * because a typo'd variable name once fell through to a hardcoded literal and rendered white text
 * on a white card, correct-looking in dark mode and invisible in light.
 *
 * ---------------------------------------------------------------------------------------------
 * LIGHT MODE IS A DIFFERENT EFFECT, NOT THE SAME ONE RECOLOURED
 *
 * The dark treatment is additive glow: bright low-alpha strokes accumulating on near-black, drawn
 * twice, once through a blur. That logic has no light-mode equivalent -- pale strokes on a pale
 * ground are invisible, and the blur only greys the page. So light inverts the model: dark ink at
 * low alpha on the page ground, no blur pass, reading as a plotter drawing rather than neon. One
 * motion engine, two identities, and the blur -- the expensive part -- runs in exactly the theme
 * that needs it.
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
 * Resolve a CSS colour to {h, s, l}.
 *
 * Handles the two notations App.css actually uses for these tokens -- #rrggbb and #rgb. Anything
 * else returns null and the caller falls back, rather than this quietly producing black.
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
 * The per-theme treatment, derived from whatever the stylesheet currently says.
 *
 * `hueSpread` is deliberately narrow in light mode: a spread of hues reads as playful on black and
 * as an inconsistent pen on paper.
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
        // WHAT SETS VISIBLE WEIGHT IS alpha DIVIDED BY fade, NOT alpha. Each stroke deposits
        // `alpha`; every frame the buffer gives back `fade` of everything on it, so the steady
        // state is the ratio. The two numbers cannot be tuned independently.
        //
        // AND THE RATIO IS NOT COMPARABLE ACROSS THE TWO THEMES, which is what took two passes to
        // see. Dark composites the trail buffer TWICE -- once through the blur, then again sharp
        // -- so it gets about double the effective opacity out of the same pair. Light draws it
        // once. Comparing light's ratio against dark's as though they were like-for-like is what
        // produced 1.6 on the first attempt and 6.5 on the second, both too faint.
        //
        // The ink/glow instinct behind those attempts was also backwards. Light has MORE lightness
        // contrast against its ground, not less: 28 against 95 is 67 points, where dark's 50
        // against 6 is 44. Nothing about paper needed the effect held back; only the missing
        // second composite did.
        //
        // So this sits near double dark's 10.4 -- the factor the single composite gives up.
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

    // TRY/CATCH AND NOT JUST A NULL CHECK. `getContext` is specified to return null when the
    // context type is unavailable, but it THROWS in jsdom and in browsers with canvas disabled
    // -- so a null guard alone leaves an exception escaping a passive effect and taking the
    // sign-in screen down with it. This is decoration; it is not allowed to do that.
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

    // READ THE TOKENS ONLY ONCE THE ATTRIBUTE THEY DEPEND ON IS ACTUALLY SET.
    //
    // React runs effects CHILDREN FIRST. `useTheme` lives in AuthScreen, the parent, so on a
    // theme change the order is: this effect re-runs and resolves --bg-base / --accent, and only
    // THEN does useTheme set data-theme on the root. The canvas therefore painted one theme
    // behind on every toggle -- a light card on a dark field and vice versa -- and looked correct
    // only after a reload with the dark theme stored, because the values it read from a root with
    // no data-theme at all are `:root`, which IS the dark palette. Agreement by coincidence.
    //
    // Setting it here rather than waiting is deliberate and is not a second owner of the value:
    // it writes exactly what useTheme is about to write, from the same prop useTheme derives it
    // from, and is a no-op whenever the two already agree. The alternative -- resolving the
    // palette without the DOM -- means this file carrying its own copy of the theme, which is the
    // thing the stylesheet read exists to avoid.
    const isLight = theme === 'light'
    if (theme && document.documentElement.getAttribute('data-theme') !== theme) {
      document.documentElement.setAttribute('data-theme', theme)
    }
    let palette = readTheme(isLight)

    // DELIBERATELY 1x, not devicePixelRatio. This is a soft, blurred, low-alpha field with no
    // edges anybody can resolve -- rendering it at 2x or 3x quadruples the per-frame cost of the
    // blur for a difference nobody can see. The visible canvas is stretched by CSS.
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
      // A STILL FRAME, NOT A FROZEN LOOP. Continuous drift behind a login form is a textbook
      // vestibular trigger, and "no animation" should cost nothing per frame rather than run the
      // same work and discard it. Seeding a few hundred ticks gives a composed image instead of
      // thirty lonely dots.
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

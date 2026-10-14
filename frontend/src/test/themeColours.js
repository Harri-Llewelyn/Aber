/**
 * Reads App.css the way a browser resolves it on the element carrying `data-theme`, for the tests
 * that measure or police colour. Pure functions over the stylesheet's text.
 *
 * The two theme blocks: `:root, [data-theme="dark"]` is the base every theme starts from, and
 * `[data-theme="light"]` overrides it. A token whose value holds `var()` resolves against the
 * theme it is read in, as it does on the root element that carries the attribute.
 */

export const THEME_MARKERS = {
  dark: ':root, [data-theme="dark"]',
  light: '[data-theme="light"]',
}

/** Comments blanked to spaces, newlines kept, so offsets and line numbers still match the file. */
export const blankComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))

/** Where each theme block sits: `start` at its selector, `end` just past its closing brace. */
export const themeBlockRanges = (css) => {
  const text = blankComments(css)
  return Object.fromEntries(Object.entries(THEME_MARKERS).map(([name, marker]) => {
    const start = text.indexOf(`${marker} {`)
    if (start < 0) throw new Error(`theme block not found: ${marker}`)
    const open = text.indexOf('{', start)
    const close = text.indexOf('}', open)
    return [name, { start, open, end: close + 1 }]
  }))
}

/** Each block's own declarations, name to full value, as written. */
export const tokenBlocks = (css) => {
  const text = blankComments(css)
  return Object.fromEntries(Object.entries(themeBlockRanges(css)).map(([name, { open, end }]) => {
    const body = text.slice(open + 1, end - 1)
    const tokens = Object.fromEntries(
      [...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map(m => [m[1], m[2].trim()])
    )
    return [name, tokens]
  }))
}

/** The tokens each theme resolves with: the light theme is the base block with its overrides. */
export const themeTokens = (css) => {
  const blocks = tokenBlocks(css)
  return { dark: blocks.dark, light: { ...blocks.dark, ...blocks.light } }
}

/** Split a function's arguments on top-level commas. */
const splitArgs = (s) => {
  const out = []
  let depth = 0
  let from = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    else if (s[i] === ',' && depth === 0) { out.push(s.slice(from, i).trim()); from = i + 1 }
  }
  out.push(s.slice(from).trim())
  return out
}

/** `name(args)` covering the whole value, or null. */
const call = (value) => {
  const m = value.match(/^([a-z-]+)\(([\s\S]*)\)$/i)
  if (!m) return null
  // The outer parentheses must pair with each other, not close early.
  let depth = 0
  for (let i = m[1].length; i < value.length - 1; i++) {
    if (value[i] === '(') depth++
    else if (value[i] === ')') depth--
    if (depth === 0) return null
  }
  return { name: m[1].toLowerCase(), args: splitArgs(m[2]) }
}

const NAMED = { transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1] }

/**
 * A colour value as [r, g, b, a], r/g/b in 0-255 and a in 0-1. Takes hex, rgb()/rgba(), the
 * names above, var() from `tokens`, color-mix() in srgb, and a linear-gradient() of one colour
 * (the uniform tint a toast paints as a background-image).
 */
export const resolveColour = (value, tokens, seen = new Set()) => {
  const v = value.trim()
  if (v.toLowerCase() in NAMED) return NAMED[v.toLowerCase()]

  const hex = v.match(/^#([0-9a-f]{3,8})$/i)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('')
    if (h.length !== 6 && h.length !== 8) throw new Error(`not a colour: ${v}`)
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
    return [r, g, b, h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1]
  }

  const fn = call(v)
  if (!fn) throw new Error(`not a colour: ${v}`)

  if (fn.name === 'var') {
    const name = fn.args[0]
    if (seen.has(name)) throw new Error(`var() cycle at ${name}`)
    const next = tokens[name] ?? fn.args[1]
    if (next === undefined) throw new Error(`undefined token: ${name}`)
    return resolveColour(next, tokens, new Set([...seen, name]))
  }

  if (fn.name === 'rgb' || fn.name === 'rgba') {
    // Comma syntax, or the space syntax with an optional `/ alpha`.
    const parts = fn.args.length > 1 ? fn.args : fn.args[0].replace('/', ' ').split(/\s+/)
    const [r, g, b] = parts.slice(0, 3).map(Number)
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : Number(parts[3])
    return [r, g, b, a]
  }

  if (fn.name === 'linear-gradient') {
    const stops = fn.args.map(s => resolveColour(s, tokens, seen))
    if (stops.some(s => s.some((c, i) => c !== stops[0][i]))) throw new Error(`not a uniform gradient: ${v}`)
    return stops[0]
  }

  if (fn.name === 'color-mix') {
    // CSS Color 5: missing percentages complete each other to 100; a sum under 100 scales the
    // result's alpha by it; srgb channels are interpolated premultiplied by alpha.
    const [space, ...colours] = fn.args
    if (space !== 'in srgb' || colours.length !== 2) throw new Error(`unsupported color-mix: ${v}`)
    const parsed = colours.map(arg => {
      const m = arg.match(/^([\s\S]*?)\s+(\d+(?:\.\d+)?)%$/)
      return m ? { c: resolveColour(m[1], tokens, seen), p: Number(m[2]) } : { c: resolveColour(arg, tokens, seen), p: null }
    })
    let [p1, p2] = parsed.map(x => x.p)
    if (p1 === null && p2 === null) { p1 = 50; p2 = 50 }
    else if (p2 === null) p2 = 100 - p1
    else if (p1 === null) p1 = 100 - p2
    const sum = p1 + p2
    if (sum <= 0) throw new Error(`color-mix percentages sum to zero: ${v}`)
    const w1 = p1 / sum
    const w2 = p2 / sum
    const [c1, c2] = parsed.map(x => x.c)
    const a = c1[3] * w1 + c2[3] * w2
    const rgb = [0, 1, 2].map(i => a === 0 ? 0 : (c1[i] * c1[3] * w1 + c2[i] * c2[3] * w2) / a)
    // Six places, so floating-point error does not read as a different colour.
    return [...rgb, a * Math.min(1, sum / 100)].map(x => Math.round(x * 1e6) / 1e6)
  }

  throw new Error(`unsupported colour function: ${v}`)
}

/** An [r, g, b, a] colour composited onto an opaque [r, g, b] ground, rounded as a screen would. */
export const over = ([r, g, b, a], ground) => [r, g, b].map((c, i) => Math.round(c * a + ground[i] * (1 - a)))

/**
 * The value `prop` takes in the first rule whose selector list names `selector` exactly, read from
 * the innermost blocks (a rule inside @media counts). Null when no rule declares it.
 */
export const declaration = (css, selector, prop) => {
  const text = blankComments(css)
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map(s => s.trim().replace(/\s+/g, ' '))
    if (!selectors.includes(selector)) continue
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':')
      if (i > 0 && decl.slice(0, i).trim() === prop) return decl.slice(i + 1).trim()
    }
  }
  return null
}

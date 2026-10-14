import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { blankComments, themeBlockRanges } from '../test/themeColours'

/**
 * Every colour is written once, in one of App.css's two theme blocks, and everything else reads it
 * as a token. A literal anywhere else paints one theme's colour whichever theme is showing, which
 * is how the light theme came to tint its badges with the dark theme's colours. A tint is
 * `color-mix(in srgb, var(--token) N%, transparent)` or a tint token; a shadow is a token.
 */

const SRC = path.resolve(__dirname, '..')
const APP_CSS_PATH = path.join(SRC, 'App.css')
const APP_CSS = fs.readFileSync(APP_CSS_PATH, 'utf8')

// A hex colour or a colour function. color-mix() is not one: it mixes what it is given.
const LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi

/** Source files under a directory, leaving out the tests and their helpers. */
const filesUnder = (dir, wanted) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return ['__tests__', 'test'].includes(e.name) ? [] : filesUnder(p, wanted)
    return wanted(e.name) ? [p] : []
  })

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/** `line: source` for each literal inside a declaration block, comments and `skip` ranges aside. */
const cssLiterals = (css, skip = []) => {
  let text = blankComments(css)
  for (const { start, end } of skip) {
    text = text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end)
  }
  const lines = css.split('\n')
  const found = []
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
    for (const m of block[1].matchAll(LITERAL)) {
      const line = lineOf(text, block.index + 1 + m.index)
      found.push(`${line}: ${lines[line - 1].trim()}`)
    }
  }
  return found
}

/** Each `style={{ … }}` object in a source file, with the line it starts on. */
const inlineStyles = (src) => {
  const out = []
  for (const m of src.matchAll(/style=\{\{/g)) {
    let depth = 0
    let i = m.index + 'style='.length
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) break
    }
    out.push({ line: lineOf(src, m.index), text: src.slice(m.index, i + 1) })
  }
  return out
}

describe('colour literals', () => {
  it('App.css writes no colour outside its two theme blocks', () => {
    const blocks = Object.values(themeBlockRanges(APP_CSS))
    expect(cssLiterals(APP_CSS, blocks), 'write a theme token, or color-mix() of one, instead').toEqual([])
  })

  it('no other stylesheet under src/ writes a colour', () => {
    const offenders = filesUnder(SRC, n => n.endsWith('.css'))
      .filter(p => p !== APP_CSS_PATH)
      .flatMap(p => cssLiterals(fs.readFileSync(p, 'utf8')).map(f => `${path.relative(SRC, p)}:${f}`))
    expect(offenders, 'colours are written only in App.css\'s theme blocks').toEqual([])
  })

  it('no inline style under src/ writes a colour', () => {
    const offenders = []
    for (const p of filesUnder(SRC, n => /\.jsx?$/.test(n))) {
      for (const { line, text } of inlineStyles(fs.readFileSync(p, 'utf8'))) {
        if (text.match(LITERAL)) offenders.push(`${path.relative(SRC, p)}:${line}: ${text.slice(0, 100)}`)
      }
    }
    expect(offenders, 'write var(--token) in a style object, never a colour').toEqual([])
  })

  // The guard is only as good as its matching, so it is shown catching what it exists for.
  it('catches each literal form, and only outside the skipped ranges', () => {
    const css = '.a { color: #fff; }\n.b { background: rgba(0, 0, 0, 0.5); }\n.c { border-color: hsl(0 0% 0%); }\n'
      + '.d { background: color-mix(in srgb, var(--x) 5%, transparent); }\n/* #000 in a comment */\n'
    expect(cssLiterals(css).map(f => Number(f.split(':')[0]))).toEqual([1, 2, 3])
    expect(cssLiterals(css, [{ start: 0, end: css.indexOf('.c') }]).map(f => Number(f.split(':')[0]))).toEqual([3])
    const jsx = "<div style={{ color: 'var(--x)' }} />\n<div style={{\n  background: 'rgba(255,0,0,0.1)' }} />"
    expect(inlineStyles(jsx).filter(s => s.text.match(LITERAL)).map(s => s.line)).toEqual([2])
  })
})

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { themeTokens, resolveColour, declaration } from '../test/themeColours'

/**
 * The rail's danger tone: a page or tab with a firing alert takes --danger-text, and its count is
 * filled with --danger under --danger-contrast, the way the warning tone's is. Held to WCAG AA in
 * both themes, from the rules App.css paints, as themeContrast.test.js holds the warning tone.
 */

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
const THEMES = themeTokens(APP_CSS)

const rgb = (value, tokens) => {
  const [r, g, b, a] = resolveColour(value, tokens)
  if (a !== 1) throw new Error(`${value} is translucent`)
  return [r, g, b]
}
const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}
const AA_TEXT = 4.5

describe.each(Object.keys(THEMES))('the rail\'s danger tone: %s', (themeName) => {
  const t = THEMES[themeName]
  const surface = rgb(t['--bg-surface'], t)
  /** The token a rule's `color: var(--token)` names. */
  const tokenOf = (selector, prop) => {
    const value = declaration(APP_CSS, selector, prop)
    const m = value?.match(/^var\((--[a-z0-9-]+)\)$/)
    if (!m) throw new Error(`${selector} sets no ${prop} to a single token in App.css (${value})`)
    return m[1]
  }

  it('reads as text on the rail for a page and a tab, resting and hovered', () => {
    for (const selector of ['.sidebar-item.sidebar-item-danger:not(.active)', '.sidebar-item.sidebar-item-danger:not(.active):hover', '.sidebar-tab.sidebar-tab-danger:not(.active)']) {
      const token = tokenOf(selector, 'color')
      expect(token, selector).toBe('--danger-text')
      expect(contrast(rgb(t[token], t), surface), selector).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('reads as a count on its rose fill, on the page entry and on a tab', () => {
    for (const selector of ['.sidebar-item-count-danger', '.sidebar-tab-count-danger']) {
      const fill = tokenOf(selector, 'background')
      const ink = tokenOf(selector, 'color')
      expect([fill, ink], selector).toEqual(['--danger', '--danger-contrast'])
      expect(contrast(rgb(t[ink], t), rgb(t[fill], t)), selector).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  it('keeps its fill apart from the warning count\'s, so the two tones are two colours', () => {
    expect(rgb(t['--danger'], t)).not.toEqual(rgb(t['--warning'], t))
  })
})

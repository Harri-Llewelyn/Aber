import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Callout } from '../components/common/Callout'
import { IconRecord } from '../components/common/Icons'
import { declaration, over, resolveColour, themeTokens } from '../test/themeColours'

/**
 * One callout, drawn by `Callout`: the tone picks the classes and the icon, at one size, and the
 * text has the tint's contrast floor in both themes. frontend/README.md, "Words and rules".
 */

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
const THEMES = themeTokens(APP_CSS)

/** Each tone's icon, as the glyph's own first shape draws it. */
const GLYPHS = {
  info: 'circle',
  warning: 'path[d^="M10.29 3.86"]',
  danger: 'path[d^="M12 22s8-4"]',
  success: 'polyline[points="20 6 9 17 4 12"]',
}

const box = (ui) => render(ui).container.firstChild

describe('Callout', () => {
  it.each(Object.keys(GLYPHS))('draws the %s tone with its icon at 14px, then one body', (tone) => {
    const el = box(<Callout tone={tone}>Text</Callout>)
    expect(el).toHaveClass('callout', `callout-${tone}`)
    expect(el).not.toHaveClass('callout-page')
    const [icon, body, ...rest] = el.children
    expect(icon).toHaveClass('callout-icon')
    expect(icon.getAttribute('width')).toBe('14')
    expect(icon.querySelector(GLYPHS[tone])).not.toBeNull()
    expect(body).toHaveClass('callout-body')
    expect(body).toHaveTextContent('Text')
    expect(rest).toHaveLength(0)
  })

  it('gives two tones two icons', () => {
    const icons = ['info', 'warning', 'danger', 'success'].map(tone => box(<Callout tone={tone}>x</Callout>).firstChild.innerHTML)
    expect(new Set(icons).size).toBe(4)
  })

  it('draws a title as the strong first line, with the text under it', () => {
    const body = box(<Callout tone="warning" title="Copy this now.">Closing discards it.</Callout>).children[1]
    expect(body.firstChild.tagName).toBe('STRONG')
    expect(body.firstChild).toHaveTextContent('Copy this now.')
    expect(body.children[1].tagName).toBe('DIV')
    expect(body.children[1]).toHaveTextContent('Closing discards it.')
  })

  it('is the page banner with `page`, and keeps one body', () => {
    const el = box(<Callout tone="warning" page>Two cells are unfiled.</Callout>)
    expect(el).toHaveClass('callout', 'callout-warning', 'callout-page')
    expect(el.children).toHaveLength(2)
  })

  it('stands an action after the body, and passes other props to the box', () => {
    const el = box(
      <Callout tone="info" role="status" className="extra" data-testid="strip" action={<button type="button">Stop</button>}>
        Recording
      </Callout>
    )
    expect(el).toHaveClass('callout', 'callout-info', 'extra')
    expect(el).toHaveAttribute('role', 'status')
    expect(el).toHaveAttribute('data-testid', 'strip')
    expect(el.lastChild.tagName).toBe('BUTTON')
    expect(el.children[1]).toHaveClass('callout-body')
  })

  it("draws a caller's own icon at the same size", () => {
    const icon = box(<Callout tone="info" icon={IconRecord}>Recording</Callout>).firstChild
    expect(icon).toHaveClass('callout-icon')
    expect(icon.getAttribute('width')).toBe('14')
    expect(icon.innerHTML).not.toBe(box(<Callout tone="info">x</Callout>).firstChild.innerHTML)
  })
})

/** WCAG 2.2: 4.5:1 for the text, 3:1 for the icon (SC 1.4.11). */
const AA_TEXT = 4.5
const AA_ICON = 3
const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

describe.each(Object.keys(THEMES))('a callout reads in the %s theme', (theme) => {
  const t = THEMES[theme]
  const opaque = (value) => resolveColour(value, t).slice(0, 3)
  const css = (selector, prop) => declaration(APP_CSS, selector, prop)
  // In a dialog (--bg-surface) and in a card (--bg-card).
  const grounds = { dialog: opaque(t['--bg-surface']), card: opaque(t['--bg-card']) }

  it.each(['info', 'warning', 'danger', 'success'])('%s: its text and its icon clear their floors on its tint', (tone) => {
    const text = css(`.callout-${tone}`, 'color') ?? css('.callout', 'color')
    const icon = css(`.callout-${tone} .callout-icon`, 'color')
    expect(icon, `.callout-${tone} .callout-icon has a colour`).not.toBeNull()
    for (const [where, ground] of Object.entries(grounds)) {
      const tint = over(resolveColour(css(`.callout-${tone}`, 'background'), t), ground)
      const strong = over(resolveColour(css('.callout strong', 'color'), t), tint)
      expect(contrast(over(resolveColour(text, t), tint), tint), `${tone} text in a ${where}`).toBeGreaterThanOrEqual(AA_TEXT)
      expect(contrast(strong, tint), `${tone} title in a ${where}`).toBeGreaterThanOrEqual(AA_TEXT)
      expect(contrast(over(resolveColour(icon, t), tint), tint), `${tone} icon in a ${where}`).toBeGreaterThanOrEqual(AA_ICON)
    }
  })

  it('a warning page banner: its text and its icon on the stronger tint, over the page', () => {
    const tint = over(resolveColour(css('.callout-warning.callout-page', 'background'), t), opaque(t['--bg-base']))
    const text = over(resolveColour(css('.callout-warning.callout-page', 'color'), t), tint)
    const icon = over(resolveColour(css('.callout-warning .callout-icon', 'color'), t), tint)
    expect(contrast(text, tint)).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrast(icon, tint)).toBeGreaterThanOrEqual(AA_ICON)
  })
})

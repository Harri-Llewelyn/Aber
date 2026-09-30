import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The shared visual parts in App.css: what each rule is for, pinned so a page cannot quietly
 * reshape it. jsdom computes no layout, so these read the stylesheet.
 */

const SRC = path.resolve(__dirname, '..')
const APP_CSS = fs.readFileSync(path.join(SRC, 'App.css'), 'utf8')

const esc = (s) => s.replace(/[.\-+>[\]"=()*:]/g, '\\$&')
const rule = (selector) => APP_CSS.match(new RegExp(`\\n${esc(selector)} \\{([\\s\\S]*?)\\n\\}`))?.[1]
const inline = (selector) => APP_CSS.match(new RegExp(`\\n${esc(selector)} \\{([^}]*)\\}`))?.[1]
const root = APP_CSS.match(/:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1]

describe('tokens', () => {
  it('declares the small and pill radii and the display face', () => {
    expect(root).toMatch(/--radius-xs:\s*6px/)
    expect(root).toMatch(/--radius-pill:\s*999px/)
    expect(root).toMatch(/--font-display:\s*'Outfit'/)
  })

  it('documents the z-index ladder beside the tokens', () => {
    expect(root).toMatch(/The z-index ladder/)
    expect(root).toMatch(/confirm layer/)
  })

  it('uses the pill radius for badges and counts, not a literal', () => {
    expect(rule('.badge')).toMatch(/border-radius:\s*var\(--radius-pill\)/)
    expect(rule('.section-count')).toMatch(/border-radius:\s*var\(--radius-pill\)/)
  })
})

describe('callouts', () => {
  it('drops the inline margin inside a card body and a dialog, leaving .callout itself alone', () => {
    expect(inline('.card-body > .callout, .modal .callout')).toMatch(/margin-inline:\s*0/)
    expect(rule('.callout')).toMatch(/margin:\s*12px var\(--inset\) 0/)
  })

  it.each(['.callout-danger', '.callout-info'])('%s exists', (sel) => {
    expect(rule(sel)).toBeTruthy()
  })

  it('draws every banner primitive with the one small radius', () => {
    for (const sel of ['.callout', '.readonly-notice', '.context-alert']) {
      expect(rule(sel), sel).toMatch(/border-radius:\s*var\(--radius-xs\)/)
    }
  })

  it('makes the warning page banner full width, wrapping, and clear of the card below', () => {
    const page = rule('.callout-page')
    expect(page).toMatch(/width:\s*100%/)
    expect(page).toMatch(/flex-wrap:\s*wrap/)
    expect(page).toMatch(/margin:\s*0 0 var\(--stack\)/)
    expect(rule('.callout-warning.callout-page')).toMatch(/color:\s*var\(--warning-text\)/)
  })
})

describe('badges', () => {
  it('has a small size at 11px', () => {
    expect(inline('.badge-sm')).toMatch(/font-size:\s*11px/)
  })

  it('has retired .badge-offline into .badge-danger', () => {
    expect(APP_CSS).not.toMatch(/\.badge-offline/)
    expect(APP_CSS).toMatch(/\.badge-danger,\n\.badge-critical/)
  })

  it('borders the archived form', () => {
    expect(rule('.badge-archived')).toMatch(/border:\s*1px solid var\(--warning\)/)
  })
})

describe('rows and utilities', () => {
  it('tints an archived row', () => {
    expect(inline('tr.row-archived')).toMatch(/rgba\(255, 179, 0, 0\.06\)/)
  })

  it('right-aligns the actions column, header and cell, and spaces its buttons once', () => {
    expect(rule('td.row-actions, th.row-actions')).toMatch(/text-align:\s*right/)
    expect(inline('.row-actions .btn + .btn')).toMatch(/margin-left:\s*8px/)
  })

  it.each(['.form-hint', '.eyebrow', '.truncate', '.hint-underline'])('%s exists after .cell-meta', (sel) => {
    expect(rule(sel)).toBeTruthy()
    expect(APP_CSS.indexOf(`\n${sel} {`)).toBeGreaterThan(APP_CSS.indexOf('\n.cell-meta {'))
  })

  it('.stack spaces direct children with the token', () => {
    expect(inline('.stack > * + *')).toMatch(/margin-top:\s*var\(--stack\)/)
  })

  it('.truncate is the ellipsis triplet', () => {
    const r = rule('.truncate')
    expect(r).toMatch(/overflow:\s*hidden/)
    expect(r).toMatch(/text-overflow:\s*ellipsis/)
    expect(r).toMatch(/white-space:\s*nowrap/)
  })
})

describe('icon buttons', () => {
  it('is 28px by default with a 24px small size', () => {
    expect(rule('.btn-icon')).toMatch(/width:\s*28px/)
    expect(inline('.btn-icon-sm')).toMatch(/width:\s*24px/)
    expect(inline('.btn-icon-sm')).toMatch(/height:\s*24px/)
  })
})

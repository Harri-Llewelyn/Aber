import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { CardHeading } from '../components/common/CardHeading'

/**
 * The header of a page's only card: icon and title on one row, the description on its own line,
 * all inside the usual `.card-header`. It holds no buttons: a page's buttons are in its toolbar.
 */
describe('CardHeading', () => {
  it('draws the icon, title and description in a card header', () => {
    render(
      <CardHeading
        icon={<svg data-testid="icon" />}
        title="Areas"
        description="Where cells are filed."
      />
    )
    const header = document.querySelector('.card-header.card-heading')
    const title = screen.getByRole('heading', { name: /^Areas/, level: 3 })
    expect(title).toHaveClass('section-title')
    expect(title).toContainElement(screen.getByTestId('icon'))
    expect(header.querySelector('.card-heading-description')).toHaveTextContent('Where cells are filed.')
    expect(title.contains(header.querySelector('.card-heading-description'))).toBe(false)
  })

  it('leaves out what it is not given, and honours a heading level and an id', () => {
    render(<CardHeading title="Audit Trail" level="h2" id="trail-title" />)
    expect(screen.getByRole('heading', { name: 'Audit Trail', level: 2 })).toHaveAttribute('id', 'trail-title')
    expect(document.querySelector('.card-heading-description')).toBeNull()
    expect(document.querySelector('.card-heading-note')).toBeNull()
    expect(document.querySelector('.section-count')).toBeNull()
  })

  it('draws a note as its own line after the description', () => {
    render(<CardHeading title="Cold Storage" description="Telemetry on object storage." note="Raw telemetry is kept for 14 days." />)
    const description = document.querySelector('.card-heading-description')
    const note = screen.getByText('Raw telemetry is kept for 14 days.')
    expect(note).toHaveClass('card-heading-note')
    expect(description.nextElementSibling).toBe(note)
    expect(screen.getByRole('heading', { name: 'Cold Storage' }).contains(note)).toBe(false)
  })

  it('draws no button it is handed, since a page\'s buttons belong in its toolbar', () => {
    render(<CardHeading title="Gateways" actions={<button>New Gateway</button>} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

/**
 * The source half of the rule above. CardHeading ignores an `actions` prop, so a page that passes
 * one has lost a button without an error: every `<CardHeading …>` under src/ is read and its
 * top-level attributes listed.
 */
describe('no page puts a button in its heading', () => {
  const SRC = path.resolve(__dirname, '..')
  const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(p)
    return /\.jsx?$/.test(e.name) ? [p] : []
  })

  /** The attribute names of each `<CardHeading` element, read up to its own `>` at brace depth 0. */
  const headingProps = (text) => {
    const found = []
    for (const match of text.matchAll(/<CardHeading\b/g)) {
      let depth = 0
      let i = match.index + match[0].length
      let attrs = ''
      for (; i < text.length; i++) {
        const c = text[i]
        if (depth === 0 && (c === '"' || c === "'")) {
          // A quoted attribute value may hold a `>`; its text is not an attribute name.
          i = text.indexOf(c, i + 1)
          attrs += ' '
          continue
        }
        if (c === '{') depth++
        else if (c === '}') depth--
        else if (c === '>' && depth === 0) break
        attrs += depth === 0 ? c : ' '
      }
      found.push([...attrs.matchAll(/([A-Za-z_][\w-]*)\s*=/g)].map(m => m[1]))
    }
    return found
  }

  const files = sources(SRC)

  it('reads the pages that use the heading, so a pass means something', () => {
    const using = files.filter(f => fs.readFileSync(f, 'utf8').includes('<CardHeading'))
    expect(using.length).toBeGreaterThanOrEqual(15)
  })

  it('finds no CardHeading given actions', () => {
    const offenders = files.flatMap(file => headingProps(fs.readFileSync(file, 'utf8'))
      .filter(props => props.includes('actions'))
      .map(() => path.relative(SRC, file)))
    expect(offenders, 'move the button into the page\'s .filter-bar-actions').toEqual([])
  })

  it('reads attributes the way the guard needs to', () => {
    // A JSX value holding its own `>` and `=` must not end the element or add a name.
    expect(headingProps('<CardHeading icon={<Icon size={15} />} title="a > b=c" actions={x => x > 1} />'))
      .toEqual([['icon', 'title', 'actions']])
  })
})

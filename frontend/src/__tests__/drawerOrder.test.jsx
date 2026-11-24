/**
 * Every drawer reads in one order: the title, what is wrong, the record's id, its description, the
 * other fields, the facts, the tools, and the actions pinned at the foot. ContextPanel draws it from
 * props of its own, so no page chooses its first fields; the source is read here so that a drawer
 * about a record cannot be added without its id.
 */
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { act, render, screen, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ContextPanel, FieldGroup } from '../components/common/ContextPanel'

const SRC = path.resolve(__dirname, '..')
const APP_CSS = fs.readFileSync(path.join(SRC, 'App.css'), 'utf8')
/** The body of the first rule whose selector line is exactly `selector {`, at any indent. */
const ruleOf = (selector, css = APP_CSS) => {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return undefined
  const open = css.indexOf('{', start)
  return css.slice(open + 1, css.indexOf('}', open))
}

const base = { open: true, type: 'GATEWAY', title: 'Press Line', onClose: vi.fn() }
const body = () => document.querySelector('.context-panel-body')
const labels = () => [...document.querySelectorAll('.context-panel-fields dt')].map(dt => dt.textContent.trim())

describe('the drawer\'s order', () => {
  it('is what is wrong, the id, the description, the fields, the facts, the tools, then the actions', () => {
    render(
      <ContextPanel
        {...base}
        alert={{ alert_name: 'Gateway offline', severity: 'critical', starts_at: '2026-11-24T09:00:00Z' }}
        warnings={[{ id: 'w', tone: 'warning', text: 'Disk 3.0 GiB free.' }]}
        recordId={{ label: 'Gateway UUID', value: 'gw-1' }}
        description={{ value: 'By bay 3' }}
        fields={[{ label: 'Location', value: 'Bay 1' }]}
        beforeActions={<p>Devices</p>}
        actions={[{ label: 'Edit Details', onClick: vi.fn() }]}
      >
        <p>Suppression windows</p>
      </ContextPanel>
    )
    expect([...body().children].map(el => el.className.split(' ')[0])).toEqual([
      'context-panel-warnings', 'context-panel-fields', 'context-panel-facts', 'context-panel-extras', 'context-panel-actions',
    ])
    expect(labels()).toEqual(['Gateway UUID', 'Description', 'Location'])
  })

  it('draws the id monospace and copied on a click, as every identifier is', () => {
    render(<ContextPanel {...base} recordId={{ label: 'Gateway UUID', value: 'gw-1' }} />)
    const chip = screen.getByRole('button', { name: 'Copy gateway uuid gw-1' })
    expect(chip).toHaveClass('copyable-id', 'mono')
  })

  it('says Not set for a record whose description is empty, and draws none for one that has none', () => {
    const { rerender } = render(<ContextPanel {...base} recordId={{ label: 'Area UUID', value: 'a' }} description={{ value: '' }} />)
    expect(screen.getByText('Description').closest('.context-field')).toHaveTextContent('Not set')
    rerender(<ContextPanel {...base} recordId={{ label: 'Area UUID', value: 'a' }} />)
    expect(labels()).toEqual(['Area UUID'])
  })

  it('leaves a drawer that is not about a record with its own fields alone', () => {
    render(<ContextPanel {...base} fields={[{ label: 'Purpose', value: 'x' }]} />)
    expect(labels()).toEqual(['Purpose'])
    expect(document.querySelector('.context-panel-warnings')).toBeNull()
  })
})

describe('what is wrong, at the top', () => {
  const show = (warnings, extra = {}) => render(
    <ContextPanel {...base} warnings={warnings} recordId={{ label: 'Gateway UUID', value: 'gw-1' }} {...extra} />
  )

  it('puts the alert first, then the problems, then the warnings, in one list', () => {
    show([
      { id: 'a', tone: 'warning', text: 'Disk 3.0 GiB free.' },
      false,
      { id: 'b', tone: 'danger', text: 'CA expired.' },
      null,
    ], { alert: { alert_name: 'Gateway offline', severity: 'critical' } })
    const top = body().firstElementChild
    expect([...top.children].map(el => el.className.split(' ')[0])).toEqual(['context-alert', 'context-warnings'])
    const items = within(screen.getByRole('list', { name: 'Warnings' })).getAllByRole('listitem')
    expect(items.map(li => li.textContent)).toEqual(['Problem: CA expired.', 'Warning: Disk 3.0 GiB free.'])
  })

  it('gives each tone an icon of its own shape and a word, so neither is colour alone', () => {
    show([{ id: 'a', tone: 'warning', text: 'w' }, { id: 'b', tone: 'danger', text: 'd' }])
    const [danger, warning] = screen.getAllByRole('listitem')
    expect(danger).toHaveClass('context-warning-danger')
    expect(warning).toHaveClass('context-warning-warning')
    const shape = (li) => li.querySelector('svg.context-warning-icon').innerHTML
    expect(shape(danger)).not.toBe(shape(warning))
    for (const li of [danger, warning]) expect(li.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('draws nothing when nothing is wrong', () => {
    show([false, null, undefined])
    expect(document.querySelector('.context-panel-warnings')).toBeNull()
  })
})

describe('the actions, pinned at the foot', () => {
  const pinnedBlock = APP_CSS.slice(APP_CSS.indexOf('@media (min-height: 701px)'))
  const actions = [{ label: 'Edit Details', onClick: vi.fn() }, { label: 'Archive', danger: true, onClick: vi.fn() }]
  const section = () => document.querySelector('.context-panel-actions')

  /** A drawer whose sizes are given, with the observer's callbacks to run when they change. */
  const sized = ({ drawer, band }) => {
    const size = { drawer, band }
    const run = []
    window.ResizeObserver = class { constructor(cb) { run.push(cb) } observe() {} disconnect() {} }
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      return this.classList.contains('context-panel-actions') ? size.band : 0
    })
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function () {
      return this.classList.contains('context-panel-inner') ? size.drawer : 0
    })
    return { resize: (next) => act(() => { Object.assign(size, next); run.forEach(cb => cb()) }) }
  }
  afterEach(() => { vi.restoreAllMocks(); delete window.ResizeObserver })

  it('come after the fields and the tools, so a keyboard reaches the fields first', () => {
    render(
      <ContextPanel {...base} recordId={{ label: 'Gateway UUID', value: 'gw-1' }} actions={actions}>
        <button type="button">Schedule window…</button>
      </ContextPanel>
    )
    const buttons = [...body().querySelectorAll('button')].map(b => b.textContent.trim())
    expect(buttons).toEqual(['gw-1', 'Schedule window…', 'Edit Details', 'Archive'])
  })

  it('are pinned where nothing can be measured', () => {
    render(<ContextPanel {...base} actions={actions} />)
    expect(section()).toHaveClass('context-panel-actions-pinned')
  })

  it('scroll with the fields once they would take more than 40% of the drawer, and are pinned again when they would not', () => {
    const drawer = sized({ drawer: 800, band: 320 })
    render(<ContextPanel {...base} actions={actions} />)
    expect(section()).toHaveClass('context-panel-actions-pinned')

    drawer.resize({ band: 321 })
    expect(section()).not.toHaveClass('context-panel-actions-pinned')

    drawer.resize({ drawer: 900 })
    expect(section()).toHaveClass('context-panel-actions-pinned')
  })

  it('tell the body how tall they are, which is how far a focused field is scrolled clear of them', () => {
    sized({ drawer: 800, band: 194 })
    render(<ContextPanel {...base} actions={actions} />)
    expect(body().style.getPropertyValue('--context-actions-height')).toBe('194px')
    expect(pinnedBlock).toMatch(/scroll-margin-bottom: calc\(var\(--context-actions-height, 0px\) \+ 8px\)/)
  })

  it('stick only in a window tall enough for fields beside them, and never scroll inside themselves', () => {
    // Every rule that pins is inside the one media query, so a short window has no sticky band.
    expect(APP_CSS.split('.context-panel-actions-pinned {')).toHaveLength(2)
    const rule = ruleOf('.context-panel-actions-pinned', pinnedBlock)
    expect(rule).toMatch(/position:\s*sticky/)
    expect(rule).toMatch(/bottom:\s*0/)
    expect(ruleOf('\n.context-panel-actions')).not.toMatch(/overflow/)
  })

  it('have an opaque surface of their own and a rule above it, so nothing shows through', () => {
    const rule = ruleOf('\n.context-panel-actions')
    expect(rule).toMatch(/border-top:\s*1px solid var\(--border\)/)
    expect(rule).toMatch(/background:[^;]*var\(--bg-card\)/)
  })
})

describe('a group\'s open rows', () => {
  it('are a sub-tree: indented, with a guide line down the left', () => {
    render(<FieldGroup group={{ group: 'Health', id: 'h', fields: [{ label: 'Disk Free', value: '3 GiB' }] }} />)
    const rows = screen.getByText('Disk Free').closest('dl')
    expect(rows).toHaveClass('context-subtree')
    expect(rows).not.toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Health' }))
    expect(rows).toBeVisible()

    const rule = ruleOf('\n.context-subtree')
    expect(rule).toMatch(/margin-left:/)
    expect(rule).toMatch(/border-left:\s*1px solid/)
    expect(APP_CSS).toMatch(/\.context-subtree\[hidden\] \{ display: none; \}/)
  })
})

describe('every drawer about a record passes its id', () => {
  /**
   * The drawers that are not about a record, with how many each file holds: a drawer with no id of its
   * own to show. A person's drawer starts with their email, which is how every page finds them.
   */
  const NOT_ABOUT_A_RECORD = {
    'components/common/HelpPanel.jsx': 1, // the help panel
    'components/tabs/AccessControlTab.jsx': 1, // a broker role
    'components/tabs/BackupsTab.jsx': 2, // a database's own backup, and a backup run
    'components/tabs/BuiltInAlertDrawer.jsx': 1, // a rule of the rules file
    'components/tabs/PeopleSection.jsx': 1, // a person, by their email
  }
  /** One ContextPanel whose panel is one of three objects: a lane's, which is no record, and these. */
  const PANELS_IN_AN_OBJECT = { 'components/tabs/SiteMapTab.jsx': ['areaPanel', 'cellPanel'] }

  const files = fs.readdirSync(path.join(SRC, 'components'), { recursive: true })
    .map(f => `components/${String(f).split(path.sep).join('/')}`)
    .filter(f => f.endsWith('.jsx') && f !== 'components/common/ContextPanel.jsx')
  const source = (f) => fs.readFileSync(path.join(SRC, f), 'utf8')
  const drawers = (f) => source(f).split(/<ContextPanel\b/).length - 1
  const withDrawers = files.filter(f => drawers(f) > 0)

  it('finds the drawers', () => {
    expect(withDrawers.length).toBeGreaterThanOrEqual(15)
    for (const f of Object.keys(NOT_ABOUT_A_RECORD)) expect(withDrawers, f).toContain(f)
  })

  it.each(withDrawers)('%s', (f) => {
    const src = source(f)
    if (PANELS_IN_AN_OBJECT[f]) {
      for (const name of PANELS_IN_AN_OBJECT[f]) {
        const from = src.indexOf(`const ${name} =`)
        const rest = src.slice(from)
        const next = rest.slice(1).search(/\n {2}const \w+ =/)
        expect(rest.slice(0, next), `${f}: ${name} passes no recordId`).toMatch(/\n\s+recordId:/)
      }
      return
    }
    const passed = src.split(/\n\s+recordId=\{/).length - 1
    expect(passed, `${f}: a drawer about a record passes recordId={{ label, value }}; one that is not joins the list`)
      .toBe(drawers(f) - (NOT_ABOUT_A_RECORD[f] ?? 0))
  })

  it('labels it by its kind: UUID for a uuid, ID otherwise', () => {
    const named = withDrawers.flatMap(f => [...source(f).matchAll(/recordId(?:=\{|:)([\s\S]{0,160}?)value:/g)]
      .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).filter(x => x !== 'device')))
    expect(named.sort()).toEqual([
      'App ID', 'Area UUID', 'Area UUID', 'Cell UUID', 'Cell UUID', 'Device UUID', 'Device UUID', 'Gateway UUID',
      'Gateway UUID', 'Metric UUID', 'Mutation ID', 'Proposal UUID', 'Schema UUID',
    ])
  })

  it('draws the id and the description nowhere else in a drawer', () => {
    for (const f of withDrawers.filter(f => !NOT_ABOUT_A_RECORD[f])) {
      // Only inside the drawer: a page's own forms have Description labels of their own.
      for (const piece of source(f).split(/<ContextPanel\b/).slice(1)) {
        expect(piece, f).not.toMatch(/\{ label: '(Area|Cell|Device|Gateway|Schema|Metric|Proposal) UUID', value: [^}]*mono: true/)
        expect(piece, f).not.toMatch(/\{ label: 'Description', value/)
      }
    }
  })
})

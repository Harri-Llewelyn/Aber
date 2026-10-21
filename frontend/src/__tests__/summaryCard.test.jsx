import fs from 'node:fs'
import path from 'node:path'
import React, { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SummaryCard, SummaryCards } from '../components/common/SummaryCard'
import { blankComments } from '../test/themeColours'

/**
 * The summary card Backups and Cold Storage draw above their lists. What has to hold: a card that
 * opens something is a button, reached and pressed from the keyboard, and one that opens nothing is
 * not; the state is in words in a status line, never only in the colour; the whole card in
 * sentences is the tooltip and, after the title, the accessible name; and a card is as tall in
 * every state, because every line is there and cut to one line.
 */

const APP_CSS = blankComments(fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8'))

const TIP = 'The next backup may not fit. The backup volume has 3.5 GiB free, and the last backup was 3.0 GiB.'

function Opener({ onOpen }) {
  const [open, setOpen] = useState(false)
  return (
    <SummaryCards label="Backup summary" testId="row">
      <SummaryCard
        title="Backup runs"
        testId="runs"
        value="2h ago"
        unit="last good backup"
        detail="29 of 30 succeeded in 30 days"
        state="Last run failed"
        tone="danger"
        tip="The last backup failed, and none has succeeded since."
        selected={open}
        onOpen={() => { setOpen(o => !o); onOpen() }}
      />
      <SummaryCard
        title="Storage"
        testId="storage"
        value="3.5 GiB"
        unit="free of 100.0 GiB"
        detail="48.0 GiB in 16 backups"
        state="May not fit"
        tone="warning"
        tip={TIP}
      />
    </SummaryCards>
  )
}

describe('a summary card', () => {
  it('sits in a named group with the others', () => {
    render(<Opener onOpen={vi.fn()} />)
    const row = screen.getByRole('group', { name: 'Backup summary' })
    expect(row).toHaveClass('summary-cards')
    expect(row.closest('.card-body')).toHaveClass('summary-row')
  })

  it('is a button that opens what it summarises, by click, Enter or Space, and says when it is open', () => {
    const onOpen = vi.fn()
    render(<Opener onOpen={onOpen} />)
    const card = screen.getByRole('button', { name: /^Backup runs\./ })
    expect(card.tagName).toBe('BUTTON')
    expect(card).toHaveAttribute('type', 'button')
    expect(card).toHaveAttribute('aria-pressed', 'false')
    expect(card).toHaveClass('summary-card-opens')
    // A native button turns Enter and Space into a click, so a click is what both arrive as.
    fireEvent.click(card)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(card).toHaveAttribute('aria-pressed', 'true')
    expect(card).toHaveClass('is-selected')
    // It ends in the chevron every opener ends in, hidden from a screen reader.
    expect(card.querySelector('.summary-card-chevron[aria-hidden="true"] svg')).not.toBeNull()
  })

  it('is not a button when it opens nothing, and has no chevron, but can take focus for its tooltip', () => {
    render(<Opener onOpen={vi.fn()} />)
    const card = screen.getByTestId('storage')
    expect(card.tagName).toBe('DIV')
    expect(card).toHaveAttribute('role', 'group')
    expect(card).toHaveAttribute('tabindex', '0')
    expect(card).not.toHaveAttribute('aria-pressed')
    expect(card).not.toHaveClass('summary-card-opens')
    expect(card.querySelector('.summary-card-chevron')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Storage/ })).toBeNull()
  })

  it('carries the whole sentence in its accessible name, after the title', () => {
    render(<Opener onOpen={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Backup runs. The last backup failed, and none has succeeded since.' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: `Storage. ${TIP}` })).toBe(screen.getByTestId('storage'))
  })

  it('says its state in words in a status line, with an icon, and not in the colour alone', () => {
    render(<Opener onOpen={vi.fn()} />)
    const runs = screen.getByTestId('runs-state')
    expect(runs).toHaveAttribute('role', 'status')
    expect(runs).toHaveTextContent('Last run failed')
    expect(runs.querySelector('svg')).not.toBeNull()
    expect(screen.getByTestId('runs')).toHaveClass('summary-card-danger')

    const storage = screen.getByTestId('storage-state')
    expect(storage).toHaveAttribute('role', 'status')
    expect(storage).toHaveTextContent('May not fit')
    expect(screen.getByTestId('storage')).toHaveClass('summary-card-warning')
  })

  it('draws no icon and no tint on a card with nothing wrong', () => {
    render(
      <SummaryCard title="Backup runs" testId="fine" value="2h ago" detail="30 of 30 succeeded" state="Up to date" tip="All is well." onOpen={() => {}} />
    )
    const card = screen.getByTestId('fine')
    expect(card.className).not.toMatch(/summary-card-(warning|danger)/)
    expect(screen.getByTestId('fine-state').querySelector('svg')).toBeNull()
  })

  it('shows the whole sentence in the shared tooltip on keyboard focus, and has no title attribute', () => {
    render(<Opener onOpen={vi.fn()} />)
    const card = screen.getByTestId('storage')
    expect(card).not.toHaveAttribute('title')
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(card)
    expect(screen.getByRole('tooltip')).toHaveTextContent(TIP)
    fireEvent.blur(card)
    expect(screen.queryByRole('tooltip')).toBeNull()

    const runs = screen.getByTestId('runs')
    expect(runs).not.toHaveAttribute('title')
    fireEvent.focus(runs)
    expect(screen.getByRole('tooltip')).toHaveTextContent('The last backup failed, and none has succeeded since.')
  })

  it('draws a badge after the title, on the card\'s own ground rather than its tint', () => {
    render(<SummaryCard title="Historian" testId="h" value="2h ago" state="Failed 1h ago" tone="danger" tip="t"
      badge={<span className="badge badge-warning">Requested: not picked up</span>} onOpen={() => {}} />)
    const badge = screen.getByText('Requested: not picked up')
    expect(badge.parentElement).toHaveClass('summary-card-badge')
    expect(badge.closest('.summary-card-head').firstElementChild).toHaveTextContent('Historian')
    expect(APP_CSS).toMatch(/\n\.summary-card-badge \{[^}]*background:\s*var\(--bg-card\)/)
  })

  it('marks a flagged detail line as a warning of its own, with an icon', () => {
    render(<SummaryCard title="Backup runs" testId="c" value="2h ago" detail="29 of 30 succeeded" flagged state="Up to date" tip="One failed." />)
    const detail = screen.getByText('29 of 30 succeeded')
    expect(detail).toHaveClass('summary-card-flagged')
    expect(detail.querySelector('svg')).not.toBeNull()
  })

  it('draws the same lines in every state, each one line high and cut short, so the row never jumps', () => {
    const lines = (props) => {
      const { unmount } = render(<SummaryCard title="Historian" testId="h" value="2h ago" detail="Next 02:00" tip="t" {...props} />)
      const card = screen.getByTestId('h')
      const shape = [...card.children].map(c => c.className)
      unmount()
      return shape
    }
    const fine = lines({ state: 'Up to date' })
    expect(lines({ state: `Failed 1h ago: ${'x'.repeat(300)}`, tone: 'danger' })).toEqual(fine)
    expect(fine).toEqual(['summary-card-head', 'summary-card-value', 'summary-card-detail', 'summary-card-state'])

    // In App.css: each line keeps to one line and ends in an ellipsis.
    const rule = APP_CSS.match(/\n\.summary-card-value,\n\.summary-card-detail,\n\.summary-card-state \{([^}]*)\}/)
    expect(rule, 'the one-line rule for the card lines').not.toBeNull()
    expect(rule[1]).toMatch(/white-space:\s*nowrap/)
    expect(rule[1]).toMatch(/text-overflow:\s*ellipsis/)
    expect(rule[1]).toMatch(/overflow:\s*hidden/)
    expect(APP_CSS).toMatch(/\n\.summary-card-head \{[^}]*height:\s*16px/)
  })

  it('lays the row out four across, two by two below 1100px and one column on a phone', () => {
    expect(APP_CSS).toMatch(/\n\.summary-cards \{[^}]*grid-auto-flow:\s*column;[^}]*grid-auto-columns:\s*minmax\(0, 1fr\)/)
    expect(APP_CSS).toMatch(/@media \(max-width: 1099px\) \{\s*\.summary-cards \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/)
    expect(APP_CSS).toMatch(/@media \(max-width: 600px\) \{\s*\.summary-cards \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/)
  })
})

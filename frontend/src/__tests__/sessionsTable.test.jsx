/**
 * The table of sessions the Profile page's Security tab and a person's drawer on People share
 * (components/common/SessionsTable.jsx): Where, Started, Last active and End, the session in use
 * marked and without End, a service marked as one, and the column tips worded for whose they are.
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionsTable } from '../components/common/SessionsTable'

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0'

const THIS = { id: 's-this', service_name: null, user_agent: CHROME, created_at: '2026-10-22T09:00:00Z', last_active_at: '2026-10-25T11:00:00Z', is_current: true }
const FIREFOX_SESSION = { id: 's-firefox', service_name: null, user_agent: FIREFOX, created_at: '2026-10-20T09:00:00Z', last_active_at: '2026-10-23T12:00:00Z', is_current: false }
const GRAFANA = { id: 's-grafana', service_name: 'Aber Grafana', user_agent: 'Node-oauth', created_at: '2026-10-24T12:00:00Z', last_active_at: '2026-10-25T11:55:00Z' }

afterEach(cleanup)

const rows = () => screen.getAllByRole('row').slice(1)
const where = (r) => r.querySelector('.session-where').textContent
const tips = () => [...document.querySelectorAll('th .column-hint')].map(h => h.closest('th').textContent)

describe('SessionsTable', () => {
  it('draws Where, Started, Last active and Actions, one row a session, in the order given', () => {
    render(<SessionsTable sessions={[THIS, GRAFANA, FIREFOX_SESSION]} onEnd={vi.fn()} />)
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Where', 'Started', 'Last active', 'Actions'])
    expect(tips()).toEqual(['Where', 'Started', 'Last active'])
    expect(rows().map(where)).toEqual(['Chrome on Windows', 'Grafana', 'Firefox on Linux'])
    expect(rows().map(r => r.dataset.session)).toEqual(['s-this', 's-grafana', 's-firefox'])
  })

  it('marks the session in use and gives it no End, and marks a service', () => {
    render(<SessionsTable sessions={[THIS, GRAFANA, FIREFOX_SESSION]} onEnd={vi.fn()} />)
    const [mine, grafana, firefox] = rows()
    expect(within(mine).getByText('This browser')).toBeInTheDocument()
    expect(within(mine).queryByRole('button')).toBeNull()
    expect(within(grafana).getByText('Service')).toBeInTheDocument()
    expect(within(firefox).queryByText('Service')).toBeNull()
  })

  it('offers End on every row of a list with no session in use, as a person\'s drawer has', () => {
    const firefox = Object.fromEntries(Object.entries(FIREFOX_SESSION).filter(([key]) => key !== 'is_current'))
    render(<SessionsTable sessions={[GRAFANA, firefox]} onEnd={vi.fn()} theirs />)
    expect(screen.queryByText('This browser')).toBeNull()
    expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label')))
      .toEqual(['End the session: Grafana', 'End the session: Firefox on Linux'])
  })

  it('hands End the session, and does nothing more itself', () => {
    const onEnd = vi.fn()
    render(<SessionsTable sessions={[THIS, FIREFOX_SESSION]} onEnd={onEnd} />)
    fireEvent.click(screen.getByRole('button', { name: 'End the session: Firefox on Linux' }))
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledWith(FIREFOX_SESSION)
  })

  it('words the column tips for your own sessions, or for theirs', () => {
    const describedBy = () => [...document.querySelectorAll('th .column-hint')].slice(0, 2)
    const { unmount } = render(<SessionsTable sessions={[FIREFOX_SESSION]} onEnd={vi.fn()} />)
    const [whereMine, startedMine] = describedBy()
    expect(whereMine).toHaveAccessibleDescription('The browser and system you signed in from, or the service that signed you in.')
    expect(startedMine).toHaveAccessibleDescription('When you signed in.')
    unmount()

    render(<SessionsTable sessions={[FIREFOX_SESSION]} onEnd={vi.fn()} theirs />)
    const [whereTheirs, startedTheirs] = describedBy()
    expect(whereTheirs).toHaveAccessibleDescription('The browser and system they signed in from, or the service that signed them in.')
    expect(startedTheirs).toHaveAccessibleDescription('When they signed in.')
  })

  it('adds a class to its scrolling wrapper, and keeps the wrapper the table\'s parent', () => {
    render(<SessionsTable sessions={[FIREFOX_SESSION]} onEnd={vi.fn()} className="person-sessions-table" />)
    const wrap = screen.getByRole('table').parentElement
    expect(wrap).toHaveClass('table-wrap', 'person-sessions-table')
  })
})

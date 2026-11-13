import React from 'react'
import { render, renderHook, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tooltipOf } from '../test/tooltips'

/**
 * Who acknowledged an alert, and who scheduled a suppression window, is shown by display name with
 * the email as its tooltip (0290), or by email alone when there is no name, or "someone" when there
 * is neither. One helper draws it (PersonName with emailOnHover) and the names are read once for a
 * whole list. Held here: the helper's text, the counter's list, the drawer's banner, the drawer's
 * Suppression windows, and the one read that gives the alerts their names. History's Alerts tab is
 * held in historyAlerts.test.jsx.
 */

let alertRows = []
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 't' } } }) },
    from: () => ({
      select: () => ({
        order: () => Promise.resolve({ data: alertRows, error: null }),
        gt: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }),
      }),
    }),
    channel: () => ({ on() { return this }, subscribe() { return this } }),
    removeChannel: () => {},
  },
}))

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { displayNamesFor: vi.fn(), listSuppressionWindows: vi.fn(), get: vi.fn() },
  }
})
const { api } = await import('../api')
const { AlertPill } = await import('../components/common/AlertPill')
const { ContextPanel } = await import('../components/common/ContextPanel')
const { SuppressionWindows } = await import('../components/common/SuppressionWindows')
const { usePlatformAlerts } = await import('../hooks/usePlatformAlerts')
const { acknowledgerName, occurrenceMatches, withAcknowledgerNames } = await import('../utils/alertHistory')
const { personShown } = await import('../utils/displayName')

const OLWEN = 'a0d17290-0000-4000-8000-0000000290a1'
const MAIR = 'a0d17290-0000-4000-8000-0000000290a2'
const NAMELESS = 'a0d17290-0000-4000-8000-0000000290a3'

const alert = (over = {}) => ({
  id: 'a1', fingerprint: 'fp-1', entity_type: 'device', sparkplug_id: 'dev290000000000400080000',
  alert_name: 'Temperature High', severity: 'warning', summary: 'Press 5 is hot', starts_at: '2026-11-12T09:00:00Z',
  acknowledged_at: new Date(Date.now() - 5 * 60000).toISOString(), acknowledged_by: OLWEN,
  acknowledged_by_email: 'olwen@aber.local', acknowledgement_reason: 'known_cause', ...over,
})

const pill = () => screen.getByRole('button', { name: /firing alerts?$/i })
const who = (container) => container.querySelector('.person-name')

beforeEach(() => {
  vi.clearAllMocks()
  alertRows = []
  api.displayNamesFor.mockReset().mockResolvedValue(new Map())
  api.listSuppressionWindows.mockReset().mockResolvedValue([])
})

describe('the helper', () => {
  it('shows the name with the email as its tooltip, else the email alone, else the fallback', () => {
    expect(personShown('Olwen Operator', 'olwen@aber.local', 'someone')).toEqual({ text: 'Olwen Operator', title: 'olwen@aber.local' })
    expect(personShown(null, 'olwen@aber.local', 'someone')).toEqual({ text: 'olwen@aber.local', title: null })
    expect(personShown('', '', 'someone')).toEqual({ text: 'someone', title: null })
    expect(personShown('Olwen Operator', null, 'someone')).toEqual({ text: 'Olwen Operator', title: null })
  })

  it('names an acknowledger by name, then email, then someone', () => {
    expect(acknowledgerName(alert({ acknowledged_by_name: 'Olwen Operator' }))).toBe('Olwen Operator')
    expect(acknowledgerName(alert({ acknowledged_by_name: null }))).toBe('olwen@aber.local')
    expect(acknowledgerName(alert({ acknowledged_by_name: null, acknowledged_by_email: null }))).toBe('someone')
    expect(acknowledgerName(null)).toBe('someone')
  })

  it('gives the rows of an acknowledger their name and leaves the others as they were', () => {
    const plain = alert({ id: 'a2', acknowledged_by: null, acknowledged_at: null })
    const rows = withAcknowledgerNames([alert(), plain, alert({ id: 'a3', acknowledged_by: MAIR })], new Map([[OLWEN, 'Olwen Operator']]))
    expect(rows.map(r => r.acknowledged_by_name)).toEqual(['Olwen Operator', undefined, null])
    expect(rows[1]).toBe(plain)
  })

  it('finds an occurrence by the name of who acknowledged it, and by their email', () => {
    const row = alert({ acknowledged_by_name: 'Olwen Operator' })
    expect(occurrenceMatches(row, null, 'olwen op')).toBe(true)
    expect(occurrenceMatches(row, null, 'olwen@aber')).toBe(true)
    expect(occurrenceMatches(row, null, 'mair')).toBe(false)
  })
})

describe('the counter\'s list', () => {
  const open = (a) => {
    render(<AlertPill alerts={[a]} userRole="Operator" userId={MAIR} />)
    fireEvent.click(pill())
    return document.querySelector('.alert-pill-ack-words')
  }

  it('names who acknowledged an alert, with their email as the tooltip', () => {
    const line = open(alert({ acknowledged_by_name: 'Olwen Operator' }))
    expect(line).toHaveTextContent(/^Acknowledged by Olwen Operator \(olwen@aber\.local\), 5m ago · Known cause$/)
    const name = who(line)
    expect(within(name).getByText('Olwen Operator').tagName).toBe('BDI')
    expect(tooltipOf(name)).toBe('olwen@aber.local')
  })

  it('shows the email alone, with no tooltip, when the acknowledger has no display name', () => {
    const line = open(alert({ acknowledged_by_name: null }))
    expect(line).toHaveTextContent('Acknowledged by olwen@aber.local, 5m ago · Known cause')
    expect(tooltipOf(who(line))).toBeNull()
  })

  it('says someone when it has neither', () => {
    const line = open(alert({ acknowledged_by_name: null, acknowledged_by_email: null }))
    expect(line).toHaveTextContent('Acknowledged by someone, 5m ago · Known cause')
  })
})

describe('the drawer\'s banner', () => {
  const banner = (a) => {
    render(<ContextPanel open title="Press_05" type="DEVICE" alert={a} onClose={() => {}} />)
    return document.querySelector('.context-alert-state')
  }

  it('names who acknowledged the alert, with their email as the tooltip', () => {
    const line = banner(alert({ acknowledged_by_name: 'Olwen Operator' }))
    expect(line).toHaveTextContent(/Acknowledged by Olwen Operator \(olwen@aber\.local\), .* · Known cause/)
    expect(tooltipOf(who(line))).toBe('olwen@aber.local')
  })

  it('shows the email alone when there is no name', () => {
    const line = banner(alert())
    expect(line).toHaveTextContent(/Acknowledged by olwen@aber\.local, .* · Known cause/)
    expect(tooltipOf(who(line))).toBeNull()
  })

  it('says someone when it has neither', () => {
    const line = banner(alert({ acknowledged_by_email: null }))
    expect(line).toHaveTextContent(/Acknowledged by someone, .* · Known cause/)
  })
})

describe('the drawer\'s Suppression windows', () => {
  const HOUR = 3600 * 1000
  const window = (id, createdBy, email, over = {}) => ({
    id, device_id: 'aaaaaaaa-0000-4000-8000-000000000290', gateway_id: null, cell_id: null, reason: `Reason ${id}`,
    starts_at: new Date(Date.now() - HOUR).toISOString(), ends_at: new Date(Date.now() + HOUR).toISOString(),
    created_by: createdBy, created_by_email: email, ...over,
  })
  const show = async (windows) => {
    api.listSuppressionWindows.mockResolvedValue(windows)
    render(<SuppressionWindows kind="device" subjectId="aaaaaaaa-0000-4000-8000-000000000290" subjectName="Press_05" />)
    await screen.findByText(`Reason ${windows[0].id}`)
  }
  const by = () => [...document.querySelectorAll('.suppression-window-meta')].filter(el => /^By /.test(el.textContent))

  it('names who scheduled each window, with their email as the tooltip, from one read for the list', async () => {
    api.displayNamesFor.mockResolvedValue(new Map([[OLWEN, 'Olwen Operator'], [MAIR, 'Mair Manager']]))
    await show([window('one', OLWEN, 'olwen@aber.local'), window('two', MAIR, 'mair@aber.local'), window('three', OLWEN, 'olwen@aber.local')])
    await waitFor(() => expect(by()[0]).toHaveTextContent('By Olwen Operator (olwen@aber.local)'))
    expect(by()[1]).toHaveTextContent('By Mair Manager (mair@aber.local)')
    expect(by()[2]).toHaveTextContent('By Olwen Operator (olwen@aber.local)')
    expect(tooltipOf(who(by()[1]))).toBe('mair@aber.local')
    expect(api.displayNamesFor).toHaveBeenCalledTimes(1)
    expect([...api.displayNamesFor.mock.calls[0][0]].sort()).toEqual([MAIR, OLWEN].sort())
  })

  it('shows the email alone for a person with no name, and someone for a window that names nobody', async () => {
    api.displayNamesFor.mockResolvedValue(new Map([[OLWEN, 'Olwen Operator']]))
    await show([window('one', OLWEN, 'olwen@aber.local'), window('two', NAMELESS, 'nameless@aber.local'),
      window('three', null, null)])
    await waitFor(() => expect(by()[0]).toHaveTextContent('By Olwen Operator'))
    expect(by()[1]).toHaveTextContent('By nameless@aber.local')
    expect(tooltipOf(who(by()[1]))).toBeNull()
    expect(by()[2]).toHaveTextContent('By someone')
  })

  it('shows the email while the names are read, and when the read fails', async () => {
    api.displayNamesFor.mockRejectedValue(new Error('refused'))
    await show([window('one', OLWEN, 'olwen@aber.local')])
    await waitFor(() => expect(api.displayNamesFor).toHaveBeenCalled())
    expect(by()[0]).toHaveTextContent('By olwen@aber.local')
  })
})

describe('the read that gives the alerts their names', () => {
  it('asks once for the acknowledgers of the whole list, and names each of their alerts', async () => {
    alertRows = [
      alert({ id: 'a1', fingerprint: 'fp-1', acknowledged_by: OLWEN }),
      alert({ id: 'a2', fingerprint: 'fp-2', acknowledged_by: MAIR }),
      alert({ id: 'a3', fingerprint: 'fp-3', acknowledged_by: OLWEN }),
      alert({ id: 'a4', fingerprint: 'fp-4', acknowledged_by: null, acknowledged_at: null }),
    ]
    api.displayNamesFor.mockResolvedValue(new Map([[OLWEN, 'Olwen Operator']]))

    const { result } = renderHook(() => usePlatformAlerts(vi.fn()))

    await waitFor(() => expect(result.current.map(a => a.acknowledged_by_name))
      .toEqual(['Olwen Operator', null, 'Olwen Operator', undefined]))
    expect(api.displayNamesFor).toHaveBeenCalledTimes(1)
    expect([...api.displayNamesFor.mock.calls[0][0]].sort()).toEqual([MAIR, OLWEN].sort())
  })

  it('asks for nobody when nothing is acknowledged', async () => {
    alertRows = [alert({ acknowledged_by: null, acknowledged_at: null })]
    const { result } = renderHook(() => usePlatformAlerts(vi.fn()))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(api.displayNamesFor).not.toHaveBeenCalled()
  })
})

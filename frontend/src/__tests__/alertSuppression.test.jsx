import React from 'react'
import { render, screen, fireEvent, within, waitFor, act, renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AlertPill } from '../components/common/AlertPill'
import { ContextPanel } from '../components/common/ContextPanel'
import { alertIndex, alertForDevice, alertState } from '../utils/deviceAlerts'
import {
  countedAlerts, isSuppressed, maySuppress, nextSuppressionChange, windowState, SUPPRESSION_WINDOW_ROLES,
} from '../utils/alertSuppression'
import { formatDateTime } from '../utils/format'
import { tooltipOf } from '../test/tooltips'
import { cellUrl, deviceUrl, gatewayUrl } from '../routes'

/**
 * Suppression windows (0240) in the dashboard. What is pinned: a suppressed alert colours nothing
 * (alertIndex() leaves it out) and is not counted; the counter's list still shows it, last, with
 * the window's end and reason; the counter reads again at a window's start and end, and an alert
 * whose window ends while it fires toasts as if it had just fired; the drawer's banner names no
 * evaluator and says acknowledged and suppressed as the list does; and the drawers' Suppression
 * windows section offers its acts to a Shopfloor Manager and an Administrator alone, each ending
 * with a toast that links to the subject.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      acknowledgeAlert: vi.fn(),
      withdrawAlertAcknowledgement: vi.fn(),
      listSuppressionWindows: vi.fn(),
      scheduleSuppressionWindow: vi.fn(),
      changeSuppressionWindow: vi.fn(),
      endSuppressionWindow: vi.fn(),
    },
  }
})
const { api } = await import('../api')
const { SuppressionWindows } = await import('../components/common/SuppressionWindows')
const { ALERTS_REFRESH_EVENT } = await import('../hooks/usePlatformAlerts')

const DEVICE_ID = 'aaaaaaaa-0000-4000-8000-000000000240'
const CELL_ID = 'cccccccc-0000-4000-8000-000000000240'
const HOUR = 3600 * 1000
const iso = (ms) => new Date(ms).toISOString()

const alert = (over = {}) => ({
  id: 'a1',
  fingerprint: 'fp-offline-press4',
  entity_type: 'device',
  entity_id: DEVICE_ID,
  sparkplug_id: 'devaaaaaaaa000040008240',
  alert_name: 'Device Offline',
  severity: 'critical',
  summary: 'Press 4 has stopped reporting',
  starts_at: '2026-11-05T09:00:00Z',
  acknowledged_at: null,
  suppressed: false,
  suppressing_window_id: null,
  suppression_reason: null,
  suppressed_until: null,
  ...over,
})
const UNTIL = '2026-11-05T12:00:00Z'
const suppressed = (over = {}) => alert({
  id: 'a3', fingerprint: 'fp-temp-press6', alert_name: 'Spindle Overtemperature', sparkplug_id: 'devaaaaaaaa000040008241',
  suppressed: true, suppressing_window_id: 'w1', suppression_reason: 'Belt change on the feeder', suppressed_until: UNTIL,
  ...over,
})
const acknowledged = (over = {}) => alert({
  id: 'a2', fingerprint: 'fp-temp-press5', alert_name: 'Temperature High', sparkplug_id: 'devaaaaaaaa000040008242',
  acknowledged_at: '2026-11-05T09:05:00Z', acknowledged_by: 'u1', acknowledged_by_email: 'op@aber.local',
  acknowledgement_reason: 'known_cause', ...over,
})

describe('a suppressed alert colours nothing and is not counted', () => {
  it('is left out of alertIndex(), so no page colours it', () => {
    const rows = [suppressed({ sparkplug_id: 'dev1' })]
    expect(alertIndex(rows).size).toBe(0)
    expect(alertForDevice(alertIndex(rows), { asset_id: DEVICE_ID, sparkplug_id: 'dev1' })).toBeNull()
  })

  it('is indexed for a drawer\'s banner only when asked, below a firing or an acknowledged alert', () => {
    const quiet = suppressed({ sparkplug_id: 'dev1', severity: 'critical' })
    expect(alertIndex([quiet], 'device', { suppressed: true }).get('dev1')).toBe(quiet)
    const ack = acknowledged({ sparkplug_id: 'dev1', severity: 'info' })
    expect(alertIndex([quiet, ack], 'device', { suppressed: true }).get('dev1')).toBe(ack)
    expect(alertState(quiet)).toBe('suppressed')
  })

  it('leaves the count, which App hands the title and the favicon', () => {
    expect(countedAlerts([alert(), acknowledged(), suppressed(), alert({ id: 'a4' })])).toHaveLength(2)
    expect(countedAlerts()).toEqual([])
    expect(isSuppressed({ suppressed: true })).toBe(true)
  })

  it('leaves the pill\'s number and tone, and the pill says how many are suppressed', () => {
    render(<AlertPill alerts={[alert({ severity: 'warning' }), suppressed({ severity: 'critical' })]} />)
    const pill = screen.getByRole('button', { name: /firing alert/i })
    expect(pill).toHaveTextContent('1')
    expect(pill).toHaveClass('alert-pill-warning')
    expect(pill).toHaveAccessibleName('1 firing alert, 1 suppressed')
    expect(tooltipOf(pill)).toMatch(/1 suppressed alert is still firing/)
  })

  it('leaves the pill healthy when every firing alert is suppressed', () => {
    render(<AlertPill alerts={[suppressed()]} />)
    const pill = screen.getByRole('button', { name: /firing alerts/i })
    expect(pill).toHaveClass('alert-pill-healthy')
    expect(pill).toHaveAccessibleName('No firing alerts, 1 suppressed')
    expect(tooltipOf(pill)).toBe('1 suppressed alert is still firing.')
  })
})

describe('the counter\'s list marks a suppressed alert', () => {
  it('after the firing and the acknowledged ones, with until when and the window\'s reason', () => {
    render(<AlertPill alerts={[suppressed(), acknowledged(), alert()]} />)
    fireEvent.click(screen.getByRole('button', { name: /firing alert/i }))
    const rows = document.querySelectorAll('.alert-pill-item')
    expect([...rows].map(r => r.querySelector('.alert-pill-item-name').textContent))
      .toEqual(['Device Offline', 'Temperature High', 'Spindle Overtemperature'])
    expect(rows[2]).toHaveClass('alert-pill-item-suppressed')
    expect(rows[2].querySelector('.alert-pill-dot')).toHaveClass('alert-pill-dot-suppressed')
    expect(rows[2]).toHaveTextContent(`Suppressed until ${formatDateTime(UNTIL)}`)
    expect(rows[2].querySelector('.alert-pill-ack-note')).toHaveTextContent('Belt change on the feeder')
    // A shape and words as well as the muted colour.
    expect(rows[2].querySelector('.alert-pill-suppression-mark')).toBeTruthy()
    expect(rows[0]).not.toHaveTextContent('Suppressed')
  })
})

describe('when a window starts or ends', () => {
  it('is the nearest suppressed end or upcoming start, and now for an end already past', () => {
    const now = Date.parse('2026-11-05T10:00:00Z')
    expect(nextSuppressionChange([alert()], [], now)).toBeNull()
    expect(nextSuppressionChange([suppressed()], ['2026-11-05T11:00:00Z'], now)).toBe(Date.parse('2026-11-05T11:00:00Z'))
    expect(nextSuppressionChange([suppressed()], ['2026-11-05T09:00:00Z'], now)).toBe(Date.parse(UNTIL))
    expect(nextSuppressionChange([suppressed({ suppressed_until: '2026-11-05T09:59:00Z' })], [], now)).toBe(now)
  })

  it('says whether a window is upcoming, current or ended, its end excluded', () => {
    const w = { starts_at: '2026-11-05T10:00:00Z', ends_at: '2026-11-05T11:00:00Z' }
    expect(windowState(w, Date.parse('2026-11-05T09:59:59Z'))).toBe('upcoming')
    expect(windowState(w, Date.parse('2026-11-05T10:00:00Z'))).toBe('current')
    expect(windowState(w, Date.parse('2026-11-05T11:00:00Z'))).toBe('ended')
  })
})

describe('the counter reads again at a window\'s end', () => {
  let current
  let starts
  let reads

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'))
    reads = 0
    starts = []
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function mount(rows) {
    current = rows
    const { supabase } = await import('../lib/supabaseClient')
    vi.spyOn(supabase.auth, 'getSession').mockResolvedValue({ data: { session: {} } })
    vi.spyOn(supabase, 'from').mockImplementation((table) => {
      if (table === 'alert_suppression_windows') {
        const chain = { select: () => chain, gt: () => chain, order: () => chain, limit: () => Promise.resolve({ data: starts.map(s => ({ starts_at: s })), error: null }) }
        return chain
      }
      reads += 1
      return { select: () => ({ order: () => Promise.resolve({ data: current, error: null }) }) }
    })
    vi.spyOn(supabase, 'channel').mockReturnValue({ on() { return this }, subscribe() { return this } })
    vi.spyOn(supabase, 'removeChannel').mockImplementation(() => {})
    const { usePlatformAlerts } = await import('../hooks/usePlatformAlerts')
    const showToast = vi.fn()
    const hook = renderHook(() => usePlatformAlerts(showToast))
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    return { showToast, hook }
  }

  it('without a write, before the reconcile, and toasts the alert as if it had just fired', async () => {
    const quiet = suppressed({ suppressed_until: iso(Date.now() + 5000) })
    const { showToast, hook } = await mount([quiet])
    expect(showToast).not.toHaveBeenCalled()
    const before = reads

    current = [{ ...quiet, suppressed: false, suppressing_window_id: null, suppression_reason: null, suppressed_until: null }]
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(reads).toBe(before)
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(reads).toBe(before + 1)
    expect(showToast).toHaveBeenCalledWith('Spindle Overtemperature', 'error', expect.objectContaining({ group: 'alert' }))
    expect(hook.result.current[0].suppressed).toBe(false)
  })

  it('at a window\'s start, and a suppressed alert toasts neither firing nor resolved', async () => {
    starts = [iso(Date.now() + 8000)]
    const { showToast } = await mount([alert()])
    const before = reads
    current = [alert({ suppressed: true, suppressed_until: iso(Date.now() + HOUR) })]
    await act(async () => { await vi.advanceTimersByTimeAsync(9500) })
    expect(reads).toBe(before + 1)
    current = []
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('at once when a window\'s writer asks', async () => {
    await mount([])
    const before = reads
    window.dispatchEvent(new Event(ALERTS_REFRESH_EVENT))
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(reads).toBe(before + 1)
  })
})

describe('the drawer\'s banner', () => {
  const banner = (a) => {
    render(<ContextPanel open title="Press_04" type="DEVICE" alert={a} onClose={() => {}} />)
    return document.querySelector('.context-alert')
  }
  const foot = (el) => el.querySelector('.context-alert-foot span').textContent

  it('names no evaluator: Alert firing, since when', () => {
    const el = banner(alert())
    expect(foot(el)).toBe(`Alert firing · since ${formatDateTime('2026-11-05T09:00:00Z')}`)
    expect(el).not.toHaveTextContent(/Raised by/)
  })

  it('links Alert history, the Alerts tab filtered to this subject, as blue text', () => {
    const a = alert()
    const el = banner(a)
    const link = within(el).getByRole('link', { name: 'Alert history' })
    expect(link.getAttribute('href')).toBe(`/history/alerts?asset=${a.sparkplug_id}`)
    expect(link).toHaveClass('context-alert-link')
  })

  it('says who acknowledged it and why, as the counter does', () => {
    const el = banner(acknowledged({ acknowledgement_note: 'Coolant pump swapped' }))
    expect(el).toHaveClass('context-alert-acknowledged')
    expect(foot(el)).toMatch(/^Alert acknowledged · since /)
    expect(el).toHaveTextContent(/Acknowledged by op@aber\.local, .* · Known cause/)
    expect(el.querySelector('.context-alert-note')).toHaveTextContent('Coolant pump swapped')
  })

  it('says until when a window keeps it quiet, and why', () => {
    const el = banner(suppressed())
    expect(el).toHaveClass('context-alert-suppressed')
    expect(foot(el)).toMatch(/^Alert suppressed · since /)
    expect(el).toHaveTextContent(`Suppressed until ${formatDateTime(UNTIL)}`)
    expect(el.querySelector('.context-alert-note')).toHaveTextContent('Belt change on the feeder')
  })
})

describe('a drawer\'s Suppression windows section', () => {
  const now = Date.now()
  const current = {
    id: 'w-now', device_id: DEVICE_ID, gateway_id: null, cell_id: null, reason: 'Belt change on the feeder',
    starts_at: iso(now - HOUR), ends_at: iso(now + HOUR), created_by_email: 'manager@aber.local',
  }
  const upcoming = {
    id: 'w-later', device_id: DEVICE_ID, gateway_id: null, cell_id: null, reason: 'Gearbox swap',
    starts_at: iso(now + 24 * HOUR), ends_at: iso(now + 26 * HOUR), created_by_email: 'admin@aber.local',
  }
  const fromCell = {
    id: 'w-cell', device_id: null, gateway_id: null, cell_id: CELL_ID, reason: 'Line shutdown',
    starts_at: iso(now - HOUR), ends_at: iso(now + 3 * HOUR), created_by_email: 'manager@aber.local',
  }
  let showToast

  beforeEach(() => {
    showToast = vi.fn()
    api.listSuppressionWindows.mockReset().mockResolvedValue([current, upcoming, fromCell])
    api.scheduleSuppressionWindow.mockReset().mockResolvedValue({})
    api.changeSuppressionWindow.mockReset().mockResolvedValue({})
    api.endSuppressionWindow.mockReset().mockResolvedValue({})
  })

  const show = async (userRole, props = {}) => {
    render(
      <SuppressionWindows kind="device" subjectId={DEVICE_ID} subjectName="Press_04"
        cell={{ id: CELL_ID, name: 'Line 1' }} userRole={userRole} showToast={showToast} {...props} />
    )
    await screen.findByText('Belt change on the feeder')
    return document.querySelector('.suppression-windows')
  }
  const item = (reason) => screen.getByText(reason).closest('.suppression-window')

  it('lists the current and upcoming windows, with when and who, and its cell\'s marked From cell', async () => {
    const section = await show('Operator')
    expect(api.listSuppressionWindows).toHaveBeenCalledWith('device', DEVICE_ID, { cellId: CELL_ID })
    expect(within(section).getByText('Suppression windows (3)')).toBeTruthy()
    expect(item('Belt change on the feeder')).toHaveTextContent('NOW')
    expect(item('Belt change on the feeder')).toHaveTextContent(`${formatDateTime(current.starts_at)} to ${formatDateTime(current.ends_at)}`)
    expect(item('Belt change on the feeder')).toHaveTextContent('By manager@aber.local')
    expect(item('Gearbox swap')).toHaveTextContent('UPCOMING')
    expect(item('Line shutdown')).toHaveTextContent('From cell Line 1')
  })

  it.each(['Operator', 'Auditor', null])('offers no act to %s', async (role) => {
    const section = await show(role)
    // The label's HelpTip is the one button every role gets: it explains, it does not act.
    const acts = within(section).queryAllByRole('button').filter(b => b.getAttribute('aria-label') !== 'What suppression windows are')
    expect(acts).toEqual([])
  })

  it('explains the section with a HelpTip on its label', async () => {
    const section = await show('Operator')
    const label = section.querySelector('.context-panel-section-label')
    expect(within(label).getByRole('button', { name: 'What suppression windows are' })).toBeTruthy()
  })

  it.each(SUPPRESSION_WINDOW_ROLES)('offers %s Schedule window…, and Change… and End now on each own window', async (role) => {
    expect(maySuppress(role)).toBe(true)
    await show(role)
    expect(screen.getByRole('button', { name: /Schedule window…/ })).toBeTruthy()
    expect(within(item('Belt change on the feeder')).getByRole('button', { name: 'End now' })).toBeTruthy()
    expect(within(item('Gearbox swap')).getByRole('button', { name: 'Cancel window' })).toBeTruthy()
    expect(within(item('Gearbox swap')).getByRole('button', { name: 'Change…' })).toBeTruthy()
    // A cell's window is changed from the cell's drawer.
    expect(within(item('Line shutdown')).queryAllByRole('button')).toEqual([])
  })

  it('says in the dialog why it cannot schedule, once the person has changed a field', async () => {
    await show('Shopfloor_Manager')
    fireEvent.click(screen.getByRole('button', { name: /Schedule window…/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Schedule window' })
    const confirm = within(dialog).getByRole('button', { name: 'Schedule window' })
    // Just opened: off, greyed, and not yet scolding.
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveClass('btn-disabled')
    expect(within(dialog).queryByText(/must be in the future/)).toBeNull()

    const past = new Date(now - HOUR)
    const pad = (n) => String(n).padStart(2, '0')
    const local = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`
    fireEvent.change(within(dialog).getByLabelText('End'), { target: { value: local } })
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Belt change' } })
    expect(within(dialog).getByText(/The end must be in the future/)).toBeTruthy()
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveClass('btn-disabled')
  })

  it('schedules from a dialog whose confirm says Schedule window, and toasts a link to the subject', async () => {
    const refreshed = vi.fn()
    window.addEventListener(ALERTS_REFRESH_EVENT, refreshed)
    await show('Shopfloor_Manager')
    fireEvent.click(screen.getByRole('button', { name: /Schedule window…/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Schedule window' })
    const confirm = within(dialog).getByRole('button', { name: 'Schedule window' })
    expect(confirm).toHaveClass('btn-primary')
    expect(confirm).toBeDisabled()

    const end = new Date(now + 2 * HOUR)
    end.setSeconds(0, 0)
    const pad = (n) => String(n).padStart(2, '0')
    const local = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`
    fireEvent.change(within(dialog).getByLabelText('End'), { target: { value: local } })
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: '  Belt change  ' } })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)

    await waitFor(() => expect(api.scheduleSuppressionWindow).toHaveBeenCalledWith(
      'device', DEVICE_ID, { startsAt: null, endsAt: end.toISOString(), reason: 'Belt change' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Suppression window scheduled: Press_04', 'success', { to: deviceUrl(DEVICE_ID) }))
    expect(refreshed).toHaveBeenCalled()
    window.removeEventListener(ALERTS_REFRESH_EVENT, refreshed)
  })

  it('shows the database\'s refusal in the dialog', async () => {
    api.scheduleSuppressionWindow.mockRejectedValue(new Error('A window must end after it starts, and after now.'))
    await show('Administrator')
    fireEvent.click(screen.getByRole('button', { name: /Schedule window…/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Schedule window' })
    fireEvent.change(within(dialog).getByLabelText('End'), { target: { value: '2099-01-01T10:00' } })
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'x' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule window' }))
    expect(await within(dialog).findByText('A window must end after it starts, and after now.')).toBeTruthy()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('changes a started window\'s end or reason, keeping its start', async () => {
    await show('Shopfloor_Manager')
    fireEvent.click(within(item('Belt change on the feeder')).getByRole('button', { name: 'Change…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Change window' })
    expect(within(dialog).getByLabelText('Start')).toBeDisabled()
    const confirm = within(dialog).getByRole('button', { name: 'Change window' })
    expect(confirm).toHaveClass('btn-primary')
    expect(confirm).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Belt and roller change' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(api.changeSuppressionWindow).toHaveBeenCalledWith(
      'w-now', { startsAt: null, endsAt: null, reason: 'Belt and roller change' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Suppression window changed: Press_04', 'success', { to: deviceUrl(DEVICE_ID) }))
  })

  it('ends a current window now, after asking', async () => {
    await show('Administrator')
    fireEvent.click(within(item('Belt change on the feeder')).getByRole('button', { name: 'End now' }))
    const dialog = await screen.findByRole('dialog', { name: 'End window' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'End now' }))
    await waitFor(() => expect(api.endSuppressionWindow).toHaveBeenCalledWith('w-now'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Suppression window ended: Press_04', 'success', { to: deviceUrl(DEVICE_ID) }))
  })

  it('cancels an upcoming window, after asking', async () => {
    await show('Shopfloor_Manager')
    fireEvent.click(within(item('Gearbox swap')).getByRole('button', { name: 'Cancel window' }))
    const dialog = await screen.findByRole('dialog', { name: 'Cancel window' })
    expect(within(dialog).getByRole('button', { name: 'Keep window' })).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel window' }))
    await waitFor(() => expect(api.endSuppressionWindow).toHaveBeenCalledWith('w-later'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      'Suppression window cancelled: Press_04', 'success', { to: deviceUrl(DEVICE_ID) }))
  })

  it.each([
    ['gateway', gatewayUrl('gw-0240')],
    ['cell', cellUrl('gw-0240')],
  ])('on a %s, lists its own windows and links its toasts to it', async (kind, to) => {
    api.listSuppressionWindows.mockResolvedValue([{ ...current, device_id: null, [`${kind}_id`]: 'gw-0240' }])
    render(<SuppressionWindows kind={kind} subjectId="gw-0240" subjectName="Line_A" userRole="Administrator" showToast={showToast} />)
    await screen.findByText('Belt change on the feeder')
    expect(api.listSuppressionWindows).toHaveBeenCalledWith(kind, 'gw-0240', { cellId: null })
    fireEvent.click(screen.getByRole('button', { name: 'End now' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'End window' })).getByRole('button', { name: 'End now' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Suppression window ended: Line_A', 'success', { to }))
  })

  it('says so when nothing is scheduled', async () => {
    api.listSuppressionWindows.mockResolvedValue([])
    render(<SuppressionWindows kind="cell" subjectId={CELL_ID} subjectName="Line 1" userRole="Operator" showToast={showToast} />)
    expect(await screen.findByText('No windows scheduled')).toBeTruthy()
    expect(screen.getByText('Suppression windows (0)')).toBeTruthy()
  })
})

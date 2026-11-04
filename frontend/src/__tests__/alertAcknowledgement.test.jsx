import React from 'react'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AlertPill } from '../components/common/AlertPill'
import { AcknowledgeAlertModal } from '../components/modals/AcknowledgeAlertModal'
import {
  ALERT_ACKNOWLEDGEMENT_REASONS, ALERT_ACKNOWLEDGEMENT_NOTE_MAX, unacknowledgedAlerts, mayAcknowledge, mayWithdraw,
  alertSubjectUrl,
} from '../utils/alertAcknowledgement'
import { tooltipOf } from '../test/tooltips'
import { deviceUrl, gatewayUrl, identityUrl } from '../routes'

/**
 * Acknowledging an alert (0231) from the counter in the top bar. What is pinned: the counter counts
 * only the firing alerts nobody has acknowledged; an acknowledged alert stays listed, after the
 * others, saying who, when and why; Acknowledge asks for a reason from the closed set, and Other
 * for a note; Withdraw is offered to the acknowledger, a Shopfloor Manager and an Administrator;
 * and each act ends with a toast that links to what the alert is about.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { acknowledgeAlert: vi.fn(), withdrawAlertAcknowledgement: vi.fn() },
  }
})
const { api } = await import('../api')

const OPERATOR = 'a0d17231-0000-4000-8000-0000000231a1'
const OTHER = 'a0d17231-0000-4000-8000-0000000231a2'

const alert = (over = {}) => ({
  id: 'a1',
  fingerprint: 'fp-offline-press4',
  entity_type: 'device',
  sparkplug_id: 'dev231000000000400080000',
  alert_name: 'Device Offline',
  severity: 'critical',
  summary: 'Press 4 has stopped reporting',
  starts_at: '2026-11-04T09:00:00Z',
  acknowledged_at: null,
  ...over,
})
const acknowledgedBy = (who, over = {}) => alert({
  id: 'a2', fingerprint: 'fp-temp-press5', alert_name: 'Temperature High', sparkplug_id: 'dev231000000000400080001',
  acknowledged_at: new Date(Date.now() - 5 * 60000).toISOString(), acknowledged_by: who,
  acknowledged_by_email: 'op@aber.local', acknowledgement_reason: 'known_cause',
  acknowledgement_note: 'Coolant pump swapped, settling', ...over,
})

const pill = () => screen.getByRole('button', { name: /firing alerts?$/i })

beforeEach(() => {
  api.acknowledgeAlert.mockReset().mockResolvedValue({})
  api.withdrawAlertAcknowledgement.mockReset().mockResolvedValue({})
})

describe('the counter counts only what nobody has acknowledged', () => {
  it('leaves an acknowledged alert out of the count and the tone', () => {
    render(<AlertPill alerts={[alert({ severity: 'warning' }), acknowledgedBy(OPERATOR)]} />)
    expect(pill()).toHaveTextContent('1')
    // The critical one is acknowledged, so the pill takes the warning treatment.
    expect(pill()).toHaveClass('alert-pill-warning')
    expect(pill()).toHaveAccessibleName('1 unacknowledged firing alert')
    expect(tooltipOf(pill())).toMatch(/1 acknowledged alert is still firing/)
  })

  it('is quiet when every firing alert is acknowledged, and says so', () => {
    render(<AlertPill alerts={[acknowledgedBy(OPERATOR)]} />)
    expect(pill()).toHaveClass('alert-pill-healthy')
    expect(pill()).toHaveTextContent('')
    expect(pill()).toHaveAccessibleName('No unacknowledged firing alerts')
    expect(tooltipOf(pill())).toBe('1 acknowledged alert is still firing.')
  })

  it('is what App hands the title and the favicon', () => {
    expect(unacknowledgedAlerts([alert(), acknowledgedBy(OPERATOR), alert({ id: 'a3' })])).toHaveLength(2)
    expect(unacknowledgedAlerts()).toEqual([])
  })
})

describe('the list behind it', () => {
  it('lists an acknowledged alert after the others, with who, when, why and the note', () => {
    render(<AlertPill alerts={[acknowledgedBy(OPERATOR), alert()]} userRole="Operator" userId={OTHER} />)
    fireEvent.click(pill())
    const rows = document.querySelectorAll('.alert-pill-item')
    expect(rows[0]).toHaveTextContent('Device Offline')
    expect(rows[1]).toHaveClass('alert-pill-item-acknowledged')
    expect(rows[1]).toHaveTextContent('Acknowledged by op@aber.local, 5m ago · Known cause')
    expect(rows[1]).toHaveTextContent('Coolant pump swapped, settling')
    // Told apart by shape as well as words: a hollow dot and a tick.
    expect(rows[1].querySelector('.alert-pill-dot-acknowledged')).toBeTruthy()
    expect(rows[0].querySelector('.alert-pill-dot-acknowledged')).toBeNull()
    expect(rows[1].querySelector('.alert-pill-ack-tick')).toBeTruthy()
  })

  it.each(['Operator', 'Shopfloor_Manager', 'Administrator'])('offers Acknowledge to a %s', (role) => {
    render(<AlertPill alerts={[alert()]} userRole={role} userId={OPERATOR} />)
    fireEvent.click(pill())
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument()
  })

  it.each(['Auditor', null])('offers nothing to %s', (role) => {
    render(<AlertPill alerts={[alert(), acknowledgedBy(OPERATOR)]} userRole={role} userId={OPERATOR} />)
    fireEvent.click(pill())
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull()
  })

  it('offers Withdraw to the acknowledger, a Shopfloor Manager and an Administrator, not another Operator', () => {
    const offered = (role, userId) => {
      const { unmount } = render(<AlertPill alerts={[acknowledgedBy(OPERATOR)]} userRole={role} userId={userId} />)
      fireEvent.click(pill())
      const has = Boolean(screen.queryByRole('button', { name: 'Withdraw' }))
      unmount()
      return has
    }
    expect(offered('Operator', OPERATOR)).toBe(true)
    expect(offered('Operator', OTHER)).toBe(false)
    expect(offered('Shopfloor_Manager', OTHER)).toBe(true)
    expect(offered('Administrator', OTHER)).toBe(true)
    expect(mayWithdraw(alert(), 'Administrator', OTHER)).toBe(false)
    expect(mayAcknowledge('Auditor')).toBe(false)
  })
})

describe('acknowledging', () => {
  const openDialog = (props = {}) => {
    const showToast = vi.fn()
    render(<AlertPill alerts={[alert()]} userRole="Operator" userId={OPERATOR} showToast={showToast} {...props} />)
    fireEvent.click(pill())
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    return { showToast, dialog: screen.getByRole('dialog', { name: 'Acknowledge alert' }) }
  }

  it('asks for a reason before it can be confirmed, and Other for a note', () => {
    const { dialog } = openDialog()
    const confirm = within(dialog).getByRole('button', { name: 'Acknowledge alert' })
    expect(confirm).toHaveClass('btn-primary')
    expect(confirm).toBeDisabled()
    const reason = within(dialog).getByLabelText('Reason')
    expect([...reason.options].map(o => o.value)).toEqual(['', ...ALERT_ACKNOWLEDGEMENT_REASONS.map(r => r.value)])
    fireEvent.change(reason, { target: { value: 'other' } })
    expect(confirm).toBeDisabled()
    expect(within(dialog).getByLabelText('Note')).toHaveAttribute('maxLength', String(ALERT_ACKNOWLEDGEMENT_NOTE_MAX))
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'A loose wire' } })
    expect(confirm).toBeEnabled()
  })

  it('acknowledges, closes the dialog and toasts a link to the device', async () => {
    const { dialog, showToast } = openDialog()
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'planned_work' } })
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: '  belt change  ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge alert' }))
    await waitFor(() => expect(showToast).toHaveBeenCalled())
    expect(api.acknowledgeAlert).toHaveBeenCalledWith('a1', 'planned_work', 'belt change')
    expect(showToast).toHaveBeenCalledWith('Alert acknowledged: Device Offline', 'success',
      { to: deviceUrl('dev231000000000400080000') })
    expect(screen.queryByRole('dialog', { name: 'Acknowledge alert' })).toBeNull()
  })

  it('shows the database\'s refusal in the dialog and toasts nothing', async () => {
    api.acknowledgeAlert.mockRejectedValue(new Error('Already acknowledged by mgr@aber.local at 2026-11-04 09:05 UTC.'))
    const { dialog, showToast } = openDialog()
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'investigating' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge alert' }))
    expect(await within(dialog).findByText(/Already acknowledged by mgr@aber.local/)).toBeInTheDocument()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('starts on the reason, unchosen', () => {
    render(<AcknowledgeAlertModal alert={alert()} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('Reason')).toHaveValue('')
    expect(screen.getByLabelText('Reason')).toHaveFocus()
  })
})

describe('withdrawing', () => {
  it('asks first, then withdraws and toasts a link to the device', async () => {
    const showToast = vi.fn()
    render(<AlertPill alerts={[acknowledgedBy(OPERATOR)]} userRole="Shopfloor_Manager" userId={OTHER} showToast={showToast} />)
    fireEvent.click(pill())
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }))
    const dialog = screen.getByRole('dialog', { name: 'Withdraw acknowledgement' })
    const confirm = within(dialog).getByRole('button', { name: 'Withdraw acknowledgement' })
    expect(confirm).toHaveClass('btn-primary')
    fireEvent.click(confirm)
    await waitFor(() => expect(showToast).toHaveBeenCalled())
    expect(api.withdrawAlertAcknowledgement).toHaveBeenCalledWith('a2')
    expect(showToast).toHaveBeenCalledWith('Acknowledgement withdrawn: Temperature High', 'success',
      { to: deviceUrl('dev231000000000400080001') })
  })
})

describe('where a message about an alert leads', () => {
  it('goes to the device, the gateway, the page alertPage() names, or the rule', () => {
    expect(alertSubjectUrl(alert())).toBe(deviceUrl('dev231000000000400080000'))
    expect(alertSubjectUrl(alert({ entity_type: 'gateway', sparkplug_id: 'gw1' }))).toBe(gatewayUrl('gw1'))
    expect(alertSubjectUrl(alert({ entity_type: 'service_identity', sparkplug_id: null, entity_id: OPERATOR })))
      .toBe(identityUrl(OPERATOR))
    expect(alertSubjectUrl(alert({ entity_type: 'platform', sparkplug_id: null, rule_uid: 'aber-backup-stale' })))
      .toMatch(/\/alerting\/grafana\/aber-backup-stale\/view$/)
  })
})

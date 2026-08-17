import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { AlertPill } from '../components/common/AlertPill'

/**
 * The Topbar's firing-alert pill.
 *
 * What is worth pinning here is not the markup but the three judgements: that a quiet floor renders
 * NOTHING (so the pill's presence is itself the signal), that a critical alert is not averaged away
 * by warnings beside it, and that the count is spelled out rather than carried by colour alone --
 * this sits in a header full of informational chips, and colour is not a signal every operator can
 * rely on.
 */

const alert = (over = {}) => ({
  id: 'a1',
  fingerprint: 'fp-thermal-mill01',
  sparkplug_id: 'dev220000000000400080000',
  alert_name: 'Thermal Excursion',
  severity: 'critical',
  summary: 'Sim_CNC_Mill_01 is above its configured thermal limit of 90.0 degC',
  starts_at: '2026-08-17T09:00:00Z',
  ...over
})

describe('AlertPill', () => {
  it('renders nothing at all when nothing is firing', () => {
    const { container } = render(<AlertPill alerts={[]} />)
    // A permanent "0 alerts" chip is a permanent claim to attention that earns none, and it would
    // make a count of one unremarkable in peripheral vision.
    expect(container).toBeEmptyDOMElement()
  })

  it('defaults to empty rather than throwing when handed nothing', () => {
    const { container } = render(<AlertPill />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the count and the word, not colour alone', () => {
    render(<AlertPill alerts={[alert(), alert({ id: 'a2', fingerprint: 'fp-2' })]} />)
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('Alerts')).toBeInTheDocument()
  })

  it('singularises one alert', () => {
    render(<AlertPill alerts={[alert()]} />)
    expect(screen.getByText('Alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /1 firing alert$/ })).toBeInTheDocument()
  })

  it('takes the critical treatment when any alert is critical', () => {
    // A floor with one critical and four warnings is a floor with a critical on it. Averaging the
    // severities would be a summary nobody asked for.
    render(<AlertPill alerts={[alert({ severity: 'warning' }), alert({ id: 'a2', fingerprint: 'fp-2' })]} />)
    expect(screen.getByRole('button')).toHaveClass('alert-pill-critical')
  })

  it('stays on the warning treatment when nothing is critical', () => {
    render(<AlertPill alerts={[alert({ severity: 'warning' })]} />)
    expect(screen.getByRole('button')).toHaveClass('alert-pill-warning')
  })

  it('counts criticals in the hover text so the number is explained', () => {
    render(<AlertPill alerts={[alert(), alert({ id: 'a2', fingerprint: 'fp-2', severity: 'warning' })]} />)
    expect(screen.getByRole('button')).toHaveAttribute('title', expect.stringContaining('1 critical'))
  })

  it('is collapsed until asked, then lists each alert with its summary and id', () => {
    render(<AlertPill alerts={[alert()]} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /firing alert/ }))

    const panel = screen.getByRole('dialog', { name: /Firing alerts/i })
    expect(panel).toBeInTheDocument()
    expect(screen.getByText('Thermal Excursion')).toBeInTheDocument()
    // Grafana's own templated annotation, shown verbatim -- it already names the device and the
    // values that tripped the rule, so re-assembling it here would be a second version to keep in step.
    expect(screen.getByText(/above its configured thermal limit of 90.0 degC/)).toBeInTheDocument()
    expect(screen.getByText('dev220000000000400080000')).toBeInTheDocument()
  })

  it('says where the evaluation happened, so nobody looks for the threshold here', () => {
    render(<AlertPill alerts={[alert()]} />)
    fireEvent.click(screen.getByRole('button', { name: /firing alert/ }))
    expect(screen.getByText(/Evaluated by Grafana/i)).toBeInTheDocument()
  })

  it('closes again on a second click and on the close control', () => {
    render(<AlertPill alerts={[alert()]} />)
    const pill = screen.getByRole('button', { name: /firing alert/ })

    fireEvent.click(pill)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(pill)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(pill)
    fireEvent.click(screen.getByLabelText('Close alert list'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders an alert with no summary without inventing one', () => {
    render(<AlertPill alerts={[alert({ summary: null })]} />)
    fireEvent.click(screen.getByRole('button', { name: /firing alert/ }))
    expect(screen.getByText('Thermal Excursion')).toBeInTheDocument()
  })

  it('keys the list on fingerprint, so two alerts on one device both render', () => {
    // Same device, two different rules. Keying on device would collapse them into one row and the
    // count in the pill would disagree with the list behind it.
    render(<AlertPill alerts={[
      alert(),
      alert({ id: 'a2', fingerprint: 'fp-estop', alert_name: 'Emergency Stop Engaged' })
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: /firing alerts/ }))
    expect(screen.getByText('Thermal Excursion')).toBeInTheDocument()
    expect(screen.getByText('Emergency Stop Engaged')).toBeInTheDocument()
  })
})

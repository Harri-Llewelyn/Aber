import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AlertPill } from '../components/common/AlertPill'

/**
 * The Topbar's alert counter.
 *
 * What is worth pinning here is not the markup but the judgements:
 *
 *   * IT IS PERMANENT, INCLUDING WHEN HEALTHY. This is a reversal -- it used to render nothing on a
 *     quiet floor -- and the reason is that an element which is absent when healthy is
 *     indistinguishable from one that has BROKEN. A wall display showing no alert chip could mean
 *     nothing is wrong, or that the webhook secret went stale on Tuesday, and the operator cannot
 *     tell which. So the "renders nothing" test below is inverted rather than deleted, with the
 *     reasoning kept, so nobody restores the old behaviour as a tidy-up.
 *   * a critical alert is not averaged away by warnings beside it
 *   * the count is spelled out rather than carried by colour alone
 *   * the HEALTHY state does not pulse, and the firing states do -- because a permanently animated
 *     element in a header is decoration, and the firing states only read as urgent if the resting
 *     state is quiet
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

// Matched on the trailing "firing alert(s)", which is the pill's aria-label in all three states and
// is NOT a substring of "Close alert list" or of a row's "Show <id> on the Devices page". A looser
// /alert/i would find three buttons the moment the panel is open.
const pill = () => screen.getByRole('button', { name: /firing alerts?$/i })

describe('AlertPill', () => {
  describe('the healthy state', () => {
    it('still renders, and says zero rather than saying nothing', () => {
      render(<AlertPill alerts={[]} />)
      const button = screen.getByRole('button', { name: /no firing alerts/i })
      expect(button).toBeInTheDocument()
      expect(screen.getByText('0')).toBeInTheDocument()
      expect(screen.getByText('Alerts')).toBeInTheDocument()
    })

    it('takes the quiet treatment, not the firing one', () => {
      render(<AlertPill alerts={[]} />)
      expect(pill()).toHaveClass('alert-pill-healthy')
      expect(pill()).not.toHaveClass('alert-pill-warning')
      expect(pill()).not.toHaveClass('alert-pill-critical')
    })

    it('defaults to healthy rather than throwing when handed nothing', () => {
      render(<AlertPill />)
      expect(screen.getByRole('button', { name: /no firing alerts/i })).toBeInTheDocument()
    })

    it('answers the panel with a state rather than an empty list', () => {
      render(<AlertPill alerts={[]} />)
      fireEvent.click(pill())
      expect(screen.getByText('No active alerts')).toBeInTheDocument()
      // Not an empty <ul>: this is the view an operator sees ninety-nine times in a hundred, and it
      // has to read as a finished answer rather than as a container that failed to fill.
      expect(document.querySelector('.alert-pill-empty')).toBeTruthy()
      expect(document.querySelector('.alert-pill-list')).toBeNull()
    })
  })

  describe('the firing states', () => {
    it('shows the count and the word, not colour alone', () => {
      render(<AlertPill alerts={[alert(), alert({ id: 'a2', fingerprint: 'fp-2' })]} />)
      expect(screen.getByText('2')).toBeInTheDocument()
      expect(screen.getByText('Alerts')).toBeInTheDocument()
    })

    it('singularises one alert', () => {
      render(<AlertPill alerts={[alert()]} />)
      expect(screen.getByText('Alert')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^1 firing alert$/ })).toBeInTheDocument()
    })

    it('takes the critical treatment when any alert is critical', () => {
      // A floor with one critical and four warnings is a floor with a critical on it. Averaging the
      // severities would be a summary nobody asked for.
      render(<AlertPill alerts={[alert({ severity: 'warning' }), alert({ id: 'a2', fingerprint: 'fp-2' })]} />)
      expect(pill()).toHaveClass('alert-pill-critical')
    })

    it('stays on the warning treatment when nothing is critical', () => {
      render(<AlertPill alerts={[alert({ severity: 'warning' })]} />)
      expect(pill()).toHaveClass('alert-pill-warning')
    })

    it('counts criticals in the hover text so the number is explained', () => {
      render(<AlertPill alerts={[alert(), alert({ id: 'a2', fingerprint: 'fp-2', severity: 'warning' })]} />)
      expect(pill()).toHaveAttribute('title', expect.stringContaining('1 critical'))
    })

    it('draws a different SHAPE per state, so severity does not rest on hue at 13px', () => {
      // Three states, three glyphs: shield / triangle / circle. Colour is the redundant channel
      // here, not the primary one -- this renders at 13px in a header on a shopfloor display.
      const paths = (c) => [...c.querySelectorAll('svg')].map(s => s.innerHTML).join('')
      const healthy = render(<AlertPill alerts={[]} />)
      const warning = render(<AlertPill alerts={[alert({ severity: 'warning' })]} />)
      const critical = render(<AlertPill alerts={[alert()]} />)

      const shapes = [paths(healthy.container), paths(warning.container), paths(critical.container)]
      expect(new Set(shapes).size).toBe(3)
      // The critical glyph is the circle; the warning glyph is not.
      expect(shapes[2]).toContain('circle')
      expect(shapes[1]).not.toContain('circle')
    })
  })

  describe('the list behind it', () => {
    it('is collapsed until asked, then lists each alert with its summary and id', () => {
      render(<AlertPill alerts={[alert()]} />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      fireEvent.click(pill())

      expect(screen.getByRole('dialog', { name: /Firing alerts/i })).toBeInTheDocument()
      expect(screen.getByText('Thermal Excursion')).toBeInTheDocument()
      // Grafana's own templated annotation, shown verbatim -- it already names the device and the
      // values that tripped the rule, so re-assembling it here would be a second version to keep in step.
      expect(screen.getByText(/above its configured thermal limit of 90.0 degC/)).toBeInTheDocument()
      expect(screen.getByText('dev220000000000400080000')).toBeInTheDocument()
    })

    it('says where the evaluation happened, so nobody looks for the threshold here', () => {
      render(<AlertPill alerts={[alert()]} />)
      fireEvent.click(pill())
      expect(screen.getByText(/Evaluated by Grafana/i)).toBeInTheDocument()
    })

    /**
     * The Live/Polling chip's replacement.
     *
     * That chip was removed from the bar because it was read off a BUILD FLAG rather than off the
     * socket -- a permanently lit green dot that could not go out. The fact it carried is still worth
     * having, and it belongs where the count whose freshness it describes is: in this footer.
     */
    it.each([
      [true, /Delivered live, reconciled every 60s/i],
      [false, /Polled every 3s/i]
    ])('states how the count is delivered when realtime=%s', (realtime, expected) => {
      render(<AlertPill alerts={[alert()]} realtime={realtime} />)
      fireEvent.click(pill())
      expect(screen.getByText(expected)).toBeInTheDocument()
    })

    it('closes again on a second click and on the close control', () => {
      render(<AlertPill alerts={[alert()]} />)

      fireEvent.click(pill())
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      fireEvent.click(pill())
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      fireEvent.click(pill())
      fireEvent.click(screen.getByLabelText('Close alert list'))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('renders an alert with no summary without inventing one', () => {
      render(<AlertPill alerts={[alert({ summary: null })]} />)
      fireEvent.click(pill())
      expect(screen.getByText('Thermal Excursion')).toBeInTheDocument()
    })

    it('keys the list on fingerprint, so two alerts on one device both render', () => {
      // Same device, two different rules. Keying on device would collapse them into one row and the
      // count in the pill would disagree with the list behind it.
      render(<AlertPill alerts={[
        alert(),
        alert({ id: 'a2', fingerprint: 'fp-estop', alert_name: 'Emergency Stop Engaged' })
      ]} />)
      fireEvent.click(pill())
      expect(screen.getByText('Thermal Excursion')).toBeInTheDocument()
      expect(screen.getByText('Emergency Stop Engaged')).toBeInTheDocument()
    })

    // Queried by TITLE, not by accessible name: the row's name is computed from its contents (the
    // rule name, Grafana's summary and the id), so "Show <id> on the Devices page" is hover text
    // rather than the label. Asserting the title is also the more useful guard -- it is the only
    // thing telling the operator that a row full of read-only detail is a navigation.
    const row = () => screen.queryByTitle(/on the Devices page$/)

    it('navigates to the device on a row click, and closes on the way', () => {
      const onSelectDevice = vi.fn()
      render(<AlertPill alerts={[alert()]} onSelectDevice={onSelectDevice} />)
      fireEvent.click(pill())

      expect(row()).toHaveAttribute('title', expect.stringContaining('dev220000000000400080000'))
      fireEvent.click(row())
      // The sparkplug id, not a name: device_alerts carries no device name, and the Devices search
      // matches on the id anyway.
      expect(onSelectDevice).toHaveBeenCalledWith('dev220000000000400080000')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('leaves a row inert when there is nowhere for it to go', () => {
      // The webhook records an alert whose sparkplug_id matched no device row rather than dropping
      // it, so this row genuinely occurs. A button that navigated nowhere would be worse than text.
      const onSelectDevice = vi.fn()
      render(<AlertPill alerts={[alert({ sparkplug_id: null })]} onSelectDevice={onSelectDevice} />)
      fireEvent.click(pill())
      expect(row()).toBeNull()
      expect(document.querySelector('.alert-pill-item-link')).toBeNull()
      // The alert itself is still listed -- the row lost its navigation, not its content.
      expect(screen.getByText('Thermal Excursion')).toBeInTheDocument()
    })

    it('does not make rows clickable when no handler was supplied', () => {
      render(<AlertPill alerts={[alert()]} />)
      fireEvent.click(pill())
      expect(row()).toBeNull()
      expect(document.querySelector('.alert-pill-item-link')).toBeNull()
      expect(screen.getByText('Thermal Excursion')).toBeInTheDocument()
    })
  })
})

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AlertPill } from '../components/common/AlertPill'

/**
 * The top bar's alert counter. What is pinned: it is permanent, including when healthy, because an
 * element absent when healthy is indistinguishable from one that is broken; a critical alert is not
 * averaged away by warnings; the count is spelled out rather than carried by colour; the healthy
 * state does not pulse and the firing states do.
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

// Matched on the trailing "firing alert(s)", the pill's aria-label in all three states, which is
// not a substring of "Close alert list" or a row's "Show <id> on the Devices page".
const pill = () => screen.getByRole('button', { name: /firing alerts?$/i })

describe('AlertPill', () => {
  describe('the healthy state', () => {
    /**
     * Still renders when nothing is firing: a wall display with no alert control could mean nothing
     * is wrong or that Grafana has been down since Tuesday.
     */
    it('still renders when nothing is firing, so silence is distinguishable from absence', () => {
      render(<AlertPill alerts={[]} />)
      const button = screen.getByRole('button', { name: /no firing alerts/i })
      expect(button).toBeInTheDocument()
      // The glyph carries it. There is exactly one <svg> in the resting control.
      expect(button.querySelector('svg')).toBeTruthy()
    })

    /** No zero and no word: the healthy glyph already means zero. */
    it('prints no digit and no label when the count is zero', () => {
      render(<AlertPill alerts={[]} />)
      const button = screen.getByRole('button', { name: /no firing alerts/i })
      expect(button).toHaveTextContent('')
      expect(screen.queryByText('0')).toBeNull()
      expect(screen.queryByText(/^Alerts?$/)).toBeNull()
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
    /**
     * The digit comes back exactly when it carries information: one thing wrong and twelve things
     * wrong are different situations, and no hue distinguishes them.
     */
    it('shows the count once there is one, since colour cannot say how many', () => {
      render(<AlertPill alerts={[alert(), alert({ id: 'a2', fingerprint: 'fp-2' })]} />)
      expect(screen.getByText('2')).toBeInTheDocument()
      // The word is gone in every state, not only the healthy one.
      expect(screen.queryByText(/^Alerts?$/)).toBeNull()
    })

    it('still singularises for a screen reader, which has no glyph to read', () => {
      // The visible control lost its word; the accessible name did not, and must not. "1" alone is
      // not a sentence, and this string is the whole of what the button announces.
      render(<AlertPill alerts={[alert()]} />)
      expect(screen.getByText('1')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^1 firing alert$/ })).toBeInTheDocument()
    })

    it('takes the critical treatment when any alert is critical', () => {
      // A site with one critical and four warnings is a site with a critical on it. Averaging the
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

    /** The feed mode lives in this footer, beside the count whose freshness it describes. */
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

    // Queried by title, not accessible name: the row's name is computed from its contents, so "Show
    // <id> on the Devices page" is hover text, and the only thing telling the operator the row
    // navigates.
    const row = () => screen.queryByTitle(/on the Devices page$/)

    it('navigates to the device on a row click, and closes on the way', () => {
      const onSelectDevice = vi.fn()
      render(<AlertPill alerts={[alert()]} onSelectDevice={onSelectDevice} />)
      fireEvent.click(pill())

      expect(row()).toHaveAttribute('title', expect.stringContaining('dev220000000000400080000'))
      fireEvent.click(row())
      // The sparkplug id, not a name: platform_alerts carries no device name, and the Devices search
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

  /**
   * Where a row goes is decided by the alert's declared scope, not the id's prefix: of the rules
   * shipped, four are gateway-scoped and five platform-scoped, and a stale gateway must not send an
   * operator to a Devices search.
   */
  describe('routing by the subject the alert is about', () => {
    const gatewayAlert = (over = {}) => alert({
      fingerprint: 'fp-stale-gwy16',
      entity_type: 'gateway',
      sparkplug_id: 'gwy160000000000400080000',
      alert_name: 'Gateway Stale',
      severity: 'warning',
      summary: 'Playback has not sent a heartbeat for 4509s.',
      ...over
    })

    const platformAlert = (over = {}) => alert({
      fingerprint: 'fp-ingestion-silent',
      entity_type: 'platform',
      sparkplug_id: null,
      alert_name: 'Ingestion Pipeline Silent',
      severity: 'critical',
      summary: 'No telemetry has been written for 10 minutes',
      ...over
    })

    it('sends a gateway alert to the Gateways page, not the Devices page', () => {
      const onSelectDevice = vi.fn()
      const onSelectGateway = vi.fn()
      render(
        <AlertPill
          alerts={[gatewayAlert()]}
          onSelectDevice={onSelectDevice}
          onSelectGateway={onSelectGateway}
        />
      )
      fireEvent.click(pill())

      const link = screen.getByTitle(/on the Gateways page$/)
      fireEvent.click(link)
      expect(onSelectGateway).toHaveBeenCalledWith('gwy160000000000400080000')
      expect(onSelectDevice).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('still sends a device alert to the Devices page', () => {
      const onSelectDevice = vi.fn()
      const onSelectGateway = vi.fn()
      render(
        <AlertPill
          alerts={[alert({ entity_type: 'device' })]}
          onSelectDevice={onSelectDevice}
          onSelectGateway={onSelectGateway}
        />
      )
      fireEvent.click(pill())
      fireEvent.click(screen.getByTitle(/on the Devices page$/))
      expect(onSelectDevice).toHaveBeenCalledWith('dev220000000000400080000')
      expect(onSelectGateway).not.toHaveBeenCalled()
    })

    it('treats a row with no entity_type as a device, the way the webhook does', () => {
      // Rows written before the column existed, and any rule that declares no scope. Reading the
      // absence as "unknown" would make every historical alert inert.
      const onSelectDevice = vi.fn()
      render(<AlertPill alerts={[alert()]} onSelectDevice={onSelectDevice} />)
      fireEvent.click(pill())
      fireEvent.click(screen.getByTitle(/on the Devices page$/))
      expect(onSelectDevice).toHaveBeenCalledWith('dev220000000000400080000')
    })

    it('leaves a gateway row inert rather than wrong when only the device handler exists', () => {
      // A consumer with one page and not the other degrades to plain text. The alternative -- fall
      // back to onSelectDevice -- is the bug this whole describe block exists to close.
      const onSelectDevice = vi.fn()
      render(<AlertPill alerts={[gatewayAlert()]} onSelectDevice={onSelectDevice} />)
      fireEvent.click(pill())
      expect(document.querySelector('.alert-pill-item-link')).toBeNull()
      expect(screen.getByText('Gateway Stale')).toBeInTheDocument()
      expect(onSelectDevice).not.toHaveBeenCalled()
    })

    it('opens a platform alert in Grafana, because no page here is about the platform', () => {
      const onSelectDevice = vi.fn()
      const onSelectGateway = vi.fn()
      render(
        <AlertPill
          alerts={[platformAlert()]}
          onSelectDevice={onSelectDevice}
          onSelectGateway={onSelectGateway}
        />
      )
      fireEvent.click(pill())

      const link = document.querySelector('a.alert-pill-item-link')
      // A real anchor with target=_blank, as in ContextPanel, so middle-click and copy link address
      // work.
      expect(link).toBeTruthy()
      expect(link.getAttribute('href')).toContain('/alerting/list?search=')
      expect(link.getAttribute('href')).toContain(encodeURIComponent('Ingestion Pipeline Silent'))
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      expect(onSelectDevice).not.toHaveBeenCalled()
      expect(onSelectGateway).not.toHaveBeenCalled()
    })

    it('says what a fleet-wide alert is about instead of showing an empty id line', () => {
      render(<AlertPill alerts={[platformAlert()]} />)
      fireEvent.click(pill())
      // An empty mono line reads as a lookup that failed. This one has no asset BY CONSTRUCTION --
      // `platform_alerts_asset_has_wire_id` (0023) requires sparkplug_id to be null here.
      expect(screen.getByText('Platform-wide')).toBeInTheDocument()
    })
  })

  /** Dismissal. The panel is a popover in a header, not a dialog: no backdrop, no focus trap. */
  describe('closing', () => {
    it('closes when a pointer goes down outside it', () => {
      render(
        <div>
          <button>Somewhere else</button>
          <AlertPill alerts={[alert()]} />
        </div>
      )
      fireEvent.click(pill())
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      fireEvent.mouseDown(screen.getByRole('button', { name: 'Somewhere else' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('stays open when the pointer goes down inside the panel', () => {
      // Selecting the text of a summary must not dismiss the thing being read -- which is also why
      // the hook judges the gesture on mousedown, where it STARTED, rather than on click.
      render(<AlertPill alerts={[alert()]} />)
      fireEvent.click(pill())
      fireEvent.mouseDown(screen.getByText('Thermal Excursion'))
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('lets the pill itself still toggle, rather than closing and reopening on one click', () => {
      // The ref is on the WRAPPER, so the button that opens the panel counts as inside it.
      render(<AlertPill alerts={[alert()]} />)
      fireEvent.click(pill())
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      fireEvent.mouseDown(pill())
      fireEvent.click(pill())
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('binds nothing while it is closed', () => {
      // A listener on every click in the application, for a panel nobody has opened, is the cost
      // this guards against.
      const add = vi.spyOn(document, 'addEventListener')
      render(<AlertPill alerts={[alert()]} />)
      expect(add.mock.calls.some(([type]) => type === 'mousedown')).toBe(false)
      add.mockRestore()
    })
  })
})

import React from 'react'
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DirectoryTab, isBrowsableEndpoint } from '../components/tabs/DirectoryTab'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn()
  }
}))

const HEARTBEAT = '2026-07-25T10:00:00Z'
const svc = (name, type, url) => ({
  service_uuid: `svc-${name}`,
  service_name: name,
  service_type: type,
  endpoint_url: url,
  status: 'ACTIVE',
  last_heartbeat: HEARTBEAT
})

// The seeded stack, in the order /api/v1/directory actually returns it -- alphabetical by name,
// which is the order the page has to REGROUP rather than the order it renders. Kept whole rather
// than trimmed to two rows because the interleaving is the thing under test: Kong, Mosquitto and
// PostgREST land alphabetically adjacent and belong to three different sections.
const SERVICES = [
  svc('API Reference (Swagger UI)', 'DOCUMENTATION', 'http://localhost:8088'),
  svc('Grafana Dashboards', 'MONITORING', 'http://localhost:3002'),
  svc('Mosquitto MQTT Broker', 'MQTT_BROKER', 'mqtt://localhost:1883'),
  svc('Node-RED (Virtual Edge Gateway Simulator)', 'EDGE_NODE', 'http://localhost:1880'),
  svc('Sparkplug B Ingestion Engine', 'INGESTION', 'mqtt://mosquitto:1883/spBv1.0/#'),
  svc('Supabase API Gateway (Kong)', 'API_GATEWAY', 'http://127.0.0.1:54321'),
  svc('Supabase Auth (GoTrue)', 'AUTHENTICATION', 'http://127.0.0.1:54321/auth/v1'),
  svc('Supabase Edge Functions', 'SERVERLESS', 'http://127.0.0.1:54321/functions/v1'),
  svc('Supabase PostgREST API', 'REST_API', 'http://127.0.0.1:54321/rest/v1'),
  svc('Supabase PostgreSQL', 'DATABASE', 'postgres://localhost:54322'),
  svc('Supabase Studio', 'GRAPHICAL_UI', 'http://127.0.0.1:54323'),
  svc('TimescaleDB Telemetry Store', 'TIME_SERIES_DB', 'postgres://localhost:5433')
]

async function renderTab() {
  const showToast = vi.fn()
  render(<DirectoryTab showToast={showToast} />)
  // The table renders a tick after the first poll resolves; every test below reads it.
  await waitFor(() => expect(document.querySelector('tbody tr')).toBeTruthy())
  return { showToast }
}

/**
 * THE PANEL THIS SUITE USED TO GUARD IS GONE, and these are the assertions that outlived it.
 *
 * The Directory page carried an "Edge GitOps Deployment Manager" whose button posted to
 * `/api/v1/gitops/deploy-flow`, which invoked the `deploy-nodered` edge function, which
 * overwrote the running flows with `node_red_flow.json` as committed. The demonstrator
 * retirement removed the flow AND the function, so what was left was a button that could only
 * ever report a failure -- and five tests here that would have kept passing against it, because
 * they mocked the edge function they were meant to be reaching.
 *
 * WHAT IS KEPT rather than deleted with it: the page must still make no claim about what
 * Node-RED is running. That was never a property of the button -- it is a property of the page,
 * which has no way to observe the editor, and it is the assertion most likely to be undone by
 * somebody adding a status badge back.
 */
describe('DirectoryTab claims nothing it cannot observe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(SERVICES)
  })

  // The card used to render a hardcoded SYNCED / a8f3e4b status. Nothing in the
  // stack can observe what Node-RED is running, so any such claim is fabricated.
  it('claims no deployment status', async () => {
    await renderTab()

    expect(screen.queryByText(/SYNCED/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/a8f3e4b/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Commit:/i)).not.toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('/gitops/status'))
  })

  // The retirement, asserted from the page rather than from the source: no control offers a
  // deploy, and nothing posts to the route the removed edge function served.
  it('offers no edge-flow deployment', async () => {
    await renderTab()

    expect(screen.queryByRole('button', { name: /Sync Edge Flows via GitOps/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/Edge GitOps Deployment Manager/i)).not.toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
})

/**
 * Categorised groups, replacing the flat table and the filter bar that made it usable.
 *
 * The search box and the service-type picker were solving the flat list's problem -- a dozen
 * rows in registry order, with no cue as to which of them matters to the question being asked --
 * and they solved it only for someone who knew what to type. Three named sections solve it for
 * everyone at rest, so the controls came out with the list they were propping up.
 */
describe('DirectoryTab service groups', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(SERVICES)
  })

  const APPS = 'Applications & User Interfaces'
  const INGEST = 'Ingestion & Messaging'
  const DATA = 'Data & Backend Infrastructure'

  const card = (title) => screen.getByRole('heading', { name: new RegExp(title) }).closest('.card')
  const namesIn = (title) =>
    [...card(title).querySelectorAll('tbody tr td:first-child')].map(td => td.textContent)

  it('renders one table per category rather than one list of everything', async () => {
    await renderTab()

    for (const title of [APPS, INGEST, DATA]) {
      expect(card(title)).toBeTruthy()
      expect(card(title).querySelector('table')).toBeTruthy()
    }
    expect(document.querySelectorAll('table')).toHaveLength(3)
  })

  // The point of the change: a service is found by what it IS, not by where the alphabet put it.
  it('files each service under its category', async () => {
    await renderTab()

    expect(namesIn(APPS)).toEqual([
      'Grafana Dashboards',
      'Node-RED (Virtual Edge Gateway Simulator)',
      'Supabase Studio',
      'API Reference (Swagger UI)'
    ])
    expect(namesIn(INGEST)).toEqual([
      'Mosquitto MQTT Broker',
      'Sparkplug B Ingestion Engine',
      'Supabase API Gateway (Kong)'
    ])
    expect(namesIn(DATA)).toEqual([
      'Supabase PostgREST API',
      'Supabase Auth (GoTrue)',
      'Supabase Edge Functions',
      'Supabase PostgreSQL',
      'TimescaleDB Telemetry Store'
    ])
  })

  // Grouping is keyed on service_type, and directory_services is a registry anything can
  // register into. A type nobody anticipated must still reach the page -- a service silently
  // missing from the directory is worse than one under a vague heading.
  it('still lists a service whose type belongs to no category', async () => {
    api.get.mockResolvedValue([...SERVICES, svc('Some Future Broker', 'AMQP_BROKER', 'amqp://localhost:5672')])
    await renderTab()

    expect(namesIn('Other Registered Services')).toEqual(['Some Future Broker'])
  })

  // An empty section is a heading asserting a category exists with nothing in it, which reads as
  // a stack with a missing piece rather than as a stack that never had one.
  it('renders no card for a category nothing registered into', async () => {
    api.get.mockResolvedValue(SERVICES.filter(s => s.service_type === 'MQTT_BROKER'))
    await renderTab()

    expect(screen.queryByRole('heading', { name: new RegExp(APPS) })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Other Registered Services/ })).not.toBeInTheDocument()
    expect(card(INGEST)).toBeTruthy()
  })

  it('counts each category on its own heading', async () => {
    await renderTab()

    expect(screen.getByRole('heading', { name: new RegExp(APPS) }).textContent).toContain('4')
    expect(screen.getByRole('heading', { name: new RegExp(INGEST) }).textContent).toContain('3')
    expect(screen.getByRole('heading', { name: new RegExp(DATA) }).textContent).toContain('5')
  })

  it('opens a browsable endpoint in a new tab, with the opener not reachable from it', async () => {
    await renderTab()

    // The eight http fixtures. The other four are mqtt:// and postgres:// and are copy buttons
    // below -- this used to assert every row was a link, which is what made the broker address
    // a tab that failed to load.
    const links = [...document.querySelectorAll('tbody a')]
    const browsable = SERVICES.filter(s => isBrowsableEndpoint(s.endpoint_url))
    expect(links).toHaveLength(browsable.length)
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank')
      expect(a).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
      expect(a.getAttribute('href')).toBeTruthy()
    }
  })

  /*
   * Endpoints that are not web pages (issue raised in review).
   *
   * WHAT WAS REPORTED: clicking `mqtt://localhost:1883` opened a tab that could not load it, when
   * what a person wants from that row is the address itself. Both affordances are now
   * button-shaped and visually distinct, so which rows can be opened is answerable by looking
   * rather than by clicking and finding out.
   */
  describe('endpoints that a browser cannot open', () => {
    it('renders them as copy buttons rather than links', async () => {
      await renderTab()

      const unopenable = SERVICES.filter(s => !isBrowsableEndpoint(s.endpoint_url))
      expect(unopenable.length).toBeGreaterThan(0)
      for (const s of unopenable) {
        const el = screen.getByText(s.endpoint_url).closest('button, a')
        expect(el.tagName).toBe('BUTTON')
        expect(el).toHaveClass('endpoint-copy')
      }
    })

    it('copies the address and says so', async () => {
      // navigator.clipboard is undefined outside a secure context, which is the case the app's
      // own copyText() has an execCommand fallback for. Stubbed here so the assertion is about
      // THIS component rather than about which path the helper took.
      const writeText = vi.fn().mockResolvedValue(undefined)
      const original = navigator.clipboard
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText }, configurable: true, writable: true
      })
      try {
        const { showToast } = await renderTab()

        fireEvent.click(screen.getByText('mqtt://localhost:1883').closest('button'))

        await waitFor(() => expect(writeText).toHaveBeenCalledWith('mqtt://localhost:1883'))
        await waitFor(() =>
          expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('mqtt://localhost:1883'), 'success'))
      } finally {
        Object.defineProperty(navigator, 'clipboard', {
          value: original, configurable: true, writable: true
        })
      }
    })

    it('treats a container hostname as unopenable even though it is http', async () => {
      /*
       * THE CASE A SCHEME TEST ALONE GETS WRONG, and the reason this predicate looks at the host.
       * `node-exporter` resolves on the compose network and nowhere else, so rendering it as a
       * link would produce a failed tab that reads as the service being down.
       */
      expect(isBrowsableEndpoint('http://node-exporter:9100/metrics')).toBe(false)
      expect(isBrowsableEndpoint('http://supabase-kong:8000')).toBe(false)
    })

    it('treats localhost, an IP and a real domain as openable', async () => {
      expect(isBrowsableEndpoint('http://localhost:3002')).toBe(true)
      expect(isBrowsableEndpoint('http://127.0.0.1:54321/rest/v1')).toBe(true)
      expect(isBrowsableEndpoint('https://grafana.example.com')).toBe(true)
    })

    it('treats a non-http scheme as unopenable whatever its host', async () => {
      expect(isBrowsableEndpoint('mqtt://localhost:1883')).toBe(false)
      expect(isBrowsableEndpoint('postgres://localhost:5433')).toBe(false)
    })

    it('does not throw on an unparseable endpoint', async () => {
      // `directory_services.endpoint_url` is free text that anything may register into.
      expect(isBrowsableEndpoint('not a url')).toBe(false)
      expect(isBrowsableEndpoint('')).toBe(false)
      expect(isBrowsableEndpoint(null)).toBe(false)
    })
  })

  /*
   * THE LIVENESS COLUMN, AND THE DISTINCTION IT HAS TO MAKE.
   *
   * This test was once the inverse of itself: it asserted the page claimed NO liveness, because
   * nothing wrote `directory_services.status` and the pill said ACTIVE on all fifteen rows
   * unconditionally -- it would have said ACTIVE for a service down for a week.
   *
   * `refresh_directory_liveness()` (migration 0054) writes it now, from Prometheus's `up` series.
   * So the column is back, and what these tests protect is no longer "claims nothing" but "claims
   * only what was observed".
   *
   * THE DISTINCTION THAT MATTERS IS NOT HEALTHY-VS-UNHEALTHY, IT IS OBSERVED-VS-UNOBSERVED. Six of
   * the fifteen services are scraped; nine are not, and a service can be perfectly fine while
   * unobserved. A page that rendered the nine as a blank or a dash would let a reader assume they
   * are fine -- the same fabrication as the old green pill, in a quieter font.
   */
  it('shows an observed service as ACTIVE', async () => {
    await renderTab()
    expect(screen.getAllByText('ACTIVE').length).toBeGreaterThan(0)
  })

  it('shows an observed-and-failing service as DOWN', async () => {
    api.get.mockResolvedValue([
      { ...svc('Grafana Dashboards', 'MONITORING', 'http://localhost:3002'),
        status: 'DOWN', last_heartbeat: null }
    ])
    await renderTab()
    expect(screen.getByText('DOWN')).toBeInTheDocument()
  })

  it('says "not observed" rather than leaving a blank', async () => {
    // THE ONE THAT CARRIES THE DESIGN. A dash or an empty cell reads as "no data yet" or as a
    // rendering gap, and either reading lets somebody conclude the service is fine. The honest
    // answer to "is it up?" for these nine is "nobody is looking", and it has to be in words.
    api.get.mockResolvedValue([
      { ...svc('Supabase Studio', 'GRAPHICAL_UI', 'http://127.0.0.1:54323'),
        status: 'UNKNOWN', last_heartbeat: null }
    ])
    await renderTab()

    expect(screen.getByText(/not observed/i)).toBeInTheDocument()
    expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  it('explains WHY an unobserved service cannot be probed', async () => {
    // Otherwise "not observed" reads as a gap somebody should close, and the next person adds a
    // probe against endpoint_url -- which is a browser address, so from inside a container it
    // would answer about the wrong host and report that as service health.
    api.get.mockResolvedValue([
      { ...svc('Supabase Studio', 'GRAPHICAL_UI', 'http://127.0.0.1:54323'),
        status: 'UNKNOWN', last_heartbeat: null }
    ])
    await renderTab()

    expect(screen.getByTitle(/browser address/i)).toBeInTheDocument()
  })

  it('does not show a heartbeat beside a service that is not up', async () => {
    // 0054 clears last_heartbeat for DOWN and UNKNOWN precisely so a timestamp cannot linger
    // beside a red badge and read as "last seen at" -- a different, more reassuring claim than
    // the row is making. The UI must not reintroduce it from a stale cached row either.
    api.get.mockResolvedValue([
      { ...svc('Grafana Dashboards', 'MONITORING', 'http://localhost:3002'),
        status: 'DOWN', last_heartbeat: HEARTBEAT }
    ])
    await renderTab()

    const badge = screen.getByText('DOWN')
    expect(badge.getAttribute('title')).not.toMatch(/\d{2}:\d{2}/)
  })

  it('distinguishes unobserved from failing by more than colour', async () => {
    // Colour alone is not a distinction a colourblind reader can make, and these two mean opposite
    // things about whether anybody should act.
    api.get.mockResolvedValue([
      { ...svc('A', 'MONITORING', 'http://localhost:1'), status: 'DOWN', last_heartbeat: null },
      { ...svc('B', 'MONITORING', 'http://localhost:2'), status: 'UNKNOWN', last_heartbeat: null }
    ])
    await renderTab()

    expect(screen.getByText('DOWN')).toBeInTheDocument()
    expect(screen.getByText(/not observed/i)).toBeInTheDocument()
  })

  it('still lists what is deployed and how to reach it', async () => {
    // What the page honestly IS, asserted so removing the two columns cannot quietly hollow it out.
    await renderTab()

    for (const svc of SERVICES) {
      expect(screen.getByText(svc.service_name)).toBeInTheDocument()
      expect(screen.getByText(svc.endpoint_url)).toBeInTheDocument()
    }
  })

  it('says so when nothing is registered at all', async () => {
    api.get.mockResolvedValue([])
    const showToast = vi.fn()
    render(<DirectoryTab showToast={showToast} />)

    expect(await screen.findByText(/No services are registered/)).toBeInTheDocument()
  })
})

/**
 * What replaced the manual Refresh button.
 *
 * Removing it without a background refresh would have left the page showing whatever the
 * heartbeats were at mount, for as long as the tab stayed open -- which is the one failure this
 * page cannot have, since a stale heartbeat and a dead service look identical here.
 */
describe('DirectoryTab refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.get.mockResolvedValue(SERVICES)
  })

  afterEach(() => { vi.useRealTimers() })

  it('carries no filter bar, no search, no type picker and no Refresh button', async () => {
    await renderTab()

    expect(document.querySelector('.filter-bar')).toBeNull()
    expect(document.querySelector('.page-actions')).toBeNull()
    expect(screen.queryByPlaceholderText(/Search services/)).not.toBeInTheDocument()
    expect(screen.queryByTitle(/Show only one kind of service/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Refresh Directory/i })).not.toBeInTheDocument()
    // NO CONTROLS AT ALL now that the GitOps sync button has gone with the flow it deployed --
    // the page is a read-only directory. The endpoint cells are still buttons, one per row a
    // browser cannot open, so this counts what is not an endpoint rather than every button,
    // which would otherwise re-fail whenever a fixture changed scheme.
    const buttons = screen.getAllByRole('button')
      .filter(b => !b.classList.contains('endpoint-action'))
    expect(buttons).toHaveLength(0)
  })

  // The poll is a setTimeout chain (see usePolling), so a fresh response only reaches the
  // component once the clock is advanced past the interval.
  it('picks up a changed registration on the background poll, with nothing to press', async () => {
    /*
     * THE SUBJECT IS THE POLL, not what changed. This watched `status` flip to OFFLINE until that
     * column was removed for being fabricated; the observable is now the endpoint, which is real
     * data that a re-registration genuinely changes. Rewritten rather than deleted, because the
     * behaviour under test -- the table refreshes itself with no button -- is unaffected.
     */
    await renderTab()
    expect(api.get).toHaveBeenCalledTimes(1)

    const moved = 'mqtt://broker.plant.local:8883'
    api.get.mockResolvedValue(
      SERVICES.map(s => (s.service_type === 'MQTT_BROKER' ? { ...s, endpoint_url: moved } : s))
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })

    expect(api.get.mock.calls.length).toBeGreaterThan(1)
    expect(await screen.findByText(moved)).toBeInTheDocument()
  })
})

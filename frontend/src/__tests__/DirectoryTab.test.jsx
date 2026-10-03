import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  DirectoryTab,
  isBrowsableEndpoint,
  endpointReach,
  viewerIsOnDeploymentHost,
  imageVersion,
  serviceTypeLabel
} from '../components/tabs/DirectoryTab'
import { api } from '../api'
import { expectCardHeading } from '../test/cardHeading'

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
  image: 'registry.example/service:1.0.0',
  status: 'ACTIVE',
  last_heartbeat: HEARTBEAT
})

// The seeded stack in the order /api/v1/directory returns it, alphabetical by name, which the page
// has to regroup. Kept whole because the interleaving is what is under test.
const SERVICES = [
  svc('API Reference (Swagger UI)', 'DOCUMENTATION', 'http://localhost:8088'),
  svc('Grafana Dashboards', 'MONITORING', 'http://localhost:3002'),
  svc('Mosquitto MQTT Broker', 'MQTT_BROKER', 'mqtt://localhost:1883'),
  svc('Node-RED (Host-Run Gateways)', 'EDGE_NODE', 'http://localhost:1880'),
  svc('Sparkplug B Ingestion Engine', 'INGESTION', 'mqtt://mosquitto:1883/spBv1.0/#'),
  svc('Supabase API Gateway (Envoy)', 'API_GATEWAY', 'http://127.0.0.1:54321'),
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

const tab = (title) => screen.getByRole('tab', { name: title })
const openTab = (title) => fireEvent.click(tab(title))

/** Runs `read` on every group's tab in turn, and returns what each call returned, flattened. */
const acrossTabs = (read) =>
  screen.getAllByRole('tab').map(t => t.textContent).flatMap(title => { openTab(title); return read() })

/**
 * The page must make no claim about what Node-RED is running: it has no way to observe the editor,
 * and this is the assertion most likely to be undone by somebody adding a status badge.
 */
describe('DirectoryTab claims nothing it cannot observe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(SERVICES)
  })

  // Nothing in the stack can observe what Node-RED is running, so any such claim is fabricated.
  it('claims no deployment status', async () => {
    await renderTab()

    expect(screen.queryByText(/SYNCED/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/a8f3e4b/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Commit:/i)).not.toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('/gitops/status'))
  })

  // No control offers a deploy, and nothing posts to a deploy route.
  it('offers no edge-flow deployment', async () => {
    await renderTab()

    expect(screen.queryByRole('button', { name: /Sync Edge Flows via GitOps/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/Edge GitOps Deployment Manager/i)).not.toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
})

/** Three named groups, a tab each, in one card. */
describe('DirectoryTab service groups', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(SERVICES)
  })

  const APPS = 'Applications & User Interfaces'
  const INGEST = 'Ingestion & Messaging'
  const DATA = 'Data & Backend Infrastructure'

  const namesIn = (title) => {
    openTab(title)
    return [...document.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent)
  }

  it('puts each group on a tab of one card, showing one table at a time', async () => {
    await renderTab()

    expect(document.querySelectorAll('.card')).toHaveLength(1)
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual([APPS, INGEST, DATA])
    expect(tab(APPS)).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelectorAll('table')).toHaveLength(1)
    // The bar is straight inside the card under its heading, with the table straight under the bar.
    expect(document.querySelector('.card > .card-heading + .tab-strip')).toBeTruthy()
    expect(document.querySelector('.card > .tab-strip + .table-wrap')).toBeTruthy()
  })

  it('opens the group a search-bar card names, then drops the request', async () => {
    const onClearSection = vi.fn()
    render(<DirectoryTab showToast={vi.fn()} initialSection="ingestion" onClearSection={onClearSection} />)
    await waitFor(() => expect(tab(INGEST)).toHaveAttribute('aria-selected', 'true'))
    expect(onClearSection).toHaveBeenCalled()
  })

  // The point of the change: a service is found by what it IS, not by where the alphabet put it.
  it('files each service under its category', async () => {
    await renderTab()

    expect(namesIn(APPS)).toEqual([
      'Grafana Dashboards',
      'Node-RED (Host-Run Gateways)',
      'Supabase Studio',
      'API Reference (Swagger UI)'
    ])
    expect(namesIn(INGEST)).toEqual([
      'Mosquitto MQTT Broker',
      'Sparkplug B Ingestion Engine',
      'Supabase API Gateway (Envoy)'
    ])
    expect(namesIn(DATA)).toEqual([
      'Supabase PostgREST API',
      'Supabase Auth (GoTrue)',
      'Supabase Edge Functions',
      'Supabase PostgreSQL',
      'TimescaleDB Telemetry Store'
    ])
  })

  // Grouping is keyed on service_type, and directory_services is a registry anything can register
  // into, so an unanticipated type must still reach the page.
  it('still lists a service whose type belongs to no category', async () => {
    api.get.mockResolvedValue([...SERVICES, svc('Some Future Broker', 'AMQP_BROKER', 'amqp://localhost:5672')])
    await renderTab()

    expect(namesIn('Other Registered Services')).toEqual(['Some Future Broker'])
  })

  // An empty group is a tab asserting a category exists with nothing in it, which reads as a stack
  // with a missing piece rather than as a stack that never had one.
  it('draws no tab for a group nothing registered into', async () => {
    api.get.mockResolvedValue(SERVICES.filter(s => s.service_type === 'MQTT_BROKER'))
    await renderTab()

    expect(screen.queryByRole('tab', { name: APPS })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Other Registered Services/ })).not.toBeInTheDocument()
    expect(tab(INGEST)).toHaveAttribute('aria-selected', 'true')
  })

  it('explains the selected group with the "?" after the tab names, and counts nothing', async () => {
    await renderTab()

    for (const title of [APPS, INGEST, DATA]) {
      openTab(title)
      const tips = document.querySelectorAll('.tab-strip-help > .help-tip')
      expect(tips).toHaveLength(1)
      expect(tips[0]).toHaveAttribute('aria-label', `About ${title}`)
    }
    expect(document.querySelector('.section-count')).toBeNull()
    for (const t of screen.getAllByRole('tab')) expect(t.textContent).not.toMatch(/\d/)
  })

  it('opens on the first tab, and shows another group on a click', async () => {
    await renderTab()
    expect(tab(APPS)).toHaveAttribute('aria-selected', 'true')
    expect(namesIn(DATA)).toContain('Supabase PostgreSQL')
    expect(tab(DATA)).toHaveAttribute('aria-selected', 'true')
    expect(tab(APPS)).toHaveAttribute('aria-selected', 'false')
  })

  it('is one card with its heading, in a page that does not scroll', async () => {
    await renderTab()
    expect(document.querySelector('.page-layout.page-fill > .page-main > .card.card-fill')).toBeTruthy()
    const header = expectCardHeading('Directory', /^Every service this deployment runs/)
    // One sentence of at most 28 words; the detail is in the help drawer.
    const description = header.querySelector('.card-heading-description').textContent
    expect(description.match(/[.!?](\s|$)/g)).toHaveLength(1)
    expect(description.split(/\s+/).length).toBeLessThanOrEqual(28)
    // The table is the card's scroller: a .table-wrap directly under the .card-fill.
    expect(document.querySelector('.card-fill > .table-wrap > table.table-directory')).toBeTruthy()
  })

  it('says loading and none registered inside a card', async () => {
    api.get.mockReturnValue(new Promise(() => {}))
    const { unmount } = render(<DirectoryTab showToast={vi.fn()} />)
    expect(screen.getByText(/Loading directory/).closest('.card')).toBeTruthy()
    unmount()

    api.get.mockResolvedValue([])
    render(<DirectoryTab showToast={vi.fn()} />)
    const empty = await screen.findByText('No services are registered in the directory.')
    expect(empty.closest('.card')).toBeTruthy()
  })

  it('names no migration in any text an operator reads', async () => {
    await renderTab()
    const text = [...document.querySelectorAll('[title]')].map(e => e.getAttribute('title')).join(' ')
      + document.body.textContent
    expect(text).not.toMatch(/migration/i)
  })

  it('opens a browsable endpoint in a new tab, with the opener not reachable from it', async () => {
    await renderTab()

    // The eight http fixtures. The other four are mqtt:// and postgres:// and render as copy
    // buttons below.
    const links = acrossTabs(() => [...document.querySelectorAll('tbody a')])
    const browsable = SERVICES.filter(s => isBrowsableEndpoint(s.endpoint_url))
    expect(links).toHaveLength(browsable.length)
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank')
      expect(a).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
      expect(a.getAttribute('href')).toBeTruthy()
    }
  })

  /* Endpoints that are not web pages render as copy buttons, visually distinct from links, so which
     rows can be opened is answerable by looking. */
  describe('endpoints that a browser cannot open', () => {
    it('renders them as copy buttons rather than links', async () => {
      await renderTab()

      const unopenable = SERVICES.filter(s => !isBrowsableEndpoint(s.endpoint_url))
      expect(unopenable.length).toBeGreaterThan(0)
      const chips = acrossTabs(() => unopenable
        .map(s => screen.queryByText(s.endpoint_url)?.closest('button, a'))
        .filter(Boolean))
      expect(chips).toHaveLength(unopenable.length)
      for (const el of chips) {
        expect(el.tagName).toBe('BUTTON')
        expect(el).toHaveClass('copyable-id')
      }
    })

    // The copy chip also carries `.mono` (13px), so the shared chip rule has to come after it.
    it('draws the copy chip and the open chip in one typeface and size', () => {
      const css = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
      const shared = css.match(/\n\.copyable-id,\s*\.endpoint-action \{([^}]*)\}/)
      expect(shared[1]).toMatch(/font-family:\s*var\(--font-mono\)/)
      expect(shared[1]).toMatch(/font-size:\s*12px/)
      expect(shared.index).toBeGreaterThan(css.search(/\n\.mono \{/))
    })

    it('copies the address and says so', async () => {
      // navigator.clipboard is stubbed so the assertion is about this component rather than which
      // path copyText() took.
      const writeText = vi.fn().mockResolvedValue(undefined)
      const original = navigator.clipboard
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText }, configurable: true, writable: true
      })
      try {
        const { showToast } = await renderTab()

        openTab('Ingestion & Messaging')
        fireEvent.click(screen.getByText('mqtt://localhost:1883').closest('button'))

        await waitFor(() => expect(writeText).toHaveBeenCalledWith('mqtt://localhost:1883'))
        await waitFor(() =>
          expect(showToast).toHaveBeenCalledWith(
            expect.stringContaining('Copied endpoint address'), 'success'))
      } finally {
        Object.defineProperty(navigator, 'clipboard', {
          value: original, configurable: true, writable: true
        })
      }
    })

    it('treats a container hostname as unopenable even though it is http', async () => {
      /* The case a scheme test alone gets wrong: `node-exporter` resolves on the cluster network
         and nowhere else, so a link would produce a failed tab that reads as the service being
         down. */
      expect(isBrowsableEndpoint('http://node-exporter:9100/metrics')).toBe(false)
      expect(isBrowsableEndpoint('http://supabase-envoy:8000')).toBe(false)
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

  /* The liveness column, written by `refresh_directory_liveness()` from Prometheus's `up` series.
     The distinction that matters is observed versus unobserved, not healthy versus unhealthy: a
     service can be fine while unobserved, and a blank cell would let a reader assume it is. */
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
    // The answer for an unscraped service is "nobody is looking", in words; a dash reads as no data
    // yet.
    api.get.mockResolvedValue([
      { ...svc('Supabase Studio', 'GRAPHICAL_UI', 'http://127.0.0.1:54323'),
        status: 'UNKNOWN', last_heartbeat: null }
    ])
    await renderTab()

    expect(screen.getByText(/not observed/i)).toBeInTheDocument()
    expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  // The column's badges are only observations; "nobody is looking" is dim words, not a pill.
  it('says "not observed" as dim text, not a badge', async () => {
    api.get.mockResolvedValue([
      { ...svc('Supabase Studio', 'GRAPHICAL_UI', 'http://127.0.0.1:54323'),
        status: 'UNKNOWN', last_heartbeat: null }
    ])
    await renderTab()

    const words = screen.getByText('not observed')
    expect(words).toHaveClass('directory-unobserved')
    expect(words.className).not.toMatch(/badge/)
  })

  it('explains WHY an unobserved service cannot be probed', async () => {
    // Otherwise "not observed" reads as a gap somebody should close with a probe against
    // endpoint_url, a browser address that would answer about the wrong host from inside a
    // container.
    api.get.mockResolvedValue([
      { ...svc('Supabase Studio', 'GRAPHICAL_UI', 'http://127.0.0.1:54323'),
        status: 'UNKNOWN', last_heartbeat: null }
    ])
    await renderTab()

    expect(screen.getByTitle(/browser address/i)).toBeInTheDocument()
  })

  it('does not show a heartbeat beside a service that is not up', async () => {
    // last_heartbeat is cleared for DOWN and UNKNOWN so a timestamp cannot linger beside a red
    // badge as "last seen at". The UI must not reintroduce it from a stale row.
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

    expect(screen.getByText('DOWN')).toHaveClass('badge')
    expect(screen.getByText(/not observed/i)).not.toHaveClass('badge')
  })

  it('still lists what is deployed and how to reach it', async () => {
    // What the page honestly IS, asserted so removing the two columns cannot quietly hollow it out.
    await renderTab()

    const shown = acrossTabs(() => SERVICES.filter(s =>
      screen.queryByText(s.service_name) && screen.queryByText(s.endpoint_url)))
    expect(shown.map(s => s.service_name).sort()).toEqual(SERVICES.map(s => s.service_name).sort())
  })

  // A category, not a state: words in plain text, with the registered enum on hover.
  it('names each service type in words, as plain text', async () => {
    await renderTab()

    const node = screen.getByText('Node-RED (Host-Run Gateways)').closest('tr').children[1]
    expect(node).toHaveTextContent(/^Edge node$/)
    expect(node.querySelector('.badge')).toBeNull()
    expect(node).toHaveAttribute('title', 'Registered as EDGE_NODE')
    expect(screen.queryByText('GRAPHICAL_UI')).not.toBeInTheDocument()
  })

  it('says so when nothing is registered at all', async () => {
    api.get.mockResolvedValue([])
    const showToast = vi.fn()
    render(<DirectoryTab showToast={showToast} />)

    expect(await screen.findByText(/No services are registered/)).toBeInTheDocument()
  })
})

/**
 * The background refresh. A stale heartbeat and a dead service look identical here, so the page
 * cannot show what the heartbeats were at mount for as long as the tab stays open.
 */
describe('DirectoryTab refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.get.mockResolvedValue(SERVICES)
  })

  afterEach(() => { vi.useRealTimers() })

  it('carries no search, no type picker and no Refresh button, so it draws no toolbar row', async () => {
    await renderTab()

    expect(document.querySelector('.filter-bar')).toBeNull()
    expect(document.querySelector('.page-actions')).toBeNull()
    expect(screen.queryByPlaceholderText(/Search services/)).not.toBeInTheDocument()
    expect(screen.queryByTitle(/Show only one kind of service/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Refresh Directory/i })).not.toBeInTheDocument()
    // The page is a read-only directory with no controls of its own beyond its tabs. The endpoint
    // cells are still buttons, one per row a browser cannot open, so this counts what is neither.
    const buttons = screen.getAllByRole('button')
      .filter(b => !b.classList.contains('copyable-id') && !b.classList.contains('help-tip'))
    expect(buttons).toHaveLength(0)
  })

  // "Other Registered Services" is the sign of a type nobody anticipated, so it is a tab only while
  // it has rows; selected when it empties, the selection falls back to the first tab and stays.
  it('shows the Other tab only while it has rows, and falls back to the first tab when it empties', async () => {
    const stray = svc('Some Future Broker', 'AMQP_BROKER', 'amqp://localhost:5672')
    api.get.mockResolvedValue([...SERVICES, stray])
    await renderTab()

    openTab('Other Registered Services')
    expect(screen.getByText('Some Future Broker')).toBeInTheDocument()

    api.get.mockResolvedValue(SERVICES)
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: 'Other Registered Services' })).not.toBeInTheDocument())
    expect(tab('Applications & User Interfaces')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Grafana Dashboards')).toBeInTheDocument()

    // Its return does not take the selection back.
    api.get.mockResolvedValue([...SERVICES, stray])
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    await waitFor(() => expect(tab('Other Registered Services')).toBeInTheDocument())
    expect(tab('Applications & User Interfaces')).toHaveAttribute('aria-selected', 'true')
  })

  // The poll is a setTimeout chain (see usePolling), so a fresh response only reaches the
  // component once the clock is advanced past the interval.
  it('picks up a changed registration on the background poll, with nothing to press', async () => {
    /* The subject is the poll, not what changed: the endpoint is real data that a re-registration
       changes. */
    await renderTab()
    expect(api.get).toHaveBeenCalledTimes(1)
    openTab('Ingestion & Messaging')

    const moved = 'mqtt://broker.plant.local:8883'
    api.get.mockResolvedValue(
      SERVICES.map(s => (s.service_type === 'MQTT_BROKER' ? { ...s, endpoint_url: moved } : s))
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })

    expect(api.get.mock.calls.length).toBeGreaterThan(1)
    expect(await screen.findByText(moved)).toBeInTheDocument()
  })
})

describe('DirectoryTab read failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => { vi.useRealTimers() })

  it('shows the error, not the empty message, when the first read fails', async () => {
    api.get.mockRejectedValue(new Error('PostgREST is unreachable'))
    render(<DirectoryTab showToast={vi.fn()} />)

    expect(await screen.findByText(/could not be read: PostgREST is unreachable/)).toBeInTheDocument()
    expect(document.querySelector('.card .callout-danger')).not.toBeNull()
    expect(screen.queryByText(/No services are registered/)).not.toBeInTheDocument()
  })

  it('keeps the last rows and says they may be out of date when a later poll fails, then clears on recovery', async () => {
    api.get.mockResolvedValue(SERVICES)
    await renderTab()
    expect(document.querySelector('.callout')).toBeNull()

    api.get.mockRejectedValue(new Error('gateway timeout'))
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })

    expect(await screen.findByText(/latest read of the directory failed .gateway timeout./)).toBeInTheDocument()
    expect(document.querySelector('.callout-warning')).not.toBeNull()
    expect(document.querySelector('.callout-danger')).toBeNull()
    expect(document.querySelector('tbody tr')).toBeTruthy()

    api.get.mockResolvedValue(SERVICES)
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    await waitFor(() => expect(document.querySelector('.callout')).toBeNull())
    expect(document.querySelector('tbody tr')).toBeTruthy()
  })

  it('still says no services are registered for a successful empty read', async () => {
    api.get.mockResolvedValue([])
    render(<DirectoryTab showToast={vi.fn()} />)
    expect(await screen.findByText(/No services are registered/)).toBeInTheDocument()
    expect(document.querySelector('.callout')).toBeNull()
  })
})

/**
 * Every fixture carries a `localhost` address and jsdom serves tests from `http://localhost:3000`,
 * so `viewerIsOnDeploymentHost` is true for all of them and the exposure column's case has to be
 * asked for explicitly.
 */
describe('Directory reachability', () => {
  describe('viewerIsOnDeploymentHost', () => {
    it('recognises every spelling of this machine, including the bracketed IPv6 form', () => {
      for (const h of ['localhost', '127.0.0.1', '::1', '[::1]']) {
        expect(viewerIsOnDeploymentHost(h)).toBe(true)
      }
    })

    it('treats a real hostname as somewhere else', () => {
      for (const h of ['aber-server.factory.local', '10.4.1.9', 'app.plant.example', '']) {
        expect(viewerIsOnDeploymentHost(h)).toBe(false)
      }
    })
  })

  describe('endpointReach', () => {
    it('offers a link for a NETWORK service on a real hostname, wherever the reader is', () => {
      expect(endpointReach('http://grafana.plant.local:3002', 'NETWORK', false).open).toBe(true)
      expect(endpointReach('http://grafana.plant.local:3002', 'NETWORK', true).open).toBe(true)
    })

    it('withholds the link for a HOST service read from another machine, and names the tunnel', () => {
      const away = endpointReach('http://localhost:9090', 'HOST', false)
      expect(away.open).toBe(false)
      // The PORT is the part an operator has to get right, so the hint carries it rather than
      // describing the shape of an ssh command in the abstract.
      expect(away.note).toContain('ssh -L 9090:localhost:9090')
    })

    it('offers that same HOST service to a reader who is on the host', () => {
      expect(endpointReach('http://localhost:9090', 'HOST', true).open).toBe(true)
    })

    /* The case the two facts disagree on: Studio's port is published on every interface (NETWORK)
       while its URL is still the loopback default, which a remote browser cannot use. */
    it('withholds a loopback ADDRESS from a remote reader even when the PORT is NETWORK', () => {
      expect(endpointReach('http://127.0.0.1:54323', 'NETWORK', false).open).toBe(false)
      expect(endpointReach('http://127.0.0.1:54323', 'NETWORK', true).open).toBe(true)
    })

    it('never offers an INTERNAL service, on the host or off it', () => {
      expect(endpointReach('http://localhost:9100/metrics', 'INTERNAL', true).open).toBe(false)
      expect(endpointReach('http://localhost:9100/metrics', 'INTERNAL', false).open).toBe(false)
    })

    /* UNKNOWN behaves as NETWORK: rows registered before the column existed must not be demoted to
       copy buttons. */
    it('does not demote a row that predates the column', () => {
      expect(endpointReach('http://grafana.plant.local:3002', undefined, false).open).toBe(true)
      expect(endpointReach('http://grafana.plant.local:3002', 'UNKNOWN', false).open).toBe(true)
    })

    it('still refuses a container hostname, and says why rather than calling it "not a web page"', () => {
      const r = endpointReach('http://node-exporter:9100/metrics', 'INTERNAL', true)
      expect(r.open).toBe(false)
      expect(r.note).toMatch(/container network/)
    })

    it('still refuses a non-web scheme, and says THAT rather than talking about networks', () => {
      const r = endpointReach('postgres://localhost:5433', 'HOST', true)
      expect(r.open).toBe(false)
      expect(r.note).toMatch(/Not a web page/)
    })

    it('treats an unparseable address as copyable rather than throwing', () => {
      expect(endpointReach('not a url', 'NETWORK', true).open).toBe(false)
    })
  })

  describe('the Reach column', () => {
    beforeEach(() => {
      api.get.mockResolvedValue([
        { ...svc('Grafana Dashboards', 'MONITORING', 'http://localhost:3002'), exposure: 'NETWORK' },
        { ...svc('Prometheus Metrics Store', 'MONITORING', 'http://localhost:9090'), exposure: 'HOST' },
        { ...svc('Host Metrics Exporter', 'METRICS_EXPORTER', 'http://node-exporter:9100/metrics'), exposure: 'INTERNAL' },
        { ...svc('Something Newly Registered', 'GRAPHICAL_UI', 'http://elsewhere.plant.local') }
      ])
    })

    it('states each exposure in words, and says "not recorded" rather than drawing a dash', async () => {
      await renderTab()
      expect(screen.getByText('network')).toBeInTheDocument()
      expect(screen.getByText('host only')).toBeInTheDocument()
      // The row with no exposure at all says so in words; a dash reads as a rendering gap.
      expect(screen.getByText('not recorded')).toBeInTheDocument()
      // The exporter is infrastructure, on its own tab.
      openTab('Data & Backend Infrastructure')
      expect(screen.getByText('internal')).toBeInTheDocument()
    })

    it('keeps the loopback links clickable for a reader who is on the host', async () => {
      // jsdom serves from localhost, which IS the deployment host. Both rows are openable and
      // this asserts the common development case did not regress.
      await renderTab()
      expect(screen.getByText('http://localhost:3002').closest('a')).toBeTruthy()
      expect(screen.getByText('http://localhost:9090').closest('a')).toBeTruthy()
    })
  })
})

describe('the Version column', () => {
  describe('imageVersion', () => {
    it('reads the tag of a repository:tag reference', () => {
      expect(imageVersion('grafana/grafana:13.2.0')).toBe('13.2.0')
      expect(imageVersion('supabase/studio:2026.07.07-sha-a6a04f2')).toBe('2026.07.07-sha-a6a04f2')
      expect(imageVersion('ghcr.io/harri-llewelyn/aber/ingestion:0.1.0')).toBe('0.1.0')
    })

    it('does not mistake a registry port for a tag', () => {
      expect(imageVersion('registry.internal:5000/aber/ingestion:0.1.0-hotfix.2')).toBe('0.1.0-hotfix.2')
      expect(imageVersion('registry.internal:5000/aber/ingestion')).toBe('latest')
    })

    it('prefers the tag over a digest, and shortens a digest that stands alone', () => {
      const digest = 'sha256:' + 'ab12'.repeat(16)
      expect(imageVersion(`prom/prometheus:v3.14.0@${digest}`)).toBe('v3.14.0')
      expect(imageVersion(`prom/prometheus@${digest}`)).toBe('sha256:ab12ab12ab12')
    })

    it('names what Docker pulls for an untagged reference', () => {
      expect(imageVersion('eclipse-mosquitto')).toBe('latest')
    })

    it('has nothing to show for no reference', () => {
      expect(imageVersion(null)).toBeNull()
      expect(imageVersion(undefined)).toBeNull()
      expect(imageVersion('  ')).toBeNull()
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue([
      { ...svc('Grafana Dashboards', 'MONITORING', 'http://localhost:3002'), image: 'grafana/grafana:13.2.0', exposure: 'NETWORK' },
      { ...svc('Something Newly Registered', 'GRAPHICAL_UI', 'http://elsewhere.plant.local'), image: null, exposure: 'NETWORK' }
    ])
  })

  it('shows the tag, with the full reference in its tooltip', async () => {
    await renderTab()
    const version = screen.getByText('13.2.0')
    expect(version.getAttribute('title')).toMatch(/^grafana\/grafana:13\.2\.0 /)
    // Stated as what the release deploys, not as something observed in the container.
    expect(version.getAttribute('title')).toMatch(/this release deploys/)
  })

  // "v3.14.0" beside "13.2.0" reads as two formats; the tooltip keeps the tag as published.
  it('drops one leading "v", and only from the display', async () => {
    api.get.mockResolvedValue([
      { ...svc('Prometheus Metrics Store', 'MONITORING', 'http://localhost:9090'), image: 'prom/prometheus:v3.14.0' },
      { ...svc('Something Vendored', 'MONITORING', 'http://localhost:9091'), image: 'example/thing:vendor-2' }
    ])
    await renderTab()
    const version = screen.getByText('3.14.0')
    expect(version.getAttribute('title')).toMatch(/^prom\/prometheus:v3\.14\.0 /)
    expect(screen.getByText('vendor-2')).toBeInTheDocument()
  })

  it('says "not recorded" for a service with no image, rather than leaving a blank', async () => {
    await renderTab()
    const missing = screen.getByText('not recorded')
    expect(missing.closest('td').className).toContain('cell-version')
    expect(missing.getAttribute('title')).toMatch(/disabled in this deployment/)
  })

  it('sits between what the service is and where to reach it', async () => {
    await renderTab()
    const headers = [...document.querySelector('table').querySelectorAll('th')].map(th => th.textContent)
    expect(headers).toEqual(['Service Name', 'Service Type', 'Version', 'Endpoint URL', 'Reach', 'Liveness'])
  })
})

describe('serviceTypeLabel', () => {
  it('names every seeded type in words', () => {
    expect(serviceTypeLabel('EDGE_NODE')).toBe('Edge node')
    expect(serviceTypeLabel('GRAPHICAL_UI')).toBe('Graphical UI')
    expect(serviceTypeLabel('REST_API')).toBe('REST API')
    expect(serviceTypeLabel('MQTT_BROKER')).toBe('MQTT broker')
    expect(serviceTypeLabel('TIME_SERIES_DB')).toBe('Time-series database')
    expect(serviceTypeLabel('SOURCE_CONTROL')).toBe('Source control')
    for (const s of SERVICES) expect(serviceTypeLabel(s.service_type)).not.toMatch(/_/)
  })

  // Anything can register into the directory, so an unmapped type still reads as words.
  it('title-cases a type nobody mapped, with underscores as spaces', () => {
    expect(serviceTypeLabel('AMQP_BROKER')).toBe('Amqp Broker')
    expect(serviceTypeLabel('cache')).toBe('Cache')
    expect(serviceTypeLabel('constructor')).toBe('Constructor')
    expect(serviceTypeLabel(null)).toBe('')
  })
})

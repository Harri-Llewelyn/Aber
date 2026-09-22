import React, { useState, useCallback } from 'react'
import { api } from '../../api'
import { POLL_INTERVAL_MS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { describeAuthFailure } from '../../utils/sessionError'
import { IconExternalLink, IconCopy, IconCheck, IconBookOpen } from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import { PageHeading } from '../common/PageHeading'
import { copyText } from '../common/CopyableId'

/**
 * The stack, in the order an operator looks for it: something to open, the path telemetry arrives
 * on, then the stores behind it. Keyed on service_type, not the editable name. The order of `types`
 * within a group is the render order; names break ties.
 */
/**
 * Whether a browser can open this endpoint: an http(s) scheme and a host that is not a single-label
 * container name (`node-exporter`, `supabase-kong`). Erring towards copy: a copyable address costs
 * one paste, an unresolvable link costs a failed tab and a wrong conclusion.
 */
export function isBrowsableEndpoint(url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  // A dot means a domain or an IPv4 literal; a colon-free single label means a container.
  return host.includes('.') || host.includes(':')
}

/** The spellings of "this machine". `[::1]` because that is what location.hostname gives for IPv6. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Whether the browser is running on the deployment host, read from the dashboard's own hostname:
 * every `localhost` row means port N of the machine the stack runs on. A reader who tunnelled only
 * the dashboard is the one case this gets wrong.
 */
export function viewerIsOnDeploymentHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname))
}

/**
 * Whether to offer this endpoint as a link, and what to say when not. `isBrowsableEndpoint` says
 * whether it is a web page; `exposure` says what can reach the port (NETWORK, HOST, INTERNAL,
 * UNKNOWN). The loopback test is separate from HOST exposure because the two can disagree: Studio
 * is NETWORK with a 127.0.0.1 address. UNKNOWN is treated as NETWORK, so adding the column was not
 * a regression for reachable services.
 */
export function endpointReach(url, exposure, viewerOnHost) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return { open: false, note: 'Not a web address -- click to copy it' }
  }

  if (!isBrowsableEndpoint(url)) {
    // Two reasons land here: a non-web scheme, or a web page not addressable from outside the
    // container network.
    const isWeb = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    return {
      open: false,
      note: isWeb
        ? 'Internal to the stack -- this hostname resolves inside the container network only'
        : 'Not a web page -- click to copy this address'
    }
  }

  if (exposure === 'INTERNAL') {
    return { open: false, note: 'No host port -- reachable from inside the container network only' }
  }

  const loopbackAddress = LOOPBACK_HOSTS.has(parsed.hostname)
  if (loopbackAddress || exposure === 'HOST') {
    if (viewerOnHost) return { open: true, note: 'Open this endpoint in a new tab' }
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
    return {
      open: false,
      note: `Reachable from the deployment host only. From here: ssh -L ${port}:localhost:${port} <host>`
    }
  }

  return { open: true, note: 'Open this endpoint in a new tab' }
}

/**
 * The endpoint cell: a link when it can be opened, a copy button when it cannot. Both are
 * button-shaped, so which can be opened is answerable by looking.
 */
function EndpointCell({ url, exposure, viewerOnHost, onNotify }) {
  const [copied, setCopied] = useState(false)
  const reach = endpointReach(url, exposure, viewerOnHost)

  if (reach.open) {
    return (
      <a
        className="endpoint-action endpoint-open mono"
        href={url}
        target="_blank"
        rel="noreferrer"
        title={reach.note}
      >
        {url} <IconExternalLink size={10} />
      </a>
    )
  }

  const copy = async () => {
    const ok = await copyText(url)
    onNotify?.(
      ok ? `Copied ${url}` : 'Could not reach the clipboard -- select the address and copy it.',
      ok ? 'success' : 'error'
    )
    if (!ok) return
    setCopied(true)
    // Reset rather than latch: the button is reusable and a permanently ticked control reads as
    // a state the row is in rather than as something that just happened.
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <button
      type="button"
      className="endpoint-action endpoint-copy mono"
      onClick={copy}
      title={reach.note}
    >
      {url} {copied ? <IconCheck size={10} /> : <IconCopy size={10} />}
    </button>
  )
}

// A description per group: each card is a different kind of thing.
const SERVICE_GROUPS = [
  {
    title: 'Applications & User Interfaces',
    description: 'The things with a front door. These are meant to be opened — a link here is where '
      + 'you go to do something the dashboard does not do itself.',
    // SOURCE_CONTROL is the forge (0094): a place to review a change, which is a front door in
    // exactly this sense and a different kind of thing from a database console.
    types: ['MONITORING', 'EDGE_NODE', 'GRAPHICAL_UI', 'SOURCE_CONTROL', 'DOCUMENTATION']
  },
  {
    title: 'Ingestion & Messaging',
    description: 'The path a reading takes from a machine to the historian. If telemetry has stopped '
      + 'arriving, the fault is almost always one of these.',
    types: ['MQTT_BROKER', 'INGESTION', 'API_GATEWAY']
  },
  {
    title: 'Data & Backend Infrastructure',
    description: 'What everything above is built on. Listed because a registry that named only the '
      + 'parts with a URL would describe the stack as smaller than it is.',
    types: ['REST_API', 'AUTHENTICATION', 'SERVERLESS', 'DATABASE', 'TIME_SERIES_DB', 'METRICS_EXPORTER']
  }
]

/**
 * Where a service whose type is in no group lands. Not dropped: anything can register into
 * `directory_services`, and a running service must not vanish from the page whose job is to list
 * them.
 */
const UNGROUPED_TITLE = 'Other Registered Services'

/** Splits the flat directory into the sections above, dropping any that came back empty. */
function groupServices(services) {
  // service_type -> [group index, position within that group].
  const rank = new Map()
  SERVICE_GROUPS.forEach((g, gi) => g.types.forEach((t, ti) => rank.set(t, [gi, ti])))

  const byName = (a, b) => String(a.service_name || '').localeCompare(String(b.service_name || ''))

  const sections = SERVICE_GROUPS.map(g => ({ title: g.title, description: g.description, rows: [] }))
  const ungrouped = {
    title: UNGROUPED_TITLE,
    description: 'Registered with a type none of the groups above claims. `directory_services` is a '
      + 'registry anything can write into, so a type nobody anticipated lands here rather than '
      + 'being dropped.',
    rows: []
  }

  for (const s of services) {
    const at = rank.get(s.service_type)
    if (at) sections[at[0]].rows.push(s)
    else ungrouped.rows.push(s)
  }

  for (const section of sections) {
    section.rows.sort((a, b) => (rank.get(a.service_type)[1] - rank.get(b.service_type)[1]) || byName(a, b))
  }
  ungrouped.rows.sort(byName)

  return [...sections, ungrouped].filter(s => s.rows.length > 0)
}

/**
 * One group's table. `.table-directory` pins the column widths so the tables line up as one list
 * broken into sections.
 */
/* The status column describes something observed: `refresh_directory_liveness()` writes it every
   minute from Prometheus's `up` series. Services nothing scrapes render as UNKNOWN in words,
   because a blank beside green badges invites the assumption that it is fine. They cannot be probed
   from inside the stack: `endpoint_url` holds browser addresses, which name the wrong host from a
   container. */
/**
 * One service's observed liveness. ACTIVE and DOWN are observations; UNKNOWN means nothing scrapes
 * it, said in words with a tooltip. `last_heartbeat` is shown only beside ACTIVE; it is cleared for
 * the other two so a timestamp cannot read as last seen at.
 */
function LivenessCell({ status, lastHeartbeat }) {
  if (status === 'ACTIVE') {
    return (
      <span className="badge badge-success" title={lastHeartbeat
        ? `Prometheus scraped this successfully at ${new Date(lastHeartbeat).toLocaleTimeString()}`
        : 'Prometheus reports this target as up'}>
        ACTIVE
      </span>
    )
  }
  if (status === 'DOWN') {
    return (
      <span className="badge badge-danger" title="Prometheus scraped this target and it did not answer">
        DOWN
      </span>
    )
  }
  return (
    <span
      className="badge badge-neutral"
      style={{ opacity: 0.75 }}
      title="Nothing in this stack observes this service. Its endpoint_url is a browser address, so a probe from inside a container would be asking about the wrong host — see archived migration 0054."
    >
      not observed
    </span>
  )
}

/**
 * Where this service can be reached from, as a column rather than only an affordance, so why is
 * this one a button has an answer on screen. UNKNOWN gets words. Amber on host only draws the eye
 * to the one value that changes the endpoint cell; the tooltip carries the reason.
 */
function ExposureCell({ exposure }) {
  if (exposure === 'NETWORK') {
    return (
      <span className="badge badge-neutral" title="Published on every interface. Reachable from another machine, subject to the firewall and DNS -- neither of which this stack controls.">
        network
      </span>
    )
  }
  if (exposure === 'HOST') {
    return (
      <span className="badge badge-warning" title="Bound to 127.0.0.1. The deployment host, or an SSH tunnel from anywhere else. The endpoint carries no authentication of its own, which is why the binding is the control.">
        host only
      </span>
    )
  }
  if (exposure === 'INTERNAL') {
    return (
      <span className="badge badge-neutral" style={{ opacity: 0.75 }} title="No host port at all. Reachable from inside the container network by service name, and from nowhere outside it.">
        internal
      </span>
    )
  }
  return (
    <span className="badge badge-neutral" style={{ opacity: 0.75 }} title="Nothing recorded where this service can be reached from. Registered by something that predates the exposure column, or by something that does not set it — see archived migration 0084.">
      not recorded
    </span>
  )
}

function ServiceTable({ rows, onNotify }) {
  // Read once per render rather than per row. `window` is guarded because this module is imported
  // by tests that render without a location.
  const viewerOnHost = viewerIsOnDeploymentHost(
    typeof window === 'undefined' ? '' : window.location?.hostname
  )

  return (
    <div className="table-wrap">
      <table className="table-directory">
        <thead>
          <tr>
            <th title="Service name">Service Name</th>
            <th title="Architecture category">Service Type</th>
            <th title="Endpoints this browser can reach open in a new tab; everything else copies to the clipboard">Endpoint URL</th>
            <th title="Where the service can be reached from, as a property of its port binding. Set by archived migration 0084 and describing the seeded loopback bindings; a deployment that publishes differently updates it">Reach</th>
            <th title="Observed liveness. Written every minute from Prometheus's up series; services nothing scrapes read as not observed">Liveness</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.service_uuid}>
              <td><strong>{s.service_name}</strong></td>
              <td><span className="badge badge-neutral">{s.service_type}</span></td>
              <td className="cell-endpoint">
                <EndpointCell
                  url={s.endpoint_url}
                  exposure={s.exposure}
                  viewerOnHost={viewerOnHost}
                  onNotify={onNotify}
                />
              </td>
              <td>
                <ExposureCell exposure={s.exposure} />
              </td>
              <td>
                <LivenessCell status={s.status} lastHeartbeat={s.last_heartbeat} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DirectoryTab({ showToast }) {
  const [services, setServices] = useState([])
  const [loading, setLoading]   = useState(true)

  const loadAll = useCallback(async (signal) => {
    try {
      setServices(await api.get('/api/v1/directory', { signal }))
      setLoading(false)
    } catch (e) {
      if (e.name !== 'AbortError') setLoading(false)
      // Rethrown so usePolling can back off on a failing backend rather than hammering it.
      throw e
    }
  }, [])

  /**
   * The page's only refresh. POLL_INTERVAL_MS rather than refreshInterval(): `directory_services`
   * is not in the Realtime publication, so a tab with no channel must not slow to the
   * reconciliation interval.
   */
  usePolling(loadAll, POLL_INTERVAL_MS)

  const groups = groupServices(services)

  return (
    <>
      <PageHeading icon={<IconBookOpen size={15} />} title="Directory">
        Every service this deployment runs, grouped by what it is for: where to reach it, whether
        anything in the stack observes it, and whether that address works from anywhere but the
        deployment host. The rows are registered by migration, not added here.
      </PageHeading>

      {/* No search box or type picker: the grouping solves the scanning problem those controls
          existed for. */}
      {loading ? <div className="loading-wrap"><div className="spinner" /> Loading directory…</div> : (
        groups.map(g => (
          <div className="card directory-group" key={g.title}>
            <div className="card-header">
              <h3 className="section-title">
                {g.title}
                {g.description && <HelpTip label={`About ${g.title}`} text={g.description} />}
              </h3>
            </div>
            <ServiceTable rows={g.rows} onNotify={showToast} />
          </div>
        ))
      )}

      {!loading && groups.length === 0 && (
        <div className="empty-state">
          <div className="empty-text">No services are registered in the directory.</div>
        </div>
      )}
    </>
  )
}

import React, { useState, useCallback, useEffect } from 'react'
import { api } from '../../api'
import { POLL_INTERVAL_MS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { IconExternalLink, IconBookOpen, IconAlertTriangle } from '../common/Icons'
import { EmptyState } from '../common/EmptyState'
import { HelpTip } from '../common/HelpTip'
import { LoadingState } from '../common/LoadingState'
import { CardHeading } from '../common/CardHeading'
import { TabStrip } from '../common/TabStrip'
import CopyableId from '../common/CopyableId'
import { formatDateTime } from '../../utils/format'

/**
 * Whether a browser can open this endpoint: an http(s) scheme and a host that is not a single-label
 * container name (`node-exporter`, `supabase-envoy`). Erring towards copy: a copyable address costs
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
 * The endpoint cell: a link chip when it can be opened, a copy chip when it cannot. Both are
 * bordered monospace chips with an icon, so which can be opened is answerable by looking.
 */
function EndpointCell({ url, exposure, viewerOnHost, onNotify }) {
  const reach = endpointReach(url, exposure, viewerOnHost)

  if (reach.open) {
    return (
      <a
        className="endpoint-action endpoint-open"
        href={url}
        target="_blank"
        rel="noreferrer"
        title={reach.note}
      >
        {url} <IconExternalLink size={12} className="copyable-id-icon" />
      </a>
    )
  }

  return (
    <CopyableId
      value={url}
      label="endpoint address"
      title={reach.note}
      onNotify={onNotify}
      className="copyable-id-wrap"
    />
  )
}

/**
 * The stack, one tab per group, in the order an operator looks for it: something to open, the path
 * telemetry arrives on, then the stores behind it. Keyed on service_type, not the editable name.
 * The order of `types` within a group is the row order; names break ties. Each group's description
 * is its tab's "?".
 */
const SERVICE_GROUPS = [
  {
    id: 'applications',
    title: 'Applications & User Interfaces',
    description: 'The things with a front door. These are meant to be opened — a link here is where '
      + 'you go to do something the dashboard does not do itself.',
    // SOURCE_CONTROL is the forge: a place to review a change, which is a front door in exactly
    // this sense and a different kind of thing from a database console.
    types: ['MONITORING', 'EDGE_NODE', 'GRAPHICAL_UI', 'SOURCE_CONTROL', 'DOCUMENTATION']
  },
  {
    id: 'ingestion',
    title: 'Ingestion & Messaging',
    description: 'The path a reading takes from a machine to the historian. If telemetry has stopped '
      + 'arriving, the fault is almost always one of these.',
    types: ['MQTT_BROKER', 'INGESTION', 'API_GATEWAY']
  },
  {
    id: 'infrastructure',
    title: 'Data & Backend Infrastructure',
    description: 'What the services on the other tabs are built on. Listed because a registry that '
      + 'named only the parts with a URL would describe the stack as smaller than it is.',
    types: ['REST_API', 'AUTHENTICATION', 'SERVERLESS', 'DATABASE', 'TIME_SERIES_DB', 'METRICS_EXPORTER']
  }
]

/**
 * Where a service whose type is in no group lands. Not dropped: anything can register into
 * `directory_services`, and a running service must not vanish from the page whose job is to list
 * them.
 */
const UNGROUPED_TITLE = 'Other Registered Services'

/** Splits the flat directory into the groups above, dropping any that came back empty. */
function groupServices(services) {
  // service_type -> [group index, position within that group].
  const rank = new Map()
  SERVICE_GROUPS.forEach((g, gi) => g.types.forEach((t, ti) => rank.set(t, [gi, ti])))

  const byName = (a, b) => String(a.service_name || '').localeCompare(String(b.service_name || ''))

  const sections = SERVICE_GROUPS.map(g => ({ id: g.id, title: g.title, description: g.description, rows: [] }))
  const ungrouped = {
    id: 'other',
    title: UNGROUPED_TITLE,
    description: 'Registered with a type none of the other tabs claims. Anything can register a '
      + 'service, so a type nobody anticipated lands here rather than being dropped.',
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

/** A service type as words: it names a category, not a state, so it is plain text. */
const SERVICE_TYPE_LABELS = new Map([
  ['MONITORING', 'Monitoring'],
  ['EDGE_NODE', 'Edge node'],
  ['GRAPHICAL_UI', 'Graphical UI'],
  ['SOURCE_CONTROL', 'Source control'],
  ['DOCUMENTATION', 'Documentation'],
  ['MQTT_BROKER', 'MQTT broker'],
  ['INGESTION', 'Ingestion'],
  ['API_GATEWAY', 'API gateway'],
  ['REST_API', 'REST API'],
  ['AUTHENTICATION', 'Authentication'],
  ['SERVERLESS', 'Serverless functions'],
  ['DATABASE', 'Database'],
  ['TIME_SERIES_DB', 'Time-series database'],
  ['METRICS_EXPORTER', 'Metrics exporter']
])

/** The label for a service type; a type nobody mapped reads title-cased, underscores as spaces. */
export function serviceTypeLabel(type) {
  const raw = String(type ?? '').trim()
  if (SERVICE_TYPE_LABELS.has(raw)) return SERVICE_TYPE_LABELS.get(raw)
  return raw.split('_').filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

/**
 * One service's observed liveness, written every minute by `refresh_directory_liveness()` from
 * Prometheus's `up` series. ACTIVE and DOWN are observations, so they are the column's only badges;
 * anything else means nothing scrapes it, said in dim words rather than left blank. It cannot be
 * probed from inside the stack: `endpoint_url` holds browser addresses, which name the wrong host
 * from a container. `last_heartbeat` is shown only beside ACTIVE; it is cleared for the other two
 * so a timestamp cannot read as last seen at.
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
      className="directory-unobserved"
      title="Nothing in this stack observes this service. Its endpoint_url is a browser address, so a probe from inside a container would be asking about the wrong host."
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
    <span className="badge badge-neutral" style={{ opacity: 0.75 }} title="Nothing recorded where this service can be reached from. It was registered by something that does not set it.">
      not recorded
    </span>
  )
}

/**
 * The version an image reference names: its tag (`grafana/grafana:13.2.0` reads `13.2.0`). A
 * registry port is not a tag, a digest-only reference shows the digest's first 12 hex characters,
 * and an untagged one is what Docker pulls for it, `latest`. Null when there is no reference.
 */
export function imageVersion(ref) {
  const s = String(ref ?? '').trim()
  if (!s) return null
  const [name, digest] = s.split('@')
  const colon = name.indexOf(':', name.lastIndexOf('/') + 1)
  if (colon !== -1 && colon < name.length - 1) return name.slice(colon + 1)
  if (digest) return `sha256:${digest.replace(/^sha256:/, '').slice(0, 12)}`
  return 'latest'
}

/**
 * The version of the image this release deploys for the service, with the full reference in the
 * tooltip. db-init records it from the chart, so it is the release's pin rather than an
 * observation of the running container. One leading "v" is dropped so `v3.14.0` reads like
 * `13.2.0`. No image is said in words.
 */
function VersionCell({ image }) {
  const version = imageVersion(image)
  if (version) {
    return (
      <span
        className="mono"
        title={`${image} -- the image this release deploys, recorded from the chart at the last install or upgrade`}
      >
        {version.replace(/^[vV](?=\d)/, '')}
      </span>
    )
  }
  return (
    <span className="badge badge-neutral" style={{ opacity: 0.75 }} title="No image recorded. The chart records one for each service it deploys; this one is disabled in this deployment or was registered by something other than the chart.">
      not recorded
    </span>
  )
}

/**
 * One group's table. `.table-directory` pins the column widths so the columns hold still when the
 * tab changes.
 */
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
            <th title="The image tag this release deploys for the service; hover a version for the full image reference. Recorded from the chart by db-init on every install and upgrade">Version</th>
            <th title="Endpoints this browser can reach open in a new tab; everything else copies to the clipboard">Endpoint URL</th>
            <th title="Where the service can be reached from, as a property of its port binding. Set when the service is registered, and describing the seeded loopback bindings; a deployment that publishes differently updates it">Reach</th>
            <th title="Observed liveness. Written every minute from Prometheus's up series; services nothing scrapes read as not observed">Liveness</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.service_uuid}>
              <td><strong>{s.service_name}</strong></td>
              <td title={`Registered as ${s.service_type}`}>{serviceTypeLabel(s.service_type)}</td>
              <td className="cell-version">
                <VersionCell image={s.image} />
              </td>
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

export function DirectoryTab({ showToast, initialSection = '', onClearSection }) {
  const [services, setServices] = useState([])
  const [loading, setLoading]   = useState(true)
  // The latest read's failure, cleared by the next success; `lastGoodAt` is when `services` was read.
  const [loadError, setLoadError] = useState(null)
  const [lastGoodAt, setLastGoodAt] = useState(null)

  const loadAll = useCallback(async (signal) => {
    try {
      setServices(await api.get('/api/v1/directory', { signal }))
      setLastGoodAt(new Date())
      setLoadError(null)
      setLoading(false)
    } catch (e) {
      if (e.name !== 'AbortError') {
        setLoadError(e.message || 'The request failed.')
        setLoading(false)
      }
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
  // Null until a tab is chosen, which means the first. A group has a tab only while it has rows, so
  // if the chosen one empties between polls the first tab takes over and keeps the selection.
  const [groupId, setGroupId] = useState(null)
  const active = groups.find(g => g.id === groupId) || groups[0]
  if (groupId !== null && active && active.id !== groupId) setGroupId(active.id)

  // Opens the group a search-bar card named (`initialSection`, a group id), then drops the request
  // so a later visit starts on the first tab. Before the first read there are no groups to fall
  // back from, so the choice holds until the list arrives.
  useEffect(() => {
    if (!initialSection) return
    setGroupId(initialSection)
    onClearSection?.()
  }, [initialSection, onClearSection])

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        {loadError && lastGoodAt && (
          <div className="callout callout-warning callout-page">
            <IconAlertTriangle size={18} className="callout-icon" />
            <div>
              {`The latest read of the directory failed (${loadError}). The list is as of ${formatDateTime(lastGoodAt)}.`}
            </div>
          </div>
        )}

        <div className="card card-fill">
          <CardHeading
            icon={<IconBookOpen size={15} />}
            title="Directory"
            description="Every service this deployment runs, grouped by purpose, with its version, its address and whether that address works beyond the deployment host."
          />

          {loading ? (
            <LoadingState label="directory" />
          ) : loadError && !lastGoodAt ? (
            <div className="callout callout-danger">
              {`The directory could not be read: ${loadError}`}
            </div>
          ) : !active ? (
            <EmptyState
              icon={<IconBookOpen size={36} />}
              message="No services are registered in the directory."
            />
          ) : (<>
            <TabStrip
              ariaLabel="Service group"
              value={active.id}
              onChange={setGroupId}
              tabs={groups.map(g => ({ id: g.id, label: g.title }))}
              help={<HelpTip label={`About ${active.title}`} text={active.description} />}
            />
            {/* No toolbar row: a tab holds a dozen rows at most, so there is no search box or type
                picker. */}
            <ServiceTable rows={active.rows} onNotify={showToast} />
          </>)}
        </div>
      </div>
    </div>
  )
}

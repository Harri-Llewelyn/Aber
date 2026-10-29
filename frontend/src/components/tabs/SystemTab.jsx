import React, { useState, useCallback } from 'react'
import { api } from '../../api'
import { POLL_INTERVAL_MS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { IconExternalLink, IconServer, IconAlertTriangle } from '../common/Icons'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { CardHeading } from '../common/CardHeading'
import { TabStrip } from '../common/TabStrip'
import { useUrlTab } from '../../hooks/useUrlState'
import { SYSTEM_TABS } from '../../navigation'
import { useSortableRows } from '../../hooks/useTableSort'
import { rankIn } from '../../utils/tableSort'
import { SortHeader } from '../common/SortHeader'
import { Tooltip } from '../common/Tooltip'
import CopyableId from '../common/CopyableId'
import { formatDateTime } from '../../utils/format'

/**
 * Whether a browser can open this endpoint: an http(s) scheme and a host that is not a single-label
 * in-cluster Service name (`prometheus`, `supabase-envoy`). Erring towards copy: a copyable
 * address costs one paste, an unresolvable link costs a failed tab and a wrong conclusion.
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
  // A dot means a domain or an IPv4 literal; a colon-free single label means a Service name.
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
 * whether it is a web page; `exposure` says what can reach the service (NETWORK, HOST, INTERNAL,
 * UNKNOWN). The loopback test is separate from HOST exposure because the two can disagree, as for a
 * NETWORK row still at its seeded localhost address. UNKNOWN is treated as NETWORK, so adding the
 * column was not a regression for reachable services.
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
    // cluster.
    const isWeb = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    return {
      open: false,
      note: isWeb
        ? 'Internal to the stack -- this hostname resolves inside the cluster only'
        : 'Not a web page -- click to copy this address'
    }
  }

  if (exposure === 'INTERNAL') {
    return { open: false, note: 'Not published outside the cluster -- reachable from inside it, or through kubectl port-forward' }
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
      <Tooltip text={reach.note}>
        <a className="endpoint-action endpoint-open" href={url} target="_blank" rel="noreferrer">
          {url} <IconExternalLink size={12} className="copyable-id-icon" />
        </a>
      </Tooltip>
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
 * The service types each group lists. The order of a group's types is the row order; names break
 * ties. Keyed on service_type, not the editable name.
 */
const GROUP_TYPES = {
  // SOURCE_CONTROL is the forge: a place to review a change, which is a front door in exactly
  // this sense and a different kind of thing from a database console.
  applications: ['MONITORING', 'EDGE_NODE', 'GRAPHICAL_UI', 'SOURCE_CONTROL', 'DOCUMENTATION'],
  ingestion: ['MQTT_BROKER', 'INGESTION', 'API_GATEWAY'],
  infrastructure: ['REST_API', 'AUTHENTICATION', 'SERVERLESS', 'DATABASE', 'TIME_SERIES_DB', 'METRICS_EXPORTER'],
}

/**
 * The stack, one tab per group, in the order an operator looks for it: something to open, the path
 * telemetry arrives on, then the stores behind it. The groups, their names and their descriptions
 * are navigation.jsx's; each description is its tab's tooltip, and the help page has the rest.
 */
export const SERVICE_GROUPS = SYSTEM_TABS.map(t => ({ id: t.id, title: t.label, description: t.description, types: GROUP_TYPES[t.id] }))

/** The tooltip of the tab for services no group claims. */
export const UNGROUPED_DESCRIPTION = 'Services registered with a type no other tab claims, listed here rather than dropped.'

/**
 * Where a service whose type is in no group lands. Not dropped: anything can register into
 * `directory_services`, and a running service must not vanish from the page whose job is to list
 * them.
 */
const UNGROUPED_TITLE = 'Other Registered Services'

/** Splits the flat list of services into the groups above, dropping any that came back empty. */
function groupServices(services) {
  // service_type -> [group index, position within that group].
  const rank = new Map()
  SERVICE_GROUPS.forEach((g, gi) => g.types.forEach((t, ti) => rank.set(t, [gi, ti])))

  const byName = (a, b) => String(a.service_name || '').localeCompare(String(b.service_name || ''))

  const sections = SERVICE_GROUPS.map(g => ({ id: g.id, title: g.title, description: g.description, rows: [] }))
  const ungrouped = {
    id: 'other',
    title: UNGROUPED_TITLE,
    description: UNGROUPED_DESCRIPTION,
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
 * anything else means nothing scrapes it, said in dim words rather than left blank. Nothing probes
 * `endpoint_url` instead: several are browser addresses, which name the wrong host from inside
 * the cluster. `last_heartbeat` is shown only beside ACTIVE; it is cleared for the other two
 * so a timestamp cannot read as last seen at.
 */
function LivenessCell({ status, lastHeartbeat }) {
  if (status === 'ACTIVE') {
    return (
      <Tooltip text={lastHeartbeat
        ? `Prometheus scraped this successfully at ${new Date(lastHeartbeat).toLocaleTimeString()}`
        : 'Prometheus reports this target as up'}>
        <span className="badge badge-success">ACTIVE</span>
      </Tooltip>
    )
  }
  if (status === 'DOWN') {
    return (
      <Tooltip text="Prometheus scraped this target and it did not answer">
        <span className="badge badge-danger">DOWN</span>
      </Tooltip>
    )
  }
  return (
    <Tooltip text="Nothing in Aber observes this service: no exporter reports on it, and this page probes no address itself.">
      <span className="system-unobserved">not observed</span>
    </Tooltip>
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
      <Tooltip text="Published through the Ingress or a LoadBalancer port. Another machine can reach it, if the firewall and DNS allow.">
        <span className="badge badge-neutral">network</span>
      </Tooltip>
    )
  }
  if (exposure === 'HOST') {
    return (
      <Tooltip text="Bound to 127.0.0.1 on the deployment host. Reach it there, or through an SSH tunnel from anywhere else.">
        <span className="badge badge-warning">host only</span>
      </Tooltip>
    )
  }
  if (exposure === 'INTERNAL') {
    return (
      <Tooltip text="Not published outside the cluster. Reach it by service name inside it, or from a workstation through kubectl port-forward.">
        <span className="badge badge-neutral" style={{ opacity: 0.75 }}>internal</span>
      </Tooltip>
    )
  }
  return (
    <Tooltip text="Nothing records where this service can be reached from: what registered it does not set it.">
      <span className="badge badge-neutral" style={{ opacity: 0.75 }}>not recorded</span>
    </Tooltip>
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
 * What the release's scan found in this row's exact image, or `{ scanned: false }` when it did not
 * scan that reference (an overridden tag, or a build that is not a release). Null without an image.
 * db-init matches the reference; a row missing a count or the date is treated as not scanned, so
 * a zero is only ever shown with the date it was true on.
 */
export function imageScan(service) {
  if (!service?.image) return null
  const { image_fixable_critical: critical, image_fixable_high: high } = service
  const at = Date.parse(service.image_scanned_at ?? '')
  const dbAt = Date.parse(service.image_vulnerability_db_at ?? '')
  if (!Number.isInteger(critical) || !Number.isInteger(high) || Number.isNaN(at)) return { scanned: false }
  return {
    scanned: true,
    critical,
    high,
    date: new Date(at).toISOString().slice(0, 10),
    dbDate: Number.isNaN(dbAt) ? null : new Date(dbAt).toISOString().slice(0, 10)
  }
}

/** "3 fixable HIGH, as of 2026-10-02": the counts, dated, since a later CVE is not counted. */
export function imageScanSummary(scan) {
  const parts = []
  if (scan.critical) parts.push(`${scan.critical} fixable CRITICAL`)
  if (scan.high) parts.push(`${scan.high} fixable HIGH`)
  return `${parts.length ? parts.join(' and ') : 'No fixable HIGH or CRITICAL'}, as of ${scan.date}`
}

/** The badge beside a version: the count with its date in the tooltip, or "not scanned" in words. */
function ScanBadge({ scan }) {
  if (!scan) return null
  if (!scan.scanned) {
    return (
      <Tooltip text="The release did not scan this exact image, so its vulnerabilities are not counted. An overridden tag or an unreleased build has no scan.">
        <span className="system-unobserved system-scan">not scanned</span>
      </Tooltip>
    )
  }
  const count = scan.critical + scan.high
  const tone = scan.critical ? 'badge-danger' : scan.high ? 'badge-warning' : 'badge-neutral'
  const db = scan.dbDate ? ` against the vulnerability database of ${scan.dbDate}` : ''
  return (
    <Tooltip text={`${imageScanSummary(scan)}. Counted when the release was scanned${db}; a vulnerability published since is not counted.`}>
      <span className={`badge badge-sm ${tone} system-scan`}>
        {count} {count === 1 ? 'CVE' : 'CVEs'}
      </span>
    </Tooltip>
  )
}

/**
 * The version of the image this release deploys for the service, with the full reference in the
 * tooltip. db-init records it from the chart, so it is the release's pin rather than an
 * observation of the running container. An image Aber builds from a third-party product shows that
 * product's version, from the release's scan summary. One leading "v" is dropped so `v3.14.0`
 * reads like `13.2.0`. No image is said in words.
 */
function VersionCell({ service }) {
  const { image } = service
  const upstream = service.upstream_version || null
  const version = upstream || imageVersion(image)
  if (version) {
    const built = upstream ? ` It is built from ${upstream} of the upstream product, the version shown.` : ''
    return (
      <>
        <Tooltip text={`${image} — the image this release deploys, recorded from the chart at the last install or upgrade.${built}`}>
          <span className="mono">{version.replace(/^[vV](?=\d)/, '')}</span>
        </Tooltip>
        <ScanBadge scan={imageScan(service)} />
      </>
    )
  }
  return (
    <Tooltip text="No image recorded. The chart records one for each service it deploys; this one is disabled in this deployment, or the chart did not register it.">
      <span className="badge badge-neutral" style={{ opacity: 0.75 }}>not recorded</span>
    </Tooltip>
  )
}

/**
 * The service table's sortable columns, each on what its cell shows. Reach runs from the widest
 * to the narrowest, and Liveness puts a DOWN service first; "not recorded" and "not observed" go
 * last.
 */
const SERVICE_SORT = {
  name: { type: 'text', value: s => s.service_name },
  type: { type: 'text', value: s => serviceTypeLabel(s.service_type) },
  version: { type: 'text', value: s => (s.upstream_version || imageVersion(s.image))?.replace(/^[vV](?=\d)/, '') },
  endpoint: { type: 'text', value: s => s.endpoint_url },
  reach: { type: 'rank', value: s => rankIn(['NETWORK', 'HOST', 'INTERNAL'], s.exposure) },
  liveness: { type: 'rank', value: s => rankIn(['DOWN', 'ACTIVE'], s.status) }
}

/**
 * One group's table. `.table-system` pins the column widths so the columns hold still when the
 * tab changes.
 */
function ServiceTable({ rows, onNotify }) {
  const [sorted, sort] = useSortableRows(rows, SERVICE_SORT)
  // Read once per render rather than per row. `window` is guarded because this module is imported
  // by tests that render without a location.
  const viewerOnHost = viewerIsOnDeploymentHost(
    typeof window === 'undefined' ? '' : window.location?.hostname
  )

  return (
    <div className="table-wrap">
      <table className="table-system">
        <thead>
          <tr>
            <SortHeader sort={sort} column="name">Service Name</SortHeader>
            <SortHeader sort={sort} column="type">Service Type</SortHeader>
            <SortHeader sort={sort} column="version" title="The version this release deploys; point at it for the image. The badge counts fixable HIGH and CRITICAL vulnerabilities, dated.">Version</SortHeader>
            <SortHeader sort={sort} column="endpoint" title="Endpoints this browser can reach open in a new tab; everything else copies to the clipboard">Endpoint URL</SortHeader>
            <SortHeader sort={sort} column="reach" title="Where the service can be reached from, as the chart publishes it, recorded at every install and upgrade.">Reach</SortHeader>
            <SortHeader sort={sort} column="liveness" title="Written every minute from Prometheus's up series. A service nothing scrapes reads as not observed.">Liveness</SortHeader>
          </tr>
        </thead>
        <tbody>
          {sorted.map(s => (
            <tr key={s.service_uuid}>
              <td><strong>{s.service_name}</strong></td>
              <Tooltip text={`Registered as ${s.service_type}`}><td>{serviceTypeLabel(s.service_type)}</td></Tooltip>
              <td className="cell-version">
                <VersionCell service={s} />
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

export function SystemTab({ showToast }) {
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
  // The tab, in the path (`/system/<group>`); the first group is the bare page. A group has a
  // tab only while it has rows, so one that empties between polls leaves the address and the first
  // tab takes over. Before the first read the path is held until the list arrives.
  const [groupId, setGroupId, groupHref] = useUrlTab('system', groups.map(g => g.id), groups[0]?.id, { ready: !loading })
  const active = groups.find(g => g.id === groupId) || groups[0]

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        {loadError && lastGoodAt && (
          <div className="callout callout-warning callout-page">
            <IconAlertTriangle size={18} className="callout-icon" />
            <div>
              {`The latest read of the service list failed (${loadError}). The list is as of ${formatDateTime(lastGoodAt)}.`}
            </div>
          </div>
        )}

        <div className="card card-fill">
          <CardHeading
            icon={<IconServer size={15} />}
            title="System"
            description="Every service this deployment runs, grouped by purpose, with its version, its address and whether that address works beyond the deployment host."
          />

          {loading ? (
            <LoadingState label="services" />
          ) : loadError && !lastGoodAt ? (
            <div className="callout callout-danger">
              {`The service list could not be read: ${loadError}`}
            </div>
          ) : !active ? (
            <EmptyState
              icon={<IconServer size={36} />}
              message="No services are registered."
            />
          ) : (<>
            <TabStrip
              ariaLabel="System"
              value={active.id}
              onChange={setGroupId}
              hrefFor={groupHref}
              tabs={groups.map(g => ({ id: g.id, label: g.title, description: g.description }))}
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

import React, { useState, useCallback } from 'react'
import { api } from '../../api'
import { POLL_INTERVAL_MS } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { describeAuthFailure } from '../../utils/sessionError'
import { IconExternalLink, IconCopy, IconCheck } from '../common/Icons'
import { copyText } from '../common/CopyableId'

/**
 * The stack, in the order an operator looks for it: something to open, the path telemetry
 * arrives on, then the stores behind it.
 *
 * Replaces one flat alphabetical list of a dozen rows -- alphabetical being the order the
 * registry happened to store them in rather than an order anyone reads in, so Grafana, Kong,
 * Mosquitto and PostgREST sat interleaved with no cue as to which of them an engineer chasing
 * a missing message should look at.
 *
 * KEYED ON service_type, NOT ON service_name. The name is free text an operator can edit --
 * grouping on it would put a renamed service in the wrong section, or in none. The type is the
 * category the service declared when it registered.
 *
 * The order of `types` within a group is the render order within its table, so a group reads
 * front-to-back (broker, then ingestion, then the gateway they arrive through) rather than
 * alphabetically. Names break ties inside one type.
 */
/**
 * Whether this endpoint is something a BROWSER can open.
 *
 * WHY THIS IS NOT JUST "STARTS WITH HTTP". Two of the rows here are http and still unopenable:
 * `http://node-exporter:9100/metrics` is a compose-network hostname that resolves inside the stack
 * and nowhere else. A scheme test alone would render it as a link, and clicking it would fail in a
 * way that reads as the service being down rather than as the address being internal.
 *
 * So the test is scheme AND host:
 *   * a non-http(s) scheme -- `mqtt://`, `postgres://` -- is never a browser destination
 *   * a SINGLE-LABEL hostname that is not localhost is a container name: `node-exporter`,
 *     `supabase-kong`. Real deployments use `localhost`, an IP, or a dotted domain, all of which
 *     a browser can reach.
 *
 * Erring towards COPY is the safe direction. A copyable address that could have been a link costs
 * one paste; a link that cannot resolve costs a failed tab and a wrong conclusion about the stack.
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

/**
 * The endpoint cell: a link when it can be opened, a copy button when it cannot.
 *
 * BOTH ARE BUTTON-SHAPED, and that is the point of the change rather than a side effect. The two
 * used to render identically -- a bare monospace anchor -- so the only way to learn that
 * `mqtt://localhost:1883` was not a web page was to click it and get a failed tab. Giving each
 * affordance a visible shape makes "which of these can I open" answerable by looking.
 */
function EndpointCell({ url, onNotify }) {
  const [copied, setCopied] = useState(false)

  if (isBrowsableEndpoint(url)) {
    return (
      <a
        className="endpoint-action endpoint-open mono"
        href={url}
        target="_blank"
        rel="noreferrer"
        title="Open this endpoint in a new tab"
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
      title="Not a web page -- click to copy this address"
    >
      {url} {copied ? <IconCheck size={10} /> : <IconCopy size={10} />}
    </button>
  )
}

// A DESCRIPTION PER GROUP, not one for the page. Each card here is a different KIND of thing --
// somewhere to click through to, the path telemetry travels, or the machinery underneath -- and a
// single sentence at the top of the page would have to be vague about all three.
const SERVICE_GROUPS = [
  {
    title: 'Applications & User Interfaces',
    description: 'The things with a front door. These are meant to be opened — a link here is where '
      + 'you go to do something the dashboard does not do itself.',
    types: ['MONITORING', 'EDGE_NODE', 'GRAPHICAL_UI', 'DOCUMENTATION']
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
 * Where a service whose type is in no group above lands.
 *
 * NOT a dropped row. `directory_services` is a registry anything can register into -- the same
 * reason the old type filter derived its options from the rows instead of hardcoding them -- so
 * a fixed set of groups WILL eventually meet a type nobody anticipated. Showing it under a
 * heading that admits as much is the only option here that cannot silently hide a running
 * service from the page whose whole job is to list them.
 */
const UNGROUPED_TITLE = 'Other Registered Services'

/** Splits the flat directory into the sections above, dropping any that came back empty. */
export function groupServices(services) {
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
 * One group's table. Shared markup rather than three copies -- and `.table-directory` pins the
 * column widths so the three tables line up as one list broken into sections instead of three
 * tables that each sized their columns from their own rows.
 */
/*
 * THE STATUS COLUMN IS BACK, AND IT NOW DESCRIBES SOMETHING THAT WAS OBSERVED.
 *
 * It was removed because nothing wrote it. The only writes to `directory_services` were the seed
 * INSERTs in `0002`, so `status` was the literal string 'ACTIVE' on all fifteen rows at every age,
 * and `last_heartbeat` was the moment the row was seeded. The pill was the more dangerous half: a
 * stale date reads as stale and makes a reader suspicious, whereas a green ACTIVE badge is
 * believed -- and it would have said ACTIVE for a service down a week.
 *
 * `refresh_directory_liveness()` (archived migration 0054) now writes both, every minute, from Prometheus's
 * `up` series. Six of the fifteen are genuinely scraped.
 *
 * ---------------------------------------------------------------------------------------------
 * THE OTHER NINE ARE THE WHOLE DESIGN PROBLEM, AND `UNKNOWN` IS NOT A BLANK.
 *
 * A page showing green for six services and nothing for nine invites the reader to assume the
 * blanks are fine -- which is the same fabrication in a quieter font. So `UNKNOWN` renders as its
 * own visible state with its own words: "not observed", not an empty cell and not a grey dash that
 * could be mistaken for a rendering gap.
 *
 * The distinction the reader has to be able to make at a glance is NOT healthy-vs-unhealthy. It is
 * OBSERVED-vs-UNOBSERVED. A service can be perfectly fine and still be unobserved, and a page that
 * blurred the two would be back to asserting things nobody checked.
 *
 * WHY NINE SERVICES CANNOT BE PROBED, since "add a probe" is the obvious next thought:
 * `endpoint_url` holds BROWSER addresses -- `http://localhost:8088`, `postgres://localhost:54322`.
 * From inside any container those name the container itself, so a probe against them would be
 * answering a question about the wrong host and reporting it as service health. That is a worse
 * defect than admitting the gap.
 */
/**
 * One service's observed liveness.
 *
 * THREE STATES, AND THE THIRD IS THE ONE THAT MATTERS. ACTIVE and DOWN are both OBSERVATIONS --
 * Prometheus scraped the target and it answered, or it did not. UNKNOWN means nothing scrapes this
 * service at all, which is neither good news nor bad news and must not be dressed as either.
 *
 * So UNKNOWN is not a grey dash: a dash reads as "no data yet" or as a rendering gap, and either
 * reading lets somebody assume it is fine. It says "not observed", in words, with a tooltip that
 * explains why -- because the honest answer to "is it up?" here is "nobody is looking".
 *
 * `last_heartbeat` is only shown beside ACTIVE. 0054 clears it for DOWN and UNKNOWN precisely so a
 * timestamp cannot linger beside a red badge and read as "last seen at", which is a different and
 * more reassuring claim than the row is making.
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

function ServiceTable({ rows, onNotify }) {
  return (
    <div className="table-wrap">
      <table className="table-directory">
        <thead>
          <tr>
            <th title="Service name">Service Name</th>
            <th title="Architecture category">Service Type</th>
            <th title="Web endpoints open in a new tab; everything else copies to the clipboard">Endpoint URL</th>
            <th title="Observed liveness. Written every minute from Prometheus's up series; services nothing scrapes read as not observed">Liveness</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.service_uuid}>
              <td><strong>{s.service_name}</strong></td>
              <td><span className="badge badge-neutral">{s.service_type}</span></td>
              <td className="cell-endpoint">
                <EndpointCell url={s.endpoint_url} onNotify={onNotify} />
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
   * The page's only refresh. The manual "Refresh Directory" button is gone: it re-ran exactly
   * this call next to a table that now reloads on its own, and it read as a control over the
   * GitOps panel that used to sit above it -- which has itself since gone, with the flow it
   * deployed.
   *
   * POLL_INTERVAL_MS, not refreshInterval(). That helper slows to the 60s reconciliation
   * interval when Realtime is on, which is correct ONLY for a tab that also holds a channel
   * carrying its updates -- and `directory_services` is not in the `supabase_realtime`
   * publication (see 0001, which publishes cells, gateways and devices and nothing else). A
   * tab with no channel that polled at the reconciliation interval would show a heartbeat up
   * to a minute stale and look, from the page, exactly like a service that had gone quiet.
   */
  usePolling(loadAll, POLL_INTERVAL_MS)

  const groups = groupServices(services)

  return (
    <>
      {/* Heading and description removed: the top bar names the page, and the service groups
          below already say what each of them is.

          THE GITOPS PANEL IS GONE, not hidden. Its button deployed `node_red_flow.json` through
          the `deploy-nodered` edge function, and the demonstrator retirement removed both -- so
          the control would have posted to a function that no longer exists and reported a
          deployment failure. `gitops:manage` itself survives: `nodered-userinfo` is now the only
          thing that enforces it, mapping the permission onto the Node-RED editor's own tier. */}

      {/* The search box and type picker went with the filter bar. They were solving the flat
          list's problem -- twelve unordered rows are hard to scan -- and the grouping solves it
          without a control to operate first. */}
      {loading ? <div className="loading-wrap"><div className="spinner" /> Loading directory…</div> : (
        groups.map(g => (
          <div className="card directory-group" key={g.title}>
            <div className="card-header">
              <h3 className="section-title">{g.title} <span className="section-count">{g.rows.length}</span></h3>
            </div>
            {g.description && (
              <div className="card-body">
                <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: 0 }}>{g.description}</p>
              </div>
            )}
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

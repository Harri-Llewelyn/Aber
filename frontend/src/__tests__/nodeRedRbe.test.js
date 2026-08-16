/**
 * Report-by-exception behaviour of the Simulated Shopfloor subflows.
 *
 * WHY THIS IS TESTED FROM THE FRONTEND SUITE. `node_red_flow.json` is seeded into Node-RED by
 * scripts/node-red-init.mjs and its function bodies are never imported by anything — so nothing
 * else in this repository can notice when one of them regresses. They are plain JavaScript, and
 * vitest is the only JavaScript runner here, so this is where they can be executed. Each body is
 * evaluated with its Node-RED contract supplied explicitly: `env`, `context`, `global`, `node`,
 * and a controllable `Date` so a scan schedule can be simulated without waiting for one.
 *
 * REWRITTEN FOR THE CONSOLIDATED FLOW. This suite used to drive the introductory tab's
 * `build-ddata-payload` node, which no longer exists — one tab now, five device subflows, and the
 * simulation body is shared by all of them. The PROPERTIES being pinned are unchanged, because
 * they are properties of report-by-exception rather than of any particular flow:
 *
 *   * DBIRTH carries live readings and seeds the cache, so the birth certificate is the baseline
 *     rather than a set of nominal placeholders the first DDATA has to correct.
 *   * DDATA carries ONLY what moved. A fixed-interval full payload is not DDATA; it is polling
 *     with extra steps, and it writes a row per metric per tick for readings nobody took.
 *   * A deadband suppresses movement below it, and does not suppress movement above it.
 *   * The keepalive bounds how long silence can last, because a genuinely constant value is
 *     otherwise indistinguishable from a dead device.
 *   * `seq` advances by one per published message and wraps 255 → 0, which is the only way
 *     ingestion can detect a dropped message under RBE.
 *
 * THE CACHE MUST BE PER INSTANCE. `context` here is a fresh store per simulated device, mirroring
 * Node-RED's per-subflow-instance node context. If the body were changed to use `flow` or `global`
 * for its cache, five devices would share one — four would publish nothing and the fifth nonsense.
 * `test/'each device keeps its own cache'` is what holds that.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const FLOW = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_red_flow.json'
)
const nodes = Object.fromEntries(
  JSON.parse(readFileSync(FLOW, 'utf8')).filter((n) => n.id).map((n) => [n.id, n])
)

const SCAN_MS = 5000
const CNC_BODY = nodes['sf-cnc-fn'].func
const OEE_BODY = nodes['sf-oee-fn'].func

/**
 * One simulated device: its own context store, its own env, a shared global.
 *
 * `globalStore` is passed in so two devices can share it — which is exactly what the fault-inject
 * flags do, and exactly what the RBE cache must NOT do.
 */
function makeDevice (body, env, globalStore = new Map(), startAt = 1786284000000) {
  const store = new Map()
  const clock = { now: startAt }
  const context = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) }
  const globalCtx = { get: (k) => globalStore.get(k), set: (k, v) => globalStore.set(k, v) }
  const envCtx = { get: (k) => env[k] }
  const statuses = []

  // A REAL CONSTRUCTOR, not `{ now }`. The bodies format a timestamp into node.status() with
  // `new Date(t).toLocaleTimeString()`, so a plain object stands in for `Date.now()` and then
  // throws "Date is not a constructor" the moment the status line runs -- which is on every
  // published message. Subclassing keeps `new Date(ms)` working while pinning `Date.now()` to the
  // controllable clock, which is the only part these tests need to steer.
  class FakeDate extends Date {
    static now () { return clock.now }
  }

  const run = (msg = {}) =>
    new Function('env', 'context', 'global', 'node', 'msg', 'Date', body)(
      envCtx, context, globalCtx,
      { warn: () => {}, error: () => {}, status: (s) => statuses.push(s) },
      msg,
      FakeDate
    )

  return {
    context, clock, globalStore, statuses, run,
    /** Advance the clock by one scan and run the body. Returns the message, or null if silent. */
    scan (advanceMs = SCAN_MS) {
      clock.now += advanceMs
      return run()
    }
  }
}

const cncEnv = (overrides = {}) => ({
  DEVICE_ID: 'dev220000000000400080000',
  DEVICE_NAME: 'Sim_CNC_Mill_01',
  GATEWAY_ID: 'gwy120000000000400080000',
  KIND: 'cnc',
  SPARKPLUG_GROUP: 'ACS-Cymru',
  BIRTH_EVERY_SCANS: '180',
  ...overrides
})

const metricNames = (msg) => msg.payload.metrics.map((m) => m.name).sort()
const metricByName = (msg, name) => msg.payload.metrics.find((m) => m.name === name)

let dev
beforeEach(() => {
  dev = makeDevice(CNC_BODY, cncEnv())
})

describe('DBIRTH declares the baseline', () => {
  it('the first scan is a DBIRTH, not a DDATA', () => {
    const first = dev.scan()
    expect(first.topic).toContain('/DBIRTH/')
    expect(first.topic).toBe(
      'spBv1.0/ACS-Cymru/DBIRTH/gwy120000000000400080000/dev220000000000400080000'
    )
  })

  it('carries every metric the device reports, plus its identity', () => {
    const names = metricNames(dev.scan())
    expect(names).toContain('Asset_ID')
    expect(names).toContain('Asset_Name')
    expect(names).toContain('Systems/TEMPERATURE')
    expect(names).toContain('Controller/EXECUTION')
    expect(names).toContain('Axes/X/POSITION')
  })

  it('publishes LIVE readings, so the cache it seeds is the real baseline', () => {
    const birth = dev.scan()
    const temp = metricByName(birth, 'Systems/TEMPERATURE').double_value
    // A nominal placeholder would be a round number; this is a live sample around 42 degC.
    expect(temp).toBeGreaterThan(35)
    expect(temp).toBeLessThan(50)

    // The cache holds the FULL-PRECISION reading while the payload carries it rounded to 3dp, and
    // that asymmetry is deliberate: the deadband compares against the cache, so caching the
    // rounded value would quantise every comparison to the same 0.001 grid the wire uses. Close
    // to, not equal to.
    expect(dev.context.get('rbe')['Systems/TEMPERATURE']).toBeCloseTo(temp, 3)
  })

  it('every metric name it declares is one the catalog registers', () => {
    // Guards the failure that is silent end to end: a name published but not in metric_catalog
    // lands in telemetry with no standard and no semantic id, and exports as unmodelled.
    const REGISTERED = new Set([
      'Axes/X/POSITION', 'Axes/Y/POSITION', 'Systems/TEMPERATURE',
      'Controller/EXECUTION', 'Controller/EMERGENCY_STOP'
    ])
    for (const name of metricNames(dev.scan())) {
      if (name === 'Asset_ID' || name === 'Asset_Name') continue
      expect(REGISTERED.has(name), `${name} is not a registered metric_catalog name`).toBe(true)
    }
  })
})

describe('DDATA publishes only on exception', () => {
  beforeEach(() => { dev.scan() })   // consume the birth

  it('a scan in which nothing moved beyond its deadband publishes nothing', () => {
    // The simulated waves are slow relative to one 5s scan, so consecutive scans sit well inside
    // the 0.5 degC / 0.5 mm bands. A body that published unconditionally would return a message.
    let silent = 0
    for (let i = 0; i < 4; i++) {
      if (dev.scan(1) === null) silent++
    }
    expect(silent).toBeGreaterThan(0)
  })

  it('publishes DDATA, not DBIRTH, once born', () => {
    // Advance far enough for the waves to move past their deadbands.
    let msg = null
    for (let i = 0; i < 40 && msg === null; i++) msg = dev.scan()
    expect(msg).not.toBeNull()
    expect(msg.topic).toContain('/DDATA/')
  })

  it('a published DDATA carries only the metrics that changed, never the whole set', () => {
    let msg = null
    for (let i = 0; i < 40 && msg === null; i++) msg = dev.scan()
    expect(msg.payload.metrics.length).toBeLessThan(5)
  })

  it('never carries identity metrics in DDATA', () => {
    // Asset_ID/Asset_Name are immutable and belong in the birth certificate; the topic is what
    // identifies the device. Ingestion filters them, but publishing them is still wrong.
    for (let i = 0; i < 60; i++) {
      const msg = dev.scan()
      if (!msg) continue
      expect(metricNames(msg)).not.toContain('Asset_ID')
      expect(metricNames(msg)).not.toContain('Asset_Name')
    }
  })
})

describe('the keepalive bounds how long silence can last', () => {
  it('republishes an unchanged metric after the silence window', () => {
    dev.scan()                       // birth
    // Jump past MAX_SILENCE_MS (5 minutes) in one step. Everything is "unchanged" relative to the
    // cache only in the sense that the deadband would suppress it; the keepalive must override.
    const msg = dev.scan(6 * 60 * 1000)
    expect(msg).not.toBeNull()
    expect(msg.payload.metrics.length).toBeGreaterThan(0)
  })
})

describe('the Sparkplug sequence number', () => {
  it('starts at zero and advances by one per published message', () => {
    const birth = dev.scan()
    expect(birth.payload.seq).toBe(0)

    let next = null
    for (let i = 0; i < 40 && next === null; i++) next = dev.scan()
    expect(next.payload.seq).toBe(1)
  })

  it('wraps 255 to 0 rather than growing without bound', () => {
    dev.scan()
    dev.context.set('seq', 255)
    let msg = null
    for (let i = 0; i < 40 && msg === null; i++) msg = dev.scan()
    expect(msg.payload.seq).toBe(255)
    expect(dev.context.get('seq')).toBe(0)
  })
})

describe('the cache is per device, not shared', () => {
  it('each device keeps its own RBE cache', () => {
    // THE REGRESSION THIS EXISTS FOR. Moving the cache to flow/global context would make these
    // two share one, and the second device would publish nothing after the first had "already"
    // reported the same values.
    const shared = new Map()
    const a = makeDevice(CNC_BODY, cncEnv({ DEVICE_NAME: 'Sim_CNC_Mill_01' }), shared)
    const b = makeDevice(CNC_BODY, cncEnv({ DEVICE_NAME: 'Sim_CNC_Mill_02' }), shared)

    const birthA = a.scan()
    const birthB = b.scan()

    expect(birthA.topic).toContain('/DBIRTH/')
    expect(birthB.topic).toContain('/DBIRTH/')
    expect(a.context.get('rbe')).not.toBe(b.context.get('rbe'))
  })
})

describe('fault injection reaches the change detector', () => {
  it('the thermal flag drives the targeted mill to an alarm reading', () => {
    const shared = new Map()
    const mill = makeDevice(CNC_BODY, cncEnv(), shared)
    mill.scan()                                   // birth at nominal

    shared.set('fault_thermal', true)
    const msg = mill.scan()
    expect(msg).not.toBeNull()
    expect(metricByName(msg, 'Systems/TEMPERATURE').double_value).toBeGreaterThan(90)
  })

  it('the thermal flag is scoped to the device it names', () => {
    const shared = new Map()
    const other = makeDevice(CNC_BODY, cncEnv({ DEVICE_NAME: 'Sim_CNC_Mill_02' }), shared)
    other.scan()

    shared.set('fault_thermal', true)
    for (let i = 0; i < 10; i++) {
      const msg = other.scan()
      const temp = msg && metricByName(msg, 'Systems/TEMPERATURE')
      if (temp) expect(temp.double_value).toBeLessThan(60)
    }
  })

  it('the e-stop flag interrupts execution and trips the emergency stop', () => {
    const shared = new Map()
    const mill = makeDevice(CNC_BODY, cncEnv(), shared)
    mill.scan()

    shared.set('fault_estop', true)
    const msg = mill.scan()
    expect(metricByName(msg, 'Controller/EXECUTION').string_value).toBe('INTERRUPTED')
    expect(metricByName(msg, 'Controller/EMERGENCY_STOP').string_value).toBe('TRIGGERED')
  })

  it('clearing the flags returns the device to nominal', () => {
    const shared = new Map()
    const mill = makeDevice(CNC_BODY, cncEnv(), shared)
    mill.scan()

    shared.set('fault_thermal', true)
    mill.scan()
    shared.set('fault_thermal', false)

    let msg = null
    for (let i = 0; i < 10 && msg === null; i++) msg = mill.scan()
    expect(metricByName(msg, 'Systems/TEMPERATURE').double_value).toBeLessThan(60)
  })
})

describe('the ISO 22400 aggregator', () => {
  const oeeEnv = {
    DEVICE_ID: 'dev250000000000400080000',
    DEVICE_NAME: 'Sim_Cell3_Aggregator',
    GATEWAY_ID: 'gwy140000000000400080000',
    SOURCE_DEVICE_ID: 'dev220000000000400080000',
    SPARKPLUG_GROUP: 'ACS-Cymru'
  }

  it('publishes the four registered KPI names', () => {
    const agg = makeDevice(OEE_BODY, oeeEnv)
    const msg = agg.scan(60000)
    expect(metricNames(msg)).toEqual(
      ['OEE/AVAILABILITY', 'OEE/OEE', 'OEE/PERFORMANCE', 'OEE/QUALITY']
    )
  })

  it('publishes on every heartbeat, not report-by-exception', () => {
    // Computed values on a fixed cadence: the series must have no RBE gaps for a BI tool to read
    // through telemetry_gapfill().
    const agg = makeDevice(OEE_BODY, oeeEnv)
    for (let i = 0; i < 3; i++) {
      expect(agg.scan(60000)).not.toBeNull()
    }
  })

  it('availability falls when the source machine is not ACTIVE', () => {
    const shared = new Map()
    const agg = makeDevice(OEE_BODY, oeeEnv, shared)

    shared.set('state_dev220000000000400080000', 'ACTIVE')
    agg.scan(60000)
    const busy = metricByName(agg.scan(60000), 'OEE/AVAILABILITY').double_value

    shared.set('state_dev220000000000400080000', 'INTERRUPTED')
    let idle = busy
    for (let i = 0; i < 5; i++) {
      idle = metricByName(agg.scan(60000), 'OEE/AVAILABILITY').double_value
    }
    expect(idle).toBeLessThan(busy)
  })

  it('OEE is the product of its three factors', () => {
    const shared = new Map()
    const agg = makeDevice(OEE_BODY, oeeEnv, shared)
    shared.set('state_dev220000000000400080000', 'ACTIVE')
    agg.scan(60000)
    const msg = agg.scan(60000)

    const a = metricByName(msg, 'OEE/AVAILABILITY').double_value
    const p = metricByName(msg, 'OEE/PERFORMANCE').double_value
    const q = metricByName(msg, 'OEE/QUALITY').double_value
    const oee = metricByName(msg, 'OEE/OEE').double_value

    expect(oee).toBeCloseTo((a / 100) * (p / 100) * (q / 100) * 100, 1)
  })
})

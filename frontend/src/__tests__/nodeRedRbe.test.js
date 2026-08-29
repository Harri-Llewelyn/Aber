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
 *   * ONE COUNTER PER EDGE NODE, not per device. Sparkplug scopes `seq` to the edge node and
 *     ingestion.py keys `_last_seq` on `(group, edge_node)`, so the three devices and the
 *     heartbeat publishing under one gateway share a single run of numbers. They each kept their
 *     own until b40e9d3, and four counters interleaving into one sequence made the daemon conclude
 *     messages were lost -- 238 gaps on one gateway in thirty minutes, on a fleet that had lost
 *     nothing.
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
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'simulation', 'node_red_flow.json'
)
const nodes = Object.fromEntries(
  JSON.parse(readFileSync(FLOW, 'utf8')).filter((n) => n.id).map((n) => [n.id, n])
)

const SCAN_MS = 5000
const CNC_BODY = nodes['sf-cnc-fn'].func
const OEE_BODY = nodes['sf-oee-fn'].func
// The gateway's own NBIRTH/NDATA node. It is on the tab rather than in a subflow and its ids are
// literals for that reason -- `env` on a plain function node does not resolve -- so it takes no
// env here. It shares the edge node's counter with every device subflow beneath it.
const HB_BODY = nodes['fn-hb-cnc'].func
const SEQ_KEY = 'seq_gwy120000000000400080000'

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
      'Controller/EXECUTION', 'Controller/EMERGENCY_STOP',
      // Catalogued since 0002 as a local extension, and modelled by Machining_Cell_Schema from
      // 0022/0023. The mill declares its OWN thermal limit and the Grafana rule compares against it
      // per device -- which is what replaced the hardcoded 80.0 the dashboard used to carry.
      'max_temp_threshold'
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
    // SEEDED IN `global`, UNDER THE EDGE NODE'S KEY. This drove `context` until b40e9d3 moved the
    // counter, at which point the seeding reached nothing, the body went on counting from 1, and
    // the test failed on an assertion about wrapping that the body still implements correctly. A
    // harness that pokes at the wrong store reports the wrong thing broken.
    dev.globalStore.set(SEQ_KEY, 255)
    let msg = null
    for (let i = 0; i < 40 && msg === null; i++) msg = dev.scan()
    expect(msg.payload.seq).toBe(255)
    expect(dev.globalStore.get(SEQ_KEY)).toBe(0)
  })
})

/**
 * THE COUNTER BELONGS TO THE EDGE NODE, and this is the regression b40e9d3 fixed.
 *
 * `context` in a subflow is scoped to the INSTANCE, so every device had a private counter. Cell 1
 * runs three devices plus a gateway heartbeat under one edge node, and four private counters
 * interleaving into one sequence is not a race but a corrupted stream: the daemon sees 41, 12, 42,
 * 13, concludes a message was dropped, and asks for a rebirth -- correctly, on a fleet that had
 * lost nothing.
 *
 * These tests pin the SHAPE of the fix rather than the storage detail: what matters is that
 * publishers under one gateway produce one unbroken run, and that publishers under different
 * gateways do not touch each other's.
 */
describe('the sequence belongs to the edge node, not the device', () => {
  const seqOf = (dev) => {
    let msg = null
    for (let i = 0; i < 40 && msg === null; i++) msg = dev.scan()
    return msg.payload.seq
  }

  it('two devices under one gateway share a single run of numbers', () => {
    const shared = new Map()
    const a = makeDevice(CNC_BODY, cncEnv(), shared)
    const b = makeDevice(CNC_BODY, cncEnv({
      DEVICE_ID: 'dev230000000000400080000', DEVICE_NAME: 'Sim_CNC_Mill_02'
    }), shared)

    // Births first -- both publish unconditionally -- then one further message from each.
    expect(a.scan().payload.seq).toBe(0)
    expect(b.scan().payload.seq).toBe(1)
    expect(seqOf(a)).toBe(2)
    expect(seqOf(b)).toBe(3)

    // Not four counters at 0,0,1,1 -- which is what a per-instance counter produced, and what the
    // daemon reported as 238 gaps in half an hour.
    expect(shared.get(SEQ_KEY)).toBe(4)
  })

  it('a device under a different gateway keeps its own run', () => {
    const shared = new Map()
    const cell1 = makeDevice(CNC_BODY, cncEnv(), shared)
    const cell2 = makeDevice(CNC_BODY, cncEnv({
      GATEWAY_ID: 'gwy130000000000400080000',
      DEVICE_ID: 'dev240000000000400080000',
      DEVICE_NAME: 'Sim_CNC_Mill_03'
    }), shared)

    expect(cell1.scan().payload.seq).toBe(0)
    // Zero, not one: a second edge node is a second sequence. Sharing ONE counter across the fleet
    // would be the same defect in the opposite direction, and the daemon would report gaps on
    // every gateway instead of one.
    expect(cell2.scan().payload.seq).toBe(0)
    expect(shared.get(SEQ_KEY)).toBe(1)
    expect(shared.get('seq_gwy130000000000400080000')).toBe(1)
  })

  it('the gateway heartbeat draws from the same run as its devices', () => {
    const shared = new Map()
    const device = makeDevice(CNC_BODY, cncEnv(), shared)
    const heartbeat = makeDevice(HB_BODY, {}, shared)

    expect(device.scan().payload.seq).toBe(0)
    // The NBIRTH resets the run -- see the next describe -- so this is 0 rather than 1, and the
    // reset lands on the counter the DEVICE is also drawing from. That is the whole point: a birth
    // resynchronises every publisher under the edge node, not just the node itself.
    const birth = heartbeat.run()
    expect(birth.topic).toContain('/NBIRTH/')
    expect(birth.payload.seq).toBe(0)

    // The heartbeat is a publisher under this edge node like any other -- it was one of the four
    // counters that used to interleave -- and the device picks the run up where the heartbeat left
    // it rather than keeping a number of its own.
    expect(heartbeat.run().payload.seq).toBe(1)
    expect(seqOf(device)).toBe(2)
  })
})

/**
 * AN NBIRTH RESTARTS THE RUN AT ZERO, which is the specification and is why the daemon treats a
 * birth as a resynchronisation point rather than checking it. A birth carrying whatever the counter
 * had reached made a rebirth cause the alarm it was sent to clear.
 */
describe('a birth resynchronises the sequence', () => {
  it('the first heartbeat is an NBIRTH at zero, and the next an NDATA at one', () => {
    const shared = new Map()
    const heartbeat = makeDevice(HB_BODY, {}, shared)

    const birth = heartbeat.run()
    expect(birth.topic).toBe('spBv1.0/ACS-Cymru/NBIRTH/gwy120000000000400080000')
    expect(birth.payload.seq).toBe(0)

    const data = heartbeat.run()
    expect(data.topic).toContain('/NDATA/')
    expect(data.payload.seq).toBe(1)
  })

  it('an NBIRTH resets a run already in progress, rather than continuing it', () => {
    const shared = new Map()
    shared.set(SEQ_KEY, 200)
    const heartbeat = makeDevice(HB_BODY, {}, shared)

    expect(heartbeat.run().payload.seq).toBe(0)
    expect(shared.get(SEQ_KEY)).toBe(1)
  })

  it('a DBIRTH consumes a number and does NOT reset, because only the node births', () => {
    const shared = new Map()
    shared.set(SEQ_KEY, 42)
    const device = makeDevice(CNC_BODY, cncEnv(), shared)

    const birth = device.scan()
    expect(birth.topic).toContain('/DBIRTH/')
    // 42, not 0. A device announcing itself is not the edge node resynchronising, and treating it
    // as one would make every BIRTH_EVERY_SCANS cycle look like a fresh run to the daemon.
    expect(birth.payload.seq).toBe(42)
    expect(shared.get(SEQ_KEY)).toBe(43)
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

  it('BIRTHS FIRST, so the device is registered before it reports', () => {
    // THE BUG THIS PINS. This node used to emit DDATA and nothing else -- no DBIRTH, ever. Its
    // telemetry landed in the historian while the device sat OFFLINE on the shopfloor map with no
    // asset_config rows and no declared metric set, because ONLINE, the birth parameters and
    // unmodelled detection are all keyed off an announcement it never made.
    const agg = makeDevice(OEE_BODY, oeeEnv)
    const first = agg.scan(60000)

    expect(first.topic).toBe('spBv1.0/ACS-Cymru/DBIRTH/gwy140000000000400080000/dev250000000000400080000')
    // Identity metrics ride along exactly as they do on the instrument subflows -- Asset_ID is
    // what lets the daemon catch a device publishing under an identity that is not its own.
    expect(metricNames(first)).toEqual(
      ['Asset_ID', 'Asset_Name', 'OEE/AVAILABILITY', 'OEE/OEE', 'OEE/PERFORMANCE', 'OEE/QUALITY']
    )
    expect(metricByName(first, 'Asset_ID').string_value).toBe('dev250000000000400080000')
    expect(metricByName(first, 'Asset_Name').string_value).toBe('Sim_Cell3_Aggregator')
  })

  it('publishes the four registered KPI names on the DDATA that follows', () => {
    const agg = makeDevice(OEE_BODY, oeeEnv)
    agg.scan(60000)                      // the birth
    const msg = agg.scan(60000)

    expect(msg.topic).toContain('/DDATA/')
    expect(metricNames(msg)).toEqual(
      ['OEE/AVAILABILITY', 'OEE/OEE', 'OEE/PERFORMANCE', 'OEE/QUALITY']
    )
  })

  it('does not bill the first tick as a whole elapsed interval', () => {
    // The inject fires 0.1s after start, then every 60s. Crediting the first tick with a full
    // minute books observation time that has not happened -- and since availability is
    // productive/total, it lands in a denominator this node can never work off.
    const shared = new Map()
    const agg = makeDevice(OEE_BODY, oeeEnv, shared)
    shared.set('state_dev220000000000400080000', 'ACTIVE')

    agg.scan(60000)                      // birth: accumulates nothing
    const first = metricByName(agg.scan(60000), 'OEE/AVAILABILITY').double_value

    // One elapsed interval, all of it productive, so availability is a clean 100 -- not 50, which
    // is what a phantom first interval in the denominator would produce.
    expect(first).toBeCloseTo(100, 5)
  })

  it('re-births periodically so a restarted ingestion service recovers the metric set', () => {
    const agg = makeDevice(OEE_BODY, { ...oeeEnv, BIRTH_EVERY_SCANS: 15 })
    const topics = []
    for (let i = 0; i < 31; i++) topics.push(agg.scan(60000).topic)

    const births = topics.filter(t => t.includes('/DBIRTH/'))
    // Ticks 1, 15 and 30 -- a birth every 15 minutes at a 60s cadence, matching the instrument
    // subflows' own 15-minute rebirth.
    expect(births).toHaveLength(3)
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

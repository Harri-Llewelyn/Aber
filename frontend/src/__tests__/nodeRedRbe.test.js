/**
 * Report-by-exception behaviour of the Gateway Simulator flow.
 *
 * WHY THIS IS TESTED FROM THE FRONTEND SUITE. `node_red_flow.json` is seeded into Node-RED by
 * scripts/node-red-init.mjs and its function nodes are never imported by anything — so nothing
 * else in this repository can notice when one of them regresses. They are plain JavaScript
 * bodies, and vitest is the only JavaScript runner here, so this is where they can be executed.
 * Each node is evaluated with its Node-RED contract supplied explicitly: `global` context, `node`,
 * `msg`, and a controllable `Date` so a scan schedule can be simulated without waiting for one.
 *
 * WHAT IS BEING PINNED. The flow used to publish all six metrics every five seconds on a timer,
 * with `seq: Math.floor(Math.random() * 255)`. That is not DDATA — Sparkplug B DDATA means "these
 * metrics changed", and a fixed-interval full payload writes a row per metric per tick into the
 * historian for readings nobody took. The properties below are the ones that make it RBE, and
 * every one of them is invisible to an end-to-end run: a timer-driven flow and an RBE flow both
 * look like "telemetry is arriving".
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

/** A Node-RED runtime just real enough for these function bodies, with a clock we control. */
function makeRuntime () {
  const store = new Map()
  const clock = { now: 1786284000000 }
  const context = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) }
  const run = (id, msg = {}) =>
    new Function('global', 'node', 'msg', 'Date', nodes[id].func)(
      context, { warn: () => {}, error: () => {} }, msg, { now: () => clock.now }
    )
  return {
    context,
    clock,
    run,
    /** Run the DDATA builder once and return its decoded payload, or null if it stayed silent. */
    scan (advanceMs = SCAN_MS) {
      clock.now += advanceMs
      const out = run('build-ddata-payload')
      return out === null ? null : JSON.parse(out.payload)
    },
    /** Pin every reading, so nothing can move and only RBE decides whether to publish. */
    freeze () {
      store.set('temp_override', 42.0)
      store.set('displacement_override', 1.45)
      store.set('status_override', 'ACTIVE')
      store.set('safety_override', true)
    }
  }
}

let rt
beforeEach(() => {
  rt = makeRuntime()
  rt.run('build-nbirth-payload')
  rt.run('build-dbirth-payload')
})

describe('DBIRTH declares the baseline', () => {
  it('declares every metric the device reports in DDATA', () => {
    // Sparkplug B requires the birth certificate to declare the whole metric dictionary. A DDATA
    // metric that was never declared cannot be resolved by a consumer holding only an alias.
    const birth = JSON.parse(rt.run('build-dbirth-payload').payload)
    const declared = new Set(birth.metrics.map((m) => m.name))
    for (const name of ['Systems/TEMPERATURE', 'Axes/DISPLACEMENT',
      'Controller/EXECUTION', 'Controller/EMERGENCY_STOP']) {
      expect(declared, `DBIRTH must declare ${name}`).toContain(name)
    }
  })

  it('seeds the RBE cache with exactly the values it published', () => {
    // The birth IS the baseline. If it declares 42.0 while the sensor reads 44.3, the first DDATA
    // after every rebirth is a correction of a number no instrument ever produced.
    const birth = JSON.parse(rt.run('build-dbirth-payload').payload)
    const cache = rt.context.get('rbe_cache')
    for (const metric of birth.metrics) {
      if (!(metric.name in cache)) continue
      const published = metric.double_value !== undefined ? metric.double_value : metric.string_value
      expect(cache[metric.name].v).toBe(published)
    }
  })

  it('publishes nothing on the scan immediately after a birth', () => {
    rt.freeze()
    rt.run('build-dbirth-payload')
    expect(rt.scan()).toBeNull()
  })
})

describe('DDATA publishes only on exception', () => {
  it('stays completely silent while nothing changes', () => {
    // THE PROPERTY THE WHOLE AUDIT TURNED ON. Under the old flow this would have been 120
    // messages and 720 historian rows.
    rt.freeze()
    rt.scan()
    for (let i = 0; i < 50; i++) expect(rt.scan()).toBeNull()
  })

  it('carries only the metric that moved, not the whole dictionary', () => {
    rt.freeze()
    rt.scan()
    rt.context.set('status_override', 'INTERRUPTED')
    const payload = rt.scan()
    expect(payload.metrics.map((m) => m.name)).toEqual(['Controller/EXECUTION'])
    expect(payload.metrics[0].string_value).toBe('INTERRUPTED')
  })

  it('suppresses analogue movement inside the deadband', () => {
    // A deadband below the instrument's noise floor makes RBE decorative: the last digit dithers
    // and republishes forever. 0.2 degC is under the 0.5 degC band.
    rt.freeze()
    rt.scan()
    rt.context.set('temp_override', 42.2)
    expect(rt.scan()).toBeNull()
  })

  it('reports analogue movement beyond the deadband', () => {
    rt.freeze()
    rt.scan()
    rt.context.set('temp_override', 44.0)
    const payload = rt.scan()
    expect(payload.metrics.map((m) => m.name)).toEqual(['Systems/TEMPERATURE'])
    expect(payload.metrics[0].double_value).toBe(44.0)
  })

  it('applies no deadband to a discrete state', () => {
    // ARMED -> TRIGGERED is not a small change, and there is no numeric distance to compare.
    rt.freeze()
    rt.scan()
    rt.context.set('safety_override', false)
    expect(rt.scan().metrics.map((m) => m.name)).toEqual(['Controller/EMERGENCY_STOP'])
  })

  it('does not republish a value that moved and came back inside the band', () => {
    rt.freeze()
    rt.scan()
    rt.context.set('temp_override', 42.3)
    expect(rt.scan()).toBeNull()
    rt.context.set('temp_override', 42.0)
    expect(rt.scan()).toBeNull()
  })

  it('carries no identity metrics', () => {
    // Asset_ID/Asset_Name are immutable, declared in DBIRTH, and discarded by ingestion.py's
    // IDENTITY_METRICS filter before reaching the historian. The topic is what identifies
    // the asset.
    rt.freeze()
    rt.scan()
    rt.context.set('status_override', 'STOPPED')
    const names = rt.scan().metrics.map((m) => m.name)
    expect(names).not.toContain('Asset_ID')
    expect(names).not.toContain('Asset_Name')
  })
})

describe('the keepalive bounds how long silence can last', () => {
  it('republishes an unchanged metric within five minutes', () => {
    // RBE without a keepalive is unsafe to consume: a constant value is indistinguishable from a
    // dead device, and every staleness check downstream reads absence as failure.
    rt.freeze()
    rt.scan()
    let elapsed = 0
    let payload = null
    while (elapsed < 400000 && payload === null) {
      payload = rt.scan()
      elapsed += SCAN_MS
    }
    expect(payload, 'a frozen metric must still be refreshed').not.toBeNull()
    expect(elapsed).toBeGreaterThan(240000)
    expect(elapsed).toBeLessThanOrEqual(305000)
  })
})

describe('the Sparkplug sequence number', () => {
  const seqOf = (out) => JSON.parse(out.payload).seq

  it('starts an NBIRTH at zero', () => {
    expect(seqOf(rt.run('build-nbirth-payload'))).toBe(0)
  })

  it('increments by exactly one across every message the node sends', () => {
    // It was Math.random(), which is not a sequence. Under RBE it is the ONLY evidence a consumer
    // has that a change went missing, because an unchanged metric and an undelivered one look
    // identical from the outside.
    rt.run('build-nbirth-payload')
    const seen = [seqOf(rt.run('build-dbirth-payload'))]
    seen.push(seqOf(rt.run('build-heartbeat-payload')))
    for (let i = 0; i < 30; i++) {
      rt.context.set('temp_override', 50 + i * 3)
      const payload = rt.scan()
      if (payload) seen.push(payload.seq)
    }
    expect(seen.length).toBeGreaterThan(10)
    seen.forEach((s, i) => {
      if (i > 0) expect(s).toBe((seen[i - 1] + 1) % 256)
    })
  })

  it('stays within one byte and wraps through zero', () => {
    rt.run('build-nbirth-payload')
    const seen = []
    for (let i = 0; i < 300; i++) seen.push(seqOf(rt.run('build-heartbeat-payload')))
    expect(seen.every((s) => Number.isInteger(s) && s >= 0 && s <= 255)).toBe(true)
    expect(seen).toContain(0)
  })

  it('does not consume a sequence number for a suppressed scan', () => {
    // A suppressed sample is not a message. Burning a seq for it would look to the ingestion
    // daemon exactly like the message it never sent having been lost.
    rt.freeze()
    rt.scan()
    const before = seqOf(rt.run('build-heartbeat-payload'))
    for (let i = 0; i < 10; i++) expect(rt.scan()).toBeNull()
    expect(seqOf(rt.run('build-heartbeat-payload'))).toBe((before + 1) % 256)
  })
})

describe('lifecycle transitions reset the baseline', () => {
  it('an NBIRTH clears the cache so every metric is restated', () => {
    // An NBIRTH voids all prior state for the node and its devices. A cache surviving it would
    // suppress metrics as "unchanged since before the birth" from a consumer that has never
    // seen them.
    rt.freeze()
    rt.scan()
    expect(rt.scan()).toBeNull()
    rt.run('build-nbirth-payload')
    expect(rt.context.get('rbe_cache')).toEqual({})
    expect(rt.scan().metrics).toHaveLength(4)
  })

  it('a DDEATH clears the cache and silences DDATA', () => {
    rt.freeze()
    rt.scan()
    rt.run('build-ddeath-payload')
    expect(rt.context.get('rbe_cache')).toEqual({})
    expect(rt.scan()).toBeNull()
  })
})

describe('the alarm test buttons flow through the change detector', () => {
  it('publishes the overheat condition on the next scan', () => {
    rt.freeze()
    rt.scan()
    rt.run('build-alert-payload')
    const byName = Object.fromEntries(rt.scan().metrics.map((m) => [m.name, m]))
    expect(byName['Systems/TEMPERATURE'].double_value).toBe(95.0)
    expect(byName['Controller/EMERGENCY_STOP'].string_value).toBe('TRIGGERED')
  })

  it('leaves the cache in step, so the alarm is not re-sent every scan', () => {
    // The alarm node used to publish its own payload directly, which left the RBE cache stale
    // behind it -- the next scan then re-sent all four metrics as though they had just moved.
    rt.freeze()
    rt.scan()
    rt.run('build-alert-payload')
    expect(rt.scan()).not.toBeNull()
    expect(rt.scan()).toBeNull()
  })

  it('restores an EXECUTION value the MTConnect vocabulary actually contains', () => {
    // The reset node used to set 'RUNNING' while the payload it published alongside said
    // 'ACTIVE'. 'RUNNING' is not in the seeded EXECUTION vocabulary (0002_seed_data.sql), so
    // after one press every EXECUTION reading was Unmodelled.
    rt.freeze()
    rt.scan()
    rt.run('build-alert-payload')
    rt.scan()
    rt.run('reset-alert-function')
    const byName = Object.fromEntries(rt.scan().metrics.map((m) => [m.name, m]))
    expect(byName['Controller/EXECUTION'].string_value).toBe('ACTIVE')
    expect(byName['Controller/EMERGENCY_STOP'].string_value).toBe('ARMED')
  })
})

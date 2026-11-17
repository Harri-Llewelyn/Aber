import { describe, it, expect } from 'vitest'
import {
  DISK_FREE_DANGER_BYTES, DISK_FREE_WARN_BYTES, HEALTH_ALL_CLEAR, HEALTH_NO_FIGURES, TONE_DANGER, TONE_WARNING,
  foldHealthRows, gatewayHealthProblems, healthSummary, rowTone,
} from '../utils/gatewayHealth'

/**
 * What a gateway's health rows say is wrong: one answer that a row's colour and the closed Health
 * block's summary both read.
 */

const NOW = Date.parse('2026-11-16T12:00:00Z')
const daysFromNow = (d) => new Date(NOW + d * 86_400_000).toISOString()
const GIB = 1024 ** 3

/** A healthy appliance: nothing to name. */
const healthy = (extra = {}) => ({
  cert_expires_at: daysFromNow(400),
  disk_free_bytes: 50 * GIB,
  mem_available_bytes: 2 * GIB,
  load_1m: 0.4,
  flow_hash: 'a'.repeat(64),
  forge_head_sha: 'b'.repeat(40),
  forge_head_flow_sha256: 'a'.repeat(64),
  forge_head_at: daysFromNow(-1),
  forge_appliance_platform_tag: 'v1.2.0',
  forge_appliance_platform_outcome: 'converged',
  forge_appliance_custom_outcome: 'ok',
  ...extra,
})

const problems = (gateway, options) => gatewayHealthProblems(gateway, { now: NOW, ...options })
const texts = (gateway, options) => problems(gateway, options).map(p => `${p.tone}: ${p.text}`)

describe('gatewayHealthProblems', () => {
  it('names nothing for a healthy appliance, and nothing for figures it has not reported', () => {
    expect(problems(healthy())).toEqual([])
    expect(problems({})).toEqual([])
    expect(problems(null)).toEqual([])
  })

  it('names a CA that has expired, expires today, or expires inside the alert\'s 30 days', () => {
    expect(texts(healthy({ cert_expires_at: daysFromNow(-3) }))).toEqual(['danger: CA expired'])
    expect(texts(healthy({ cert_expires_at: daysFromNow(0.4) }))).toEqual(['danger: CA expires today'])
    expect(texts(healthy({ cert_expires_at: daysFromNow(12) }))).toEqual(['danger: CA expires in 12d'])
    expect(problems(healthy({ cert_expires_at: daysFromNow(31) }))).toEqual([])
  })

  it('names a CA behind the root the platform publishes, beyond a day\'s tolerance', () => {
    const held = healthy({ cert_expires_at: daysFromNow(100) })
    expect(texts(held, { rootNotAfter: daysFromNow(400) })).toEqual(['danger: CA holds an older root'])
    expect(problems(held, { rootNotAfter: daysFromNow(100.5) })).toEqual([])
    expect(problems(held, { rootNotAfter: null })).toEqual([])
  })

  it('names the disk as the Fleet Health dashboard does: red under 1 GiB, amber under 5 GiB', () => {
    expect(texts(healthy({ disk_free_bytes: 0.5 * GIB }))).toEqual(['danger: Disk 512.0 MiB free'])
    expect(texts(healthy({ disk_free_bytes: DISK_FREE_DANGER_BYTES }))).toEqual(['warning: Disk 1.0 GiB free'])
    expect(texts(healthy({ disk_free_bytes: 4.9 * GIB }))).toEqual(['warning: Disk 4.9 GiB free'])
    expect(problems(healthy({ disk_free_bytes: DISK_FREE_WARN_BYTES }))).toEqual([])
    // A reading of zero is a real one, and the worst.
    expect(texts(healthy({ disk_free_bytes: 0 }))).toEqual(['danger: Disk 0 B free'])
  })

  it('never names memory or load, which carry no threshold anywhere', () => {
    expect(problems(healthy({ mem_available_bytes: 1, load_1m: 400 }))).toEqual([])
  })

  it('names a flow that differs from main past the grace period, and not one that is deploying', () => {
    const differs = { flow_hash: 'c'.repeat(64) }
    expect(texts(healthy({ ...differs, forge_head_at: daysFromNow(-1) }))).toEqual(['danger: Flow differs from main'])
    expect(problems(healthy({ ...differs, forge_head_at: new Date(NOW - 60_000).toISOString() }))).toEqual([])
  })

  it('names a convergence that did not converge, and a custom playbook that failed', () => {
    expect(texts(healthy({ forge_appliance_platform_outcome: 'failed' }))).toEqual(['danger: Platform failed'])
    expect(texts(healthy({ forge_appliance_custom_outcome: 'failed' }))).toEqual(['danger: Custom playbook failed'])
    expect(problems(healthy({ forge_appliance_platform_outcome: null, forge_appliance_custom_outcome: null }))).toEqual([])
  })

  it('puts danger before warning, and keeps the drawer\'s order within a tone', () => {
    const all = healthy({
      disk_free_bytes: 3 * GIB, cert_expires_at: daysFromNow(2), forge_appliance_custom_outcome: 'failed',
      forge_appliance_platform_outcome: 'failed',
    })
    expect(texts(all)).toEqual(['danger: CA expires in 2d', 'danger: Platform failed', 'danger: Custom playbook failed', 'warning: Disk 3.0 GiB free'])
  })

  it('answers rowTone for the row it names and for none other', () => {
    const found = problems(healthy({ disk_free_bytes: 3 * GIB, forge_appliance_custom_outcome: 'failed' }))
    expect(rowTone(found, 'Disk Free')).toBe(TONE_WARNING)
    expect(rowTone(found, 'Custom')).toBe(TONE_DANGER)
    expect(rowTone(found, 'Flow')).toBeUndefined()
  })
})

describe('healthSummary', () => {
  const rows = (...labels) => labels.map(label => ({ label, value: '1' }))

  it('names the worst state, and how many more there are', () => {
    const found = problems(healthy({ disk_free_bytes: 3 * GIB, forge_appliance_custom_outcome: 'failed', cert_expires_at: daysFromNow(-1) }))
    expect(healthSummary(found, rows('CA Expires', 'Disk Free', 'Custom'))).toEqual({ text: 'CA expired and 2 more', tone: TONE_DANGER })
    expect(healthSummary(found.slice(2), rows('Disk Free'))).toEqual({ text: 'Disk 3.0 GiB free', tone: TONE_WARNING })
  })

  it('leaves out a problem in a row the block does not hold', () => {
    const found = problems(healthy({ disk_free_bytes: 3 * GIB }))
    expect(healthSummary(found, rows('CA Expires'))).toEqual({ text: HEALTH_ALL_CLEAR, tone: undefined })
  })

  it('says nothing needs attention, or that no figure was reported', () => {
    expect(healthSummary([], rows('Disk Free'))).toEqual({ text: HEALTH_ALL_CLEAR, tone: undefined })
    expect(healthSummary([], [{ label: 'Disk Free', value: null }, { label: 'Flow', value: '' }])).toEqual({ text: HEALTH_NO_FIGURES, tone: undefined })
  })
})

describe('foldHealthRows', () => {
  const field = (label, extra = {}) => ({ label, value: 'x', ...extra })

  it('folds the rows marked health into one group where the first stood, keeping the others in order', () => {
    const folded = foldHealthRows(
      [field('Uptime'), field('CA Expires', { health: true }), field('Disk Free', { health: true }), field('Description')],
      [], 'gateway-health-1'
    )
    expect(folded.map(f => f.group || f.label)).toEqual(['Uptime', 'Health', 'Description'])
    expect(folded[1]).toMatchObject({ id: 'gateway-health-1', summary: HEALTH_ALL_CLEAR })
    expect(folded[1].fields.map(f => f.label)).toEqual(['CA Expires', 'Disk Free'])
  })

  it('returns the fields as they were when none is marked, so a kind with no health rows has no block', () => {
    const fields = [field('Uptime'), field('Description')]
    expect(foldHealthRows(fields, [], 'id')).toBe(fields)
  })
})

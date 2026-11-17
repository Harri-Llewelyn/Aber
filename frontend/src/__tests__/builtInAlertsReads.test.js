/**
 * What the Built-in tab reads and how it says it: the firing alerts that have a rule uid, a rule's
 * newest occurrences, and the words of a hold, a state and an evaluation error. A failed read throws,
 * so the tab says it does not know instead of calling every rule quiet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const asked = []
let answer = { data: [], error: null }

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'https://api.site.test',
  SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
  supabase: {
    auth: { getSession: vi.fn() },
    from: (table) => {
      const call = { table, calls: [] }
      asked.push(call)
      const chain = new Proxy({}, {
        get: (_, method) => {
          if (method === 'then') return (resolve, reject) => Promise.resolve(answer).then(resolve, reject)
          return (...args) => { call.calls.push([method, ...args]); return chain }
        },
      })
      return chain
    },
  },
}))

const { api, BUILT_IN_OCCURRENCE_LIMIT } = await import('../api')
const { NOT_EVALUATED_NAMES, builtInRule, builtInStates, holdWords, isNotEvaluated, labelsText, occurrenceSubject } = await import('../utils/builtInAlerts')

beforeEach(() => {
  asked.length = 0
  answer = { data: [], error: null }
})

describe('api.readBuiltInAlerts', () => {
  it('reads the open alerts that have a rule uid, an acknowledged or suppressed one included', async () => {
    answer = { data: [{ id: 'a1', rule_uid: 'aber-gateway-stale' }], error: null }
    await expect(api.readBuiltInAlerts()).resolves.toEqual([{ id: 'a1', rule_uid: 'aber-gateway-stale' }])
    expect(asked).toHaveLength(1)
    expect(asked[0].table).toBe('platform_alerts_active')
    expect(asked[0].calls.find(c => c[0] === 'select')[1]).toContain('rule_uid, labels')
    expect(asked[0].calls).toContainEqual(['not', 'rule_uid', 'is', null])
  })

  it('throws what the database said, so the tab does not call a rule quiet on a failed read', async () => {
    answer = { data: null, error: { message: 'permission denied' } }
    await expect(api.readBuiltInAlerts()).rejects.toThrow('permission denied')
  })
})

describe('api.readBuiltInOccurrences', () => {
  it('reads one rule\'s newest rows, newest first, and no more than the drawer lists', async () => {
    answer = { data: [{ id: 'o1' }], error: null }
    await expect(api.readBuiltInOccurrences('aber-backup-stale')).resolves.toEqual([{ id: 'o1' }])
    expect(asked[0].table).toBe('platform_alerts')
    expect(asked[0].calls).toContainEqual(['eq', 'rule_uid', 'aber-backup-stale'])
    expect(asked[0].calls).toContainEqual(['order', 'starts_at', { ascending: false }])
    expect(asked[0].calls).toContainEqual(['limit', BUILT_IN_OCCURRENCE_LIMIT])
  })

  it('throws what the database said', async () => {
    answer = { data: null, error: { message: 'timeout' } }
    await expect(api.readBuiltInOccurrences('aber-backup-stale')).rejects.toThrow('timeout')
  })
})

describe('the state of a rule', () => {
  const row = (uid, labels = {}) => ({ rule_uid: uid, labels })

  it('counts the firing instances and the evaluation errors of each rule apart', () => {
    const states = builtInStates([
      row('aber-gateway-stale', { alertname: 'Gateway Stale' }),
      row('aber-gateway-stale', { alertname: 'Gateway Stale' }),
      row('aber-backup-stale', { alertname: 'DatasourceError', rulename: 'Backup Stale' }),
      row('aber-job-failed', { alertname: 'DatasourceNoData' }),
      row('aber-job-failed', { alertname: 'Capture or Playback Failed' }),
      { rule_uid: null, labels: {} },
    ])
    expect(Object.fromEntries(states)).toEqual({
      'aber-gateway-stale': { firing: 2, notEvaluated: 0 },
      'aber-backup-stale': { firing: 0, notEvaluated: 1 },
      'aber-job-failed': { firing: 1, notEvaluated: 1 },
    })
  })

  it('leaves a rule with no open row out, which is not firing and is never said to be OK', () => {
    expect(builtInStates([]).size).toBe(0)
    expect(builtInStates(undefined).size).toBe(0)
  })

  it('tells an evaluation error by the label Grafana gives it', () => {
    expect(NOT_EVALUATED_NAMES).toEqual(['DatasourceError', 'DatasourceNoData'])
    expect(isNotEvaluated(row('x', { alertname: 'DatasourceError' }))).toBe(true)
    expect(isNotEvaluated(row('x', { alertname: 'Backup Stale' }))).toBe(false)
    // A row from before labels were kept has none, and is a condition.
    expect(isNotEvaluated({ labels: null })).toBe(false)
    expect(isNotEvaluated(null)).toBe(false)
  })
})

describe('the words', () => {
  it('says a hold as a person would, and None for no hold', () => {
    expect(holdWords('5m')).toBe('5 min')
    expect(holdWords('1h')).toBe('1 h')
    expect(holdWords('30s')).toBe('30 s')
    expect(holdWords('0s')).toBe('None')
    expect(holdWords('odd')).toBe('odd')
  })

  it('writes labels one to a line, and an occurrence\'s subject as the counter does', () => {
    expect(labelsText({ severity: 'warning', entity_type: 'gateway' })).toBe('severity=warning\nentity_type=gateway')
    expect(occurrenceSubject({ sparkplug_id: 'gw1', entity_type: 'gateway' })).toBe('gw1')
    expect(occurrenceSubject({ entity_type: 'platform' })).toBe('Platform-wide')
    expect(occurrenceSubject({ entity_type: 'service_identity' })).toBe('Machine identity')
  })

  it('finds a rule by its uid, and a rule a site wrote itself is not one', () => {
    expect(builtInRule('aber-gateway-stale')?.title).toBe('Gateway Stale')
    expect(builtInRule('a-site-rule')).toBeNull()
  })
})

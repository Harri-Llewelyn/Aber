/**
 * History's Alerts tab, its arithmetic (utils/alertHistory.js): a row as alert_occurrences()
 * returns it, the overlap rule at the window's edges, the address, the subject, the words, and the
 * sort. In London's zone.
 */
import { describe, it, expect, afterAll } from 'vitest'
import {
  ALERTS_PATH, ALERT_RETENTION_DAYS, ALERT_SORT, acknowledgerName, alertSubject, alertsAddress, assetOptions,
  lengthText, occurrenceMatches, occurrenceMs, occurrenceRow, overlapsWindow, retentionWords, severityOf, subjectIndex,
} from '../utils/alertHistory'
import { DEFAULT_HISTORY_WINDOW, HISTORY_RANGES } from '../utils/history'
import { windowFromQuery } from '../utils/timeWindow'
import { sortRows } from '../utils/tableSort'

const MACHINE_TZ = process.env.TZ
process.env.TZ = 'Europe/London'
afterAll(() => {
  if (MACHINE_TZ === undefined) delete process.env.TZ
  else process.env.TZ = MACHINE_TZ
})

const LATHE = '2b3e0c4a-1111-4000-8000-000000000001'
const LATHE_ID = 'dev2b3e0c4a1111400080000'
const GATEWAY = '7c000000-0000-4000-8000-000000000007'
const GATEWAY_ID = 'gwy7c0000000000400080000'

const occurrence = (over = {}) => ({
  id: 'o1', fingerprint: 'fp', entity_type: 'device', entity_id: LATHE, sparkplug_id: LATHE_ID,
  alert_name: 'Spindle Overload', severity: 'warning', status: 'resolved', summary: 'Load over 110 %',
  starts_at: '2026-11-02T10:05:00Z', ends_at: '2026-11-02T10:40:00Z', ...over,
})

const at = (iso) => Date.parse(iso)

describe('a row of alert_occurrences()', () => {
  it('is the occurrence with when it ended, whether it was replaced, and whether it still fires', () => {
    expect(occurrenceRow({ occurrence: occurrence(), ended_at: '2026-11-02T10:40:00Z', replaced: false }))
      .toMatchObject({ id: 'o1', alert_name: 'Spindle Overload', ended_at: '2026-11-02T10:40:00Z', replaced: false, firing: false })
    expect(occurrenceRow({ occurrence: occurrence({ status: 'firing', ends_at: null }), ended_at: null, replaced: false }))
      .toMatchObject({ ended_at: null, firing: true })
    // Firing in the table, but a later occurrence replaced it: over, and not firing.
    expect(occurrenceRow({ occurrence: occurrence({ status: 'firing', ends_at: null }), ended_at: '2026-11-02T11:00:00Z', replaced: true }))
      .toMatchObject({ ended_at: '2026-11-02T11:00:00Z', replaced: true, firing: false })
  })

  it('keeps every column the occurrence has, a later one included', () => {
    const row = occurrenceRow({ occurrence: occurrence({ some_later_column: 'kept' }), ended_at: null, replaced: false })
    expect(row.some_later_column).toBe('kept')
  })
})

describe('the overlap rule, as alert_occurrences() holds it', () => {
  const start = at('2026-11-02T10:00:00Z')
  const end = at('2026-11-02T12:00:00Z')
  const row = (starts, ended) => occurrenceRow({ occurrence: occurrence({ starts_at: starts }), ended_at: ended })

  it('lists one that started in the window, one that ended in it, one still firing and one across it', () => {
    expect(overlapsWindow(row('2026-11-02T10:30:00Z', '2026-11-02T10:40:00Z'), start, end)).toBe(true)
    expect(overlapsWindow(row('2026-11-02T09:00:00Z', '2026-11-02T10:05:00Z'), start, end)).toBe(true)
    expect(overlapsWindow(row('2026-11-02T08:00:00Z', null), start, end)).toBe(true)
    expect(overlapsWindow(row('2026-11-02T09:00:00Z', '2026-11-02T13:00:00Z'), start, end)).toBe(true)
  })

  it('holds the window\'s start and not its end', () => {
    expect(overlapsWindow(row('2026-11-02T10:00:00Z', '2026-11-02T10:01:00Z'), start, end)).toBe(true)
    expect(overlapsWindow(row('2026-11-02T11:59:59Z', '2026-11-02T12:30:00Z'), start, end)).toBe(true)
    expect(overlapsWindow(row('2026-11-02T09:00:00Z', '2026-11-02T10:00:00Z'), start, end)).toBe(false)
    expect(overlapsWindow(row('2026-11-02T12:00:00Z', '2026-11-02T12:10:00Z'), start, end)).toBe(false)
    expect(overlapsWindow(row('2026-11-02T12:00:00Z', null), start, end)).toBe(false)
  })
})

describe('the address', () => {
  it('is /history/alerts, with the window when it is not the default and the assets chosen', () => {
    expect(alertsAddress(DEFAULT_HISTORY_WINDOW)).toBe(ALERTS_PATH)
    expect(alertsAddress({ kind: 'custom', from: '2026-11-02T10:05', to: '2026-11-02T14:20' }, { assets: [LATHE_ID, GATEWAY_ID] }))
      .toBe(`/history/alerts?from=2026-11-02T10%3A05&to=2026-11-02T14%3A20&asset=${LATHE_ID},${GATEWAY_ID}`)
    expect(alertsAddress({ kind: 'calendar', span: 'week', at: '2026-11-02' })).toBe('/history/alerts?span=week&at=2026-11-02')
  })

  it('reads back as the same window and assets', () => {
    for (const win of [
      { kind: 'custom', from: '2026-11-02T10:05', to: '2026-11-02T14:20' },
      { kind: 'calendar', span: 'day', at: '2026-10-25' },
      { kind: 'rolling', range: '7d', ms: 7 * 86400000, label: 'Last 7 days' },
    ]) {
      const query = new URLSearchParams(alertsAddress(win, { assets: [LATHE_ID] }).split('?')[1])
      expect(windowFromQuery(query, { ranges: HISTORY_RANGES, fallback: DEFAULT_HISTORY_WINDOW })).toEqual(win)
      expect(query.get('asset')).toBe(LATHE_ID)
    }
  })
})

describe('what an occurrence is about', () => {
  const index = subjectIndex(
    [{ asset_id: LATHE, asset_name: 'Lathe 3' }],
    [{ gateway_id: GATEWAY, gateway_name: 'Line 4 edge' }],
  )

  it('names a device or a gateway as its page does, by its Sparkplug id', () => {
    expect(alertSubject(occurrence(), index)).toEqual({ kind: 'device', name: 'Lathe 3', sparkplugId: LATHE_ID, known: true, page: null })
    expect(alertSubject(occurrence({ entity_type: 'gateway', sparkplug_id: GATEWAY_ID }), index))
      .toMatchObject({ kind: 'gateway', name: 'Line 4 edge', sparkplugId: GATEWAY_ID, known: true })
  })

  it('falls back to the Sparkplug id for one no row holds', () => {
    expect(alertSubject(occurrence({ sparkplug_id: 'dev999999999999999999999' }), index))
      .toMatchObject({ kind: 'device', name: 'dev999999999999999999999', known: false })
  })

  it('says what a platform or a machine identity\'s alert is about, with its page where it has one', () => {
    expect(alertSubject(occurrence({ entity_type: 'platform', sparkplug_id: null }), index))
      .toEqual({ kind: 'platform', name: 'Platform-wide', sparkplugId: null, known: false, page: null })
    const token = alertSubject(occurrence({ entity_type: 'service_identity', sparkplug_id: null, entity_id: 'p1' }), index)
    expect(token).toMatchObject({ kind: 'service_identity', name: 'Machine identity' })
    expect(token.page.to).toMatch(/^\/access-control\/identities/)
  })
})

describe('the words', () => {
  it('gives a length, "so far" while it fires', () => {
    const now = at('2026-11-02T12:00:00Z')
    const done = occurrenceRow({ occurrence: occurrence(), ended_at: '2026-11-02T10:40:00Z' })
    const firing = occurrenceRow({ occurrence: occurrence({ status: 'firing', ends_at: null }), ended_at: null })
    expect(occurrenceMs(done, now)).toBe(35 * 60000)
    expect(lengthText(done, now)).toBe('35 min')
    expect(lengthText(firing, now)).toBe('1 h 55 min so far')
  })

  it('names each severity and gives it a tone, so it is never colour alone', () => {
    expect(['critical', 'warning', 'info'].map(s => [severityOf(s).label, severityOf(s).tone]))
      .toEqual([['Critical', 'danger'], ['Warning', 'warning'], ['Info', 'info']])
  })

  it('names the acknowledger by the email every reader is shown', () => {
    expect(acknowledgerName({ acknowledged_by_email: 'op@aber.local' })).toBe('op@aber.local')
    expect(acknowledgerName({ acknowledged_by_email: null })).toBe('someone')
  })

  it('says when a window starts before the oldest alert kept, at the seeded 90 days', () => {
    expect(ALERT_RETENTION_DAYS).toBe(90)
    const now = at('2026-11-05T12:00:00Z')
    expect(retentionWords(now - 30 * 86400000, now, 90)).toBeNull()
    expect(retentionWords(now - 91 * 86400000, now, 90)).toBe('Alerts are kept for 90 days, so none older is listed.')
    expect(retentionWords(now - 2 * 86400000, now, 1)).toBe('Alerts are kept for 1 day, so none older is listed.')
    expect(retentionWords(now - 91 * 86400000, now, null)).toBeNull()
  })
})

describe('the search and the Asset filter', () => {
  it('finds an alert by its name, summary, subject, acknowledger or note', () => {
    const row = { ...occurrence(), acknowledged_by_email: 'op@aber.local', acknowledgement_note: 'belt change' }
    const subject = { name: 'Lathe 3', sparkplugId: LATHE_ID }
    for (const text of ['spindle', '110 %', 'lathe', LATHE_ID.slice(0, 8), 'op@', 'BELT', '']) {
      expect(occurrenceMatches(row, subject, text)).toBe(true)
    }
    expect(occurrenceMatches(row, subject, 'press')).toBe(false)
  })

  it('offers the devices and then the gateways, each by name, valued by Sparkplug id', () => {
    expect(assetOptions(
      [{ asset_id: LATHE, asset_name: 'Lathe 3' }, { asset_id: '2b3e0c4a-2222-4000-8000-000000000002', asset_name: 'Drill 1' }],
      [{ gateway_id: GATEWAY, gateway_name: 'Line 4 edge' }],
    )).toEqual([
      { value: 'dev2b3e0c4a2222400080000', label: 'Drill 1', group: 'Devices' },
      { value: LATHE_ID, label: 'Lathe 3', group: 'Devices' },
      { value: GATEWAY_ID, label: 'Line 4 edge', group: 'Gateways' },
    ])
  })
})

describe('the sort', () => {
  const now = at('2026-11-02T12:00:00Z')
  const rows = [
    { ...occurrenceRow({ occurrence: occurrence({ id: 'a', severity: 'info', starts_at: '2026-11-02T11:00:00Z' }), ended_at: '2026-11-02T11:05:00Z' }), now, subject: { name: 'Press' } },
    { ...occurrenceRow({ occurrence: occurrence({ id: 'b', severity: 'critical', status: 'firing', starts_at: '2026-11-02T10:30:00Z' }), ended_at: null }), now, subject: { name: 'Lathe' } },
    { ...occurrenceRow({ occurrence: occurrence({ id: 'c', severity: 'warning', starts_at: '2026-11-02T10:00:00Z' }), ended_at: '2026-11-02T10:10:00Z' }), now, subject: { name: 'Mill' } },
  ]
  const by = (column, descending = false) => sortRows(rows, ALERT_SORT, { column, descending }).map(r => r.id)

  it('ranks severity critical first, and sorts a firing alert as ended now, the latest', () => {
    expect(by('severity')).toEqual(['b', 'c', 'a'])
    expect(by('ended', true)).toEqual(['b', 'a', 'c'])
    expect(by('length', true)).toEqual(['b', 'c', 'a'])
    expect(by('subject')).toEqual(['b', 'c', 'a'])
  })

  it('puts an unacknowledged alert last whichever way Acknowledged sorts', () => {
    const acked = [{ ...rows[0], acknowledged_at: '2026-11-02T11:01:00Z', acknowledged_by_email: 'op@aber.local' }, rows[1]]
    expect(sortRows(acked, ALERT_SORT, { column: 'acknowledged', descending: false }).map(r => r.id)).toEqual(['a', 'b'])
    expect(sortRows(acked, ALERT_SORT, { column: 'acknowledged', descending: true }).map(r => r.id)).toEqual(['a', 'b'])
  })
})

/**
 * The browser's classifier against the database's, over one fixture, while both exist.
 * `supabase/migrations/test_the_audit_trail_sorts_events_into_classes_in_the_database.py` asserts
 * the same cases against audit_event_class() (0228). `browser` is this copy's answer where it
 * differs on purpose: the four reads, which it drew as a change.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { classifyEvent, diffFields } from '../components/tabs/AuditTrailTab'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-harness', 'fixtures', 'audit-event-classes.json'
)
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

/** The browser's marker keys, as the server's class words. */
const AS_CLASS = { creation: 'created', operational: 'operational', governance: 'configuration', critical: 'lifecycle' }

describe('audit event classes: the browser against audit_event_class()', () => {
  it('reads a fixture that covers every class', () => {
    expect(fixture.cases.length).toBeGreaterThan(40)
    expect(new Set(fixture.cases.map(c => c.class))).toEqual(
      new Set(['created', 'operational', 'configuration', 'lifecycle', 'read']))
  })

  for (const c of fixture.cases) {
    it(c.name, () => {
      const event = {
        event_type: c.action, entity_type: c.entity_type, audit_domain: c.audit_domain,
        old_data: c.old_data, new_data: c.new_data,
      }
      expect(AS_CLASS[classifyEvent(event, diffFields(c.old_data, c.new_data))]).toBe(c.browser ?? c.class)
    })
  }
})

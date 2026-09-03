/**
 * Digital Thread: naming an entity that no longer exists, and the SCHEMA_REJECTION event class.
 *
 * WHY THE NAMING HALF MATTERS. `digital_thread` holds only `entity_id` -- names live on the entity
 * and carry no identity of their own -- so the page joins client-side against the live cell,
 * gateway and device lists. That join CANNOT resolve a hard-purged entity, and hard purge is a
 * shipped feature: the Archives tab offers it, and archived migration 0003 is what makes it safe, because
 * audit rows are immutable and independent of the row they describe.
 *
 * So the rows most worth reading are precisely the ones the join fails on. The fallback reads the
 * identity back out of the audit payload -- `name` first, then the immutable `sparkplug_id`, which
 * is what the historian keyed telemetry by and what every Grafana alert about the asset names.
 *
 * THE CSV EXPORT IS TESTED SEPARATELY FROM THE LANE LABEL because they were not the same code and
 * only one of them worked: the lane fell back to the snapshot while the export wrote an empty
 * `entity_name` for every purged entity, which is the column an auditor opens the file for.
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import {
  snapshotIdentity,
  resolveLaneName,
  classifyEvent,
  diffFields,
} from '../components/tabs/DigitalThreadTab'

const purgedDeviceDelete = {
  event_id: 9, entity_type: 'devices', entity_id: 'dev-gone', event_type: 'DELETE',
  timestamp: '2026-08-02T12:00:00Z',
  old_data: { id: 'dev-gone', name: 'Press_02', sparkplug_id: 'dev' + '2'.repeat(21) },
  new_data: null,
}

describe('snapshotIdentity', () => {
  it('prefers the recorded name, which is what an operator remembers', () => {
    expect(snapshotIdentity(purgedDeviceDelete)).toEqual({ label: 'Press_02', field: 'name' })
  })

  it('falls back to sparkplug_id when the snapshot carries no name', () => {
    const wireId = 'dev' + '7'.repeat(21)
    const event = { old_data: { sparkplug_id: wireId }, new_data: null }
    expect(snapshotIdentity(event)).toEqual({ label: wireId, field: 'sparkplug_id' })
  })

  it('reads new_data for an INSERT, which has no old_data at all', () => {
    const event = { new_data: { name: 'Freshly_Provisioned' }, old_data: null }
    expect(snapshotIdentity(event)).toEqual({ label: 'Freshly_Provisioned', field: 'name' })
  })

  it('returns null for a cell, which has no second identity to recover', () => {
    // Not a gap: cells carry no sparkplug_id, so a shortened uuid is genuinely the best available
    // answer and the caller must be told to use it rather than handed a misleading label.
    expect(snapshotIdentity({ old_data: { id: 'cell-1' }, new_data: null })).toBeNull()
  })

  it('survives an event with no snapshots on either side', () => {
    expect(snapshotIdentity({})).toBeNull()
    expect(snapshotIdentity(null)).toBeNull()
  })
})

describe('resolveLaneName', () => {
  const live = new Map([['dev-1', 'Simulated_CNC_01']])

  it('prefers the live join, so a renamed entity shows its CURRENT name', () => {
    const stale = {
      entity_id: 'dev-1', old_data: { name: 'Old_Name' }, new_data: { name: 'Old_Name' },
    }
    expect(resolveLaneName('dev-1', [stale], live))
      .toEqual({ name: 'Simulated_CNC_01', fromSnapshot: false })
  })

  it('recovers a purged entity from its audit snapshot and says where the name came from', () => {
    const resolved = resolveLaneName('dev-gone', [purgedDeviceDelete], live)
    expect(resolved.name).toBe('Press_02')
    expect(resolved.fromSnapshot).toBe(true)
    expect(resolved.identityField).toBe('name')
  })

  it('recovers a purged entity by wire identity when no snapshot carried a name', () => {
    const wireId = 'dev' + '9'.repeat(21)
    const event = { entity_id: 'dev-x', old_data: { sparkplug_id: wireId }, new_data: null }
    const resolved = resolveLaneName('dev-x', [event], live)
    expect(resolved.name).toBe(wireId)
    expect(resolved.identityField).toBe('sparkplug_id')
  })

  it('reports no name when neither the join nor any snapshot can supply one', () => {
    const resolved = resolveLaneName('cell-gone', [{ old_data: {}, new_data: null }], live)
    expect(resolved).toEqual({ name: null, fromSnapshot: false })
  })
})

describe('SCHEMA_REJECTION events', () => {
  /**
   * Written by record_ingestion_rejection() (archived migration 0026), NOT by the audit trigger -- so it is
   * the first `action` value that is not a TG_OP, and the first row in the table that records an
   * observation rather than a row mutation.
   */
  const rejection = {
    event_id: 11, entity_type: 'devices', entity_id: 'dev-1', event_type: 'SCHEMA_REJECTION',
    timestamp: '2026-08-21T09:30:00Z',
    actor_source: 'ingestion',
    changed_by: null,
    old_data: null,
    new_data: {
      name: 'Simulated_CNC_01',
      sparkplug_id: 'dev' + '2'.repeat(21),
      observed_at: '2026-08-21T09:30:00Z',
      violation_count: 1,
      violations: [{ metric: 'Rogue/Metric', code: 'unmodelled_metric', dropped: false }],
      truncated: false,
    },
  }

  it('classifies as governance rather than operational', () => {
    // It says the asset is publishing something its declared model does not account for, which is
    // the same category as a schema being rebound. Falling through to `operational` -- which it
    // would, since no GOVERNANCE_FIELDS key appears in the payload -- paints a conformance breach
    // the same colour as a routine status change.
    expect(classifyEvent(rejection, diffFields(null, rejection.new_data))).toBe('governance')
  })

  it('is not classified as a lifecycle event', () => {
    // `critical` is reserved for deleted / archived / quarantined. A non-conforming payload is a
    // finding about what a running device sends, not a change to whether it exists.
    expect(classifyEvent(rejection, diffFields(null, rejection.new_data))).not.toBe('critical')
  })

  it('renders as a one-sided snapshot carrying the violation detail', () => {
    const diff = diffFields(rejection.old_data, rejection.new_data)
    const fields = diff.map(d => d.field)

    expect(fields).toContain('violations')
    expect(fields).toContain('violation_count')
    // `old_data` is NULL by construction, so every entry is an "after" with nothing before it.
    expect(diff.every(d => d.before === undefined)).toBe(true)
  })

  it('keeps the identity that was current when the payload was refused', () => {
    // The row names the device as it was AT THE TIME, so a later rename or purge does not make the
    // finding unreadable -- the same reason the purge fallback above exists.
    expect(snapshotIdentity(rejection)).toEqual({ label: 'Simulated_CNC_01', field: 'name' })
  })
})

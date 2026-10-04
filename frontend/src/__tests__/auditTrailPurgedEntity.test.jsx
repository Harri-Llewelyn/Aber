/**
 * Audit Trail: naming an entity the live lookups cannot, and the SCHEMA_REJECTION event class.
 * `audit_trail` holds only `entity_id`, so the page joins client-side against the live lists,
 * and that join cannot resolve a hard-purged entity -- nor one of a kind nothing fetches at all.
 * The fallback reads an ordered list of identity fields out of the audit payload, SHARED WITH
 * `audit_trail_page()`'s `p_search`: a field in one and not the other is a lane you can
 * see and cannot search for, or a row you can find and cannot identify. The CSV export is tested
 * separately from the lane label because they are separate code.
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import {
  snapshotIdentity,
  resolveLaneName,
  classifyEvent,
  diffFields,
} from '../components/tabs/AuditTrailTab'

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

  /* THE SECURITY AND BACKUP LANES, which drew a bare uuid until these fields were read. None of
     their tables is fetched by the page, so the snapshot is the only thing that can name them --
     and each carries a different key, which is why this is a list rather than two branches. */
  it('names a schema the way the live lookup does, version and all', () => {
    // A lineage shares `schema_name` and differs only in `version`, so dropping it would give a
    // deleted schema a different label from a live one with the same name.
    const event = { new_data: { schema_name: 'VALIDATE_Schema_OEE', version: 3 }, old_data: null }
    expect(snapshotIdentity(event))
      .toEqual({ label: 'VALIDATE_Schema_OEE', qualifier: 'v3', field: 'schema_name' })
  })

  it('names a schema without a version rather than inventing one', () => {
    const event = { new_data: { schema_name: 'Draft_Only' }, old_data: null }
    expect(snapshotIdentity(event))
      .toEqual({ label: 'Draft_Only', qualifier: undefined, field: 'schema_name' })
  })

  it('names a setting by its label, which is the wording the Settings page shows', () => {
    const event = {
      new_data: { key: 'ui.audit_trail_lane_limit', label: 'Lanes drawn before folding' },
      old_data: null,
    }
    expect(snapshotIdentity(event))
      .toEqual({ label: 'Lanes drawn before folding', field: 'label' })
  })

  it('falls back to a setting key when there is no label', () => {
    const event = { new_data: { key: 'ui.audit_trail_poll_seconds' }, old_data: null }
    expect(snapshotIdentity(event))
      .toEqual({ label: 'ui.audit_trail_poll_seconds', field: 'key' })
  })

  it('names a backup by its stamp, which is what the Backups page calls one', () => {
    const event = { new_data: { stamp: '20260912T165851Z', pinned: false }, old_data: null }
    expect(snapshotIdentity(event)).toEqual({ label: '20260912T165851Z', field: 'stamp' })
  })

  it('does NOT name a role assignment by its role', () => {
    /* `user_roles` rows carry a role and the lane is a PERSON, keyed by user_id. Two
       Administrators would draw two lanes with one name, and the label would change under a reader
       as pages arrive, since resolveLaneName() takes whichever event it meets first.
       list_user_accounts() is what names that lane. */
    const event = { new_data: { role: 'Administrator', role_id: 1 }, old_data: null }
    expect(snapshotIdentity(event)).toBeNull()
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
  const live = new Map([['dev-1', { name: 'Simulated_CNC_01' }]])

  it('prefers the live join, so a renamed entity shows its CURRENT name', () => {
    const stale = {
      entity_id: 'dev-1', old_data: { name: 'Old_Name' }, new_data: { name: 'Old_Name' },
    }
    expect(resolveLaneName('dev-1', [stale], live))
      .toEqual({ name: 'Simulated_CNC_01', qualifier: undefined, fromSnapshot: false, gone: false })
  })

  it('does not call an entity deleted when nothing looked its kind up', () => {
    /* `gone` and `fromSnapshot` answer different questions, and conflating them is what widening
       snapshotIdentity() would have broken: a settings or backup lane takes its name from the
       audit snapshot and exists perfectly well, because nothing fetches those tables to compare
       against. The caller passes `canTellDeleted` only for a kind `entityNames` covers. */
    const setting = { old_data: null, new_data: { key: 'ui.x', label: 'A setting' } }
    expect(resolveLaneName('set-1', [setting], live))
      .toEqual({ name: 'A setting', fromSnapshot: true, identityField: 'label', gone: false })

    expect(resolveLaneName('set-1', [setting], live, { canTellDeleted: true }).gone).toBe(true)
  })

  it('flags an entity that is gone even when its rows carry no name to recover', () => {
    // Absence from a lookup that covers the kind is what deleted MEANS; the snapshot is only where
    // the label comes from. Reading `gone` off `fromSnapshot` missed this one entirely.
    const resolved = resolveLaneName('dev-gone', [{ old_data: {}, new_data: null }], live,
      { canTellDeleted: true })
    expect(resolved).toEqual({ name: null, fromSnapshot: false, gone: true })
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
    expect(resolved).toEqual({ name: null, fromSnapshot: false, gone: false })
  })
})

describe('SCHEMA_REJECTION events', () => {
  /**
   * Written by record_ingestion_rejection(), not the audit trigger, so it is the first `action`
   * value that is not a TG_OP and records an observation rather than a row mutation.
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
    // A rejection says the asset is publishing something its declared model does not account for,
    // the same category as a schema rebinding. Falling through to `operational` would paint a
    // conformance breach the colour of a routine status change.
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

import { describe, it, expect } from 'vitest';
import {
  SCOPE_CELL,
  SCOPE_AREA_WIDE,
  SCOPE_SITE_WIDE,
  SOURCE_AREA_WIDE,
  groupCellsByArea,
  SOURCE_EXPLICIT,
  SOURCE_INHERITED,
  SOURCE_SITE_WIDE,
  SOURCE_UNASSIGNED,
  UNASSIGNED_NO_GATEWAY,
  UNASSIGNED_GATEWAY_HAS_NO_CELL,
  UNASSIGNED_GATEWAY_SITE_WIDE,
  resolveDeviceLocation,
  deviceLocationOf,
  isUnassigned,
  needsCellAssignment,
  unassignedReason,
  unassignedHint,
  locationSourceLabel,
  groupDevicesByCell
} from '../utils/cellResolution';

/**
 * These mirror how public.device_locations (supabase/migrations/0001_baseline_schema.sql) resolves a
 * device, case for case, so a drift between the view and this module fails somewhere.
 */

const CELL_A = 'aaaaaaaa-0000-4000-8000-000000000000';
const CELL_B = 'bbbbbbbb-0000-4000-8000-000000000000';
const AREA_1 = '11111111-0000-4000-8000-000000000000';

const gatewayInCellA = { id: 'gw-1', cell_id: CELL_A, location_scope: SCOPE_CELL };

describe('effective cell resolution', () => {
  it('inherits the gateway cell when the device has none', () => {
    const loc = resolveDeviceLocation({ cell_id: null }, gatewayInCellA);
    expect(loc.effective_cell_id).toBe(CELL_A);
    expect(loc.location_source).toBe(SOURCE_INHERITED);
    expect(loc.cell_mismatch).toBe(false);
  });

  it('lets an explicit device cell win over the gateway, and reports the disagreement', () => {
    const loc = resolveDeviceLocation({ cell_id: CELL_B }, gatewayInCellA);
    expect(loc.effective_cell_id).toBe(CELL_B);
    expect(loc.location_source).toBe(SOURCE_EXPLICIT);
    expect(loc.cell_mismatch).toBe(true);
  });

  it('does not report a mismatch when the explicit cell agrees with the gateway', () => {
    expect(resolveDeviceLocation({ cell_id: CELL_A }, gatewayInCellA).cell_mismatch).toBe(false);
  });

  it('resolves to unassigned with no gateway and no cell', () => {
    const loc = resolveDeviceLocation({ cell_id: null }, null);
    expect(loc.effective_cell_id).toBeNull();
    expect(loc.location_source).toBe(SOURCE_UNASSIGNED);
  });

  it('resolves a site-wide device to no cell even when its gateway has one', () => {
    const loc = resolveDeviceLocation({ cell_id: null, location_scope: SCOPE_SITE_WIDE }, gatewayInCellA);
    expect(loc.effective_cell_id).toBeNull();
    expect(loc.location_source).toBe(SOURCE_SITE_WIDE);
  });

  it('does not inherit scope: a device behind a site-wide gateway is unassigned, not site-wide', () => {
    const siteWideGateway = { id: 'gw-2', cell_id: null, location_scope: SCOPE_SITE_WIDE };
    const loc = resolveDeviceLocation({ cell_id: null }, siteWideGateway);
    expect(loc.location_source).toBe(SOURCE_UNASSIGNED);
    expect(loc.location_scope).toBe(SCOPE_CELL);
  });

  it('treats a missing or unknown scope as cell-scoped', () => {
    expect(resolveDeviceLocation({}, gatewayInCellA).location_scope).toBe(SCOPE_CELL);
    expect(resolveDeviceLocation({ location_scope: 'nonsense' }, gatewayInCellA).location_scope).toBe(SCOPE_CELL);
  });
});

/**
 * The area rung. A cell-scoped device's area is its effective cell's; an area-wide device names
 * its own and has no cell; a site-wide device has neither. Mirrors the view's third CASE.
 */
describe('effective area resolution', () => {
  const cellsById = new Map([
    [CELL_A, { cell_id: CELL_A, area_id: AREA_1 }],
    [CELL_B, { cell_id: CELL_B, area_id: null }]
  ]);

  it('derives the area from the effective cell, inherited or explicit', () => {
    expect(resolveDeviceLocation({ cell_id: null }, gatewayInCellA, cellsById).effective_area_id).toBe(AREA_1);
    expect(resolveDeviceLocation({ cell_id: CELL_B }, gatewayInCellA, cellsById).effective_area_id).toBeNull();
  });

  it('resolves an area-wide device to its own area and to no cell, even behind a gateway with one', () => {
    const loc = resolveDeviceLocation({ location_scope: SCOPE_AREA_WIDE, area_id: AREA_1 }, gatewayInCellA, cellsById);
    expect(loc.location_source).toBe(SOURCE_AREA_WIDE);
    expect(loc.effective_cell_id).toBeNull();
    expect(loc.effective_area_id).toBe(AREA_1);
    expect(loc.explicit_area_id).toBe(AREA_1);
  });

  it('gives a site-wide device no area: the whole campus is not an area', () => {
    const loc = resolveDeviceLocation({ location_scope: SCOPE_SITE_WIDE, area_id: AREA_1 }, gatewayInCellA, cellsById);
    expect(loc.effective_area_id).toBeNull();
  });

  it('ranks area-wide below site-wide and above the explicit cell, as the view does', () => {
    expect(resolveDeviceLocation({ location_scope: SCOPE_AREA_WIDE, area_id: AREA_1, cell_id: CELL_B }, null).location_source)
      .toBe(SOURCE_AREA_WIDE);
    expect(resolveDeviceLocation({ location_scope: SCOPE_AREA_WIDE, area_id: AREA_1 }, { id: 'gw', is_simulated: true }).location_source)
      .toBe('simulated');
  });

  it('resolves no area without the cell rows to look one up in', () => {
    expect(resolveDeviceLocation({ cell_id: null }, gatewayInCellA).effective_area_id).toBeNull();
  });

  it('keeps an area-wide device out of the Unassigned queue and out of every cell bucket', () => {
    const device = { location_scope: SCOPE_AREA_WIDE, area_id: AREA_1 };
    expect(needsCellAssignment(device, null)).toBe(false);
    expect(groupDevicesByCell([{ ...device, id: 'bms' }]).size).toBe(0);
  });

  it('treats an area-wide gateway like a site-wide one for the unassigned hint', () => {
    expect(unassignedReason({ cell_id: null }, { id: 'gw', cell_id: null, location_scope: SCOPE_AREA_WIDE }))
      .toBe(UNASSIGNED_GATEWAY_SITE_WIDE);
  });
});

describe('grouping cells by area', () => {
  it('keeps unfiled cells under a null key, because that bucket is the Areas page queue', () => {
    const byArea = groupCellsByArea([{ cell_id: 'c1', area_id: AREA_1 }, { cell_id: 'c2', area_id: null }, { cell_id: 'c3' }]);
    expect(byArea.get(AREA_1).map(c => c.cell_id)).toEqual(['c1']);
    expect(byArea.get(null).map(c => c.cell_id)).toEqual(['c2', 'c3']);
  });

});

describe('preferring the server-resolved row', () => {
  it('uses a row merged from device_locations rather than re-deriving it', () => {
    // Deliberately contradictory: local derivation would say inherited/CELL_A. The view is the
    // authority, so its answer has to survive.
    const merged = {
      cell_id: null,
      location_scope: SCOPE_CELL,
      effective_cell_id: CELL_B,
      location_source: SOURCE_EXPLICIT,
      explicit_cell_id: CELL_B,
      gateway_cell_id: CELL_A,
      cell_mismatch: true
    };
    expect(deviceLocationOf(merged, gatewayInCellA).effective_cell_id).toBe(CELL_B);
    expect(deviceLocationOf(merged, gatewayInCellA).location_source).toBe(SOURCE_EXPLICIT);
  });

  it('falls back to local derivation when the view has not been read', () => {
    expect(deviceLocationOf({ cell_id: null }, gatewayInCellA).effective_cell_id).toBe(CELL_A);
  });

  it('does not mistake a site-wide view row for an unread one', () => {
    // effective_cell_id is null for site-wide AND for unassigned, which is why location_source
    // is what signals that the view was read.
    const merged = { location_source: SOURCE_SITE_WIDE, effective_cell_id: null };
    expect(deviceLocationOf(merged, gatewayInCellA).location_source).toBe(SOURCE_SITE_WIDE);
    expect(isUnassigned(merged, gatewayInCellA)).toBe(false);
  });
});

describe('unassigned devices needing an operator decision', () => {
  it('flags an unassigned device', () => {
    expect(needsCellAssignment({ cell_id: null }, null)).toBe(true);
  });

  it('does not flag a site-wide device: that is the answer, not the absence of one', () => {
    expect(needsCellAssignment({ location_scope: SCOPE_SITE_WIDE }, null)).toBe(false);
  });

  it('does not flag a device that resolved to a cell either way', () => {
    expect(needsCellAssignment({ cell_id: null }, gatewayInCellA)).toBe(false);
    expect(needsCellAssignment({ cell_id: CELL_B }, null)).toBe(false);
  });

  it('distinguishes the three reasons, because the fixes differ', () => {
    expect(unassignedReason({ cell_id: null }, null)).toBe(UNASSIGNED_NO_GATEWAY);
    expect(unassignedReason({ cell_id: null }, { id: 'gw', cell_id: null })).toBe(UNASSIGNED_GATEWAY_HAS_NO_CELL);
    expect(unassignedReason({ cell_id: null }, { id: 'gw', cell_id: null, deployment: 'host' }))
      .toBe(UNASSIGNED_GATEWAY_SITE_WIDE);
    expect(unassignedReason({ cell_id: null }, { id: 'gw', cell_id: null, location_scope: SCOPE_SITE_WIDE }))
      .toBe(UNASSIGNED_GATEWAY_SITE_WIDE);
  });

  it('returns no reason for a device that is not unassigned', () => {
    expect(unassignedReason({ cell_id: null }, gatewayInCellA)).toBeNull();
    expect(unassignedHint({ cell_id: null }, gatewayInCellA)).toBeNull();
  });

  it('never tells an operator to give a host-run gateway a cell', () => {
    const hint = unassignedHint({ cell_id: null }, { id: 'gw', cell_id: null, deployment: 'host' });
    expect(hint).toMatch(/host-level proxy/);
    expect(hint).toMatch(/Site-Wide/);
  });
});

describe('grouping devices by cell', () => {
  it('buckets a device onto the cell it resolves to, not the one its gateway serves', async () => {
    const grouped = groupDevicesByCell([
      { id: 'd1', location_source: SOURCE_INHERITED, effective_cell_id: CELL_A },
      { id: 'd2', location_source: SOURCE_EXPLICIT, effective_cell_id: CELL_B, gateway_cell_id: CELL_A }
    ]);
    expect(grouped.get(CELL_A).map(d => d.id)).toEqual(['d1']);
    expect(grouped.get(CELL_B).map(d => d.id)).toEqual(['d2']);
  });

  it('omits site-wide and unassigned devices instead of collecting them under one key', () => {
    // They belong to no card, and they are different states -- merging them into a single
    // "everything else" bucket is exactly what the two lanes exist to prevent.
    const grouped = groupDevicesByCell([
      { id: 'bms', location_source: SOURCE_SITE_WIDE, effective_cell_id: null },
      { id: 'agv', location_source: SOURCE_UNASSIGNED, effective_cell_id: null }
    ]);
    expect(grouped.size).toBe(0);
    expect(grouped.get(null)).toBeUndefined();
    expect(grouped.get(undefined)).toBeUndefined();
  });

  it('derives membership locally for rows that never went through the view', () => {
    const grouped = groupDevicesByCell([{ id: 'd1', cell_id: CELL_B }]);
    expect(grouped.get(CELL_B).map(d => d.id)).toEqual(['d1']);
  });

  it('handles an empty or missing list', () => {
    expect(groupDevicesByCell([]).size).toBe(0);
    expect(groupDevicesByCell(undefined).size).toBe(0);
  });
});

describe('labels', () => {
  it('labels each source distinctly', () => {
    const labels = [SOURCE_EXPLICIT, SOURCE_INHERITED, SOURCE_AREA_WIDE, SOURCE_SITE_WIDE, SOURCE_UNASSIGNED]
      .map(locationSourceLabel);
    expect(new Set(labels).size).toBe(5);
    expect(locationSourceLabel(undefined)).toBe('Unassigned');
  });
});

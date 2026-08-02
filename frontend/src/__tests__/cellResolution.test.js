import { describe, it, expect } from 'vitest';
import {
  SCOPE_CELL,
  SCOPE_SITE_WIDE,
  LOCATION_SCOPES,
  SOURCE_EXPLICIT,
  SOURCE_INHERITED,
  SOURCE_SITE_WIDE,
  SOURCE_UNASSIGNED,
  UNASSIGNED_NO_GATEWAY,
  UNASSIGNED_GATEWAY_HAS_NO_CELL,
  UNASSIGNED_GATEWAY_SITE_WIDE,
  resolveDeviceLocation,
  deviceLocationOf,
  effectiveCellId,
  isSiteWide,
  isUnassigned,
  needsCellAssignment,
  unassignedReason,
  unassignedHint,
  locationSourceLabel,
  resolveDeviceLocations,
  groupDevicesByCell
} from '../utils/cellResolution';

/**
 * These mirror the DO probe at the end of
 * supabase/migrations/0001_baseline_schema.sql case for case. Both sides assert the
 * same four resolution branches against the same shaped data, which is what makes a drift
 * between public.device_locations and this module fail somewhere rather than nowhere.
 */

const CELL_A = 'aaaaaaaa-0000-4000-8000-000000000000';
const CELL_B = 'bbbbbbbb-0000-4000-8000-000000000000';

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

  it('exposes only the two scopes the CHECK constraints allow', () => {
    expect(LOCATION_SCOPES).toEqual([SCOPE_CELL, SCOPE_SITE_WIDE]);
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
    expect(effectiveCellId({ cell_id: null }, gatewayInCellA)).toBe(CELL_A);
  });

  it('does not mistake a site-wide view row for an unread one', () => {
    // effective_cell_id is null for site-wide AND for unassigned, which is why location_source
    // is what signals that the view was read.
    const merged = { location_source: SOURCE_SITE_WIDE, effective_cell_id: null };
    expect(isSiteWide(merged, gatewayInCellA)).toBe(true);
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
    expect(unassignedReason({ cell_id: null }, { id: 'gw', cell_id: null, is_virtual: true }))
      .toBe(UNASSIGNED_GATEWAY_SITE_WIDE);
    expect(unassignedReason({ cell_id: null }, { id: 'gw', cell_id: null, location_scope: SCOPE_SITE_WIDE }))
      .toBe(UNASSIGNED_GATEWAY_SITE_WIDE);
  });

  it('returns no reason for a device that is not unassigned', () => {
    expect(unassignedReason({ cell_id: null }, gatewayInCellA)).toBeNull();
    expect(unassignedHint({ cell_id: null }, gatewayInCellA)).toBeNull();
  });

  it('never tells an operator to give a host-run gateway a cell', () => {
    const hint = unassignedHint({ cell_id: null }, { id: 'gw', cell_id: null, is_virtual: true });
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

describe('labels and bulk resolution', () => {
  it('labels each source distinctly', () => {
    const labels = [SOURCE_EXPLICIT, SOURCE_INHERITED, SOURCE_SITE_WIDE, SOURCE_UNASSIGNED]
      .map(locationSourceLabel);
    expect(new Set(labels).size).toBe(4);
    expect(locationSourceLabel(undefined)).toBe('Unassigned');
  });

  it('resolves a list against its gateways, keyed by device id', () => {
    const devices = [
      { asset_id: 'd1', active_gateway_id: 'gw-1', cell_id: null },
      { asset_id: 'd2', active_gateway_id: 'gw-1', cell_id: CELL_B },
      { asset_id: 'd3', active_gateway_id: null, cell_id: null }
    ];
    const resolved = resolveDeviceLocations(devices, [{ gateway_id: 'gw-1', cell_id: CELL_A }]);
    expect(resolved.get('d1').location_source).toBe(SOURCE_INHERITED);
    expect(resolved.get('d2').effective_cell_id).toBe(CELL_B);
    expect(resolved.get('d3').location_source).toBe(SOURCE_UNASSIGNED);
  });

  it('accepts gateways keyed by either id shape, since api.js maps one onto the other', () => {
    const devices = [{ id: 'd1', gateway_id: 'gw-1', cell_id: null }];
    const resolved = resolveDeviceLocations(devices, [{ id: 'gw-1', cell_id: CELL_A }]);
    expect(resolved.get('d1').effective_cell_id).toBe(CELL_A);
  });
});

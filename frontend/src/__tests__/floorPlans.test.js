import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PLAN_ASPECT,
  sortFloors,
  groundFloor,
  floorsByArea,
  floorAspect,
  isPlaced,
  planDistance,
  nearestConflict,
  planFractionsFromEvent,
  formatPlace,
  isSvgFile,
  svgAspectFromText,
  floorPlanPath,
  nextLevel
} from '../utils/floorPlans';

/**
 * The floor and place arithmetic the Site Map, the Cells form and the Areas panel share. The
 * distance rule mirrors public.plan_distance(); the SVG size rule is what stands between a plan
 * and a place that moves with the window.
 */

const floors = [
  { floor_id: 'g', level: 0, name: 'Ground floor' },
  { floor_id: 'b', level: -1, name: 'Basement' },
  { floor_id: 'one', level: 1, name: 'Floor 1' }
];

describe('floors', () => {
  it('sorts top-down, as a building reads', () => {
    expect(sortFloors(floors).map(f => f.floor_id)).toEqual(['one', 'g', 'b']);
  });

  it('opens on the ground floor, else the lowest floor above ground, else the highest basement', () => {
    expect(groundFloor(floors).floor_id).toBe('g');
    expect(groundFloor([{ floor_id: 'two', level: 2 }, { floor_id: 'one', level: 1 }]).floor_id).toBe('one');
    expect(groundFloor([{ floor_id: 'b2', level: -2 }, { floor_id: 'b1', level: -1 }]).floor_id).toBe('b1');
    expect(groundFloor([])).toBeNull();
  });

  it('buckets floors by area, each bucket top-down', () => {
    const byArea = floorsByArea([
      { floor_id: 'x', area_id: 'A', level: 0 }, { floor_id: 'y', area_id: 'A', level: 1 }, { floor_id: 'z', area_id: 'B', level: 0 }
    ]);
    expect(byArea.get('A').map(f => f.floor_id)).toEqual(['y', 'x']);
    expect(byArea.get('B').map(f => f.floor_id)).toEqual(['z']);
  });

  it('suggests the next level up or down for a new floor', () => {
    expect(nextLevel(floors, 1)).toBe(2);
    expect(nextLevel(floors, -1)).toBe(-2);
    expect(nextLevel([], 1)).toBe(0);
  });

  it('falls back to the default outline aspect with no plan', () => {
    expect(floorAspect({ plan_aspect: null })).toBe(DEFAULT_PLAN_ASPECT);
    expect(floorAspect({ plan_aspect: '1.5' })).toBe(1.5);
    expect(floorAspect(undefined)).toBe(DEFAULT_PLAN_ASPECT);
  });
});

describe('places', () => {
  it('is placed only when both fractions are there', () => {
    expect(isPlaced({ plan_x: 0.5, plan_y: 0.25 })).toBe(true);
    expect(isPlaced({ plan_x: '0.5', plan_y: '0.25' })).toBe(true);
    expect(isPlaced({ plan_x: 0.5, plan_y: null })).toBe(false);
    expect(isPlaced({ plan_x: '', plan_y: '' })).toBe(false);
    expect(isPlaced({})).toBe(false);
  });

  it('measures distance in the plan\'s shorter side, so a step across a wide plan counts more', () => {
    // On a 4:3 plan the width is 4/3 of the height: the same fraction is a longer walk across.
    expect(planDistance({ x: 0.5, y: 0.5 }, { x: 0.56, y: 0.5 }, 4 / 3)).toBeCloseTo(0.08, 5);
    expect(planDistance({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.56 }, 4 / 3)).toBeCloseTo(0.06, 5);
    // A tall plan does the reverse.
    expect(planDistance({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.56 }, 0.5)).toBeCloseTo(0.12, 5);
    // Row fields are read too, so a cell row can stand in for a place.
    expect(planDistance({ plan_x: 0, plan_y: 0 }, { plan_x: 0, plan_y: 1 }, 1)).toBe(1);
  });

  it('names the nearest neighbour inside the spacing, ignoring itself, the archived and the unplaced', () => {
    const others = [
      { cell_id: 'far', cell_name: 'Far', plan_x: 0.9, plan_y: 0.9 },
      { cell_id: 'near', cell_name: 'Near', plan_x: 0.52, plan_y: 0.5 },
      { cell_id: 'nearer', cell_name: 'Nearer', plan_x: 0.51, plan_y: 0.5 },
      { cell_id: 'arch', cell_name: 'Archived', plan_x: 0.5, plan_y: 0.5, is_archived: true },
      { cell_id: 'unplaced', cell_name: 'Unplaced', plan_x: null, plan_y: null }
    ];
    expect(nearestConflict({ x: 0.5, y: 0.5 }, others, 4 / 3, 0.08).cell_id).toBe('nearer');
    expect(nearestConflict({ x: 0.5, y: 0.5 }, others, 4 / 3, 0.08, 'nearer').cell_id).toBe('near');
    expect(nearestConflict({ x: 0.5, y: 0.5 }, others, 4 / 3, 0.005)).toBeNull();
  });

  it('reads a click as fractions of the element, clamped to the plan', () => {
    const element = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 300 }) };
    expect(planFractionsFromEvent({ clientX: 300, clientY: 125 }, element)).toEqual({ x: 0.5, y: 0.25 });
    expect(planFractionsFromEvent({ clientX: 0, clientY: 1000 }, element)).toEqual({ x: 0, y: 1 });
    expect(planFractionsFromEvent({ clientX: 0, clientY: 0 }, { getBoundingClientRect: () => ({ width: 0, height: 0 }) })).toBeNull();
  });

  it('says a place the way a person reads it', () => {
    expect(formatPlace({ plan_x: 0.5, plan_y: 0.354 })).toBe('50% across, 35% down');
    expect(formatPlace({ plan_x: null, plan_y: null })).toBeNull();
  });
});

describe('plan files', () => {
  it('accepts an SVG by name or by type and nothing else', () => {
    expect(isSvgFile({ name: 'ground.svg', type: '' })).toBe(true);
    expect(isSvgFile({ name: 'ground', type: 'image/svg+xml' })).toBe(true);
    expect(isSvgFile({ name: 'ground.png', type: 'image/png' })).toBe(false);
    expect(isSvgFile(null)).toBe(false);
  });

  it('reads the aspect from the viewBox first, then width and height, else refuses', () => {
    // Rounded to four places: the column is numeric(8,4).
    expect(svgAspectFromText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect/></svg>')).toBe(1.3333);
    expect(svgAspectFromText('<?xml version="1.0"?><svg viewBox="0,0,300,600" width="10" height="10"/>')).toBe(0.5);
    expect(svgAspectFromText('<svg width="1200px" height="400px"></svg>')).toBe(3);
    // Percent lengths say nothing about shape, and a plan with no stated size renders 300x150.
    expect(svgAspectFromText('<svg width="100%" height="100%"></svg>')).toBeNull();
    expect(svgAspectFromText('<svg></svg>')).toBeNull();
    expect(svgAspectFromText('not svg at all')).toBeNull();
  });

  it('files a plan under its area and floor, with a fresh name per upload', () => {
    expect(floorPlanPath({ area_id: 'A', floor_id: 'F' }, 123)).toBe('A/F/plan-123.svg');
    expect(floorPlanPath({ area_id: 'A', id: 'F' }, 123)).toBe('A/F/plan-123.svg');
  });
});

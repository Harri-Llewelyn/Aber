import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PLAN_ASPECT,
  planAspect,
  isPlaced,
  planDistance,
  nearestConflict,
  planFractionsFromEvent,
  formatPlace,
  isSvgFile,
  svgAspectFromText,
  readSvgPlan,
  decodeSvgBytes,
  areaPlanPath
} from '../utils/areaPlans';

/**
 * The plan and place arithmetic the Site Map, the Cells form and the Areas panel share. The
 * distance rule mirrors public.plan_distance(); the SVG size rule is what stands between a plan
 * and a place that moves with the window.
 */

describe('plans', () => {
  it('falls back to the default outline aspect with no plan', () => {
    expect(planAspect({ plan_aspect: null })).toBe(DEFAULT_PLAN_ASPECT);
    expect(planAspect({ plan_aspect: '1.5' })).toBe(1.5);
    expect(planAspect(undefined)).toBe(DEFAULT_PLAN_ASPECT);
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

  const NS = 'xmlns="http://www.w3.org/2000/svg"';

  it('reads the aspect from the viewBox first, then width and height, else refuses', () => {
    // Rounded to four places: the column is numeric(8,4).
    expect(svgAspectFromText(`<svg ${NS} viewBox="0 0 800 600"><rect/></svg>`)).toBe(1.3333);
    expect(svgAspectFromText(`<?xml version="1.0"?><svg ${NS} viewBox="0,0,300,600" width="10" height="10"/>`)).toBe(0.5);
    expect(svgAspectFromText(`<svg ${NS} width="1200px" height="400px"></svg>`)).toBe(3);
    expect(svgAspectFromText(`<svg ${NS} viewBox="0 0 1.2e3 9e2"/>`)).toBe(1.3333);
    expect(svgAspectFromText(`<svg ${NS} viewBox="0,0,\n  800,\n  600"/>`)).toBe(1.3333);
    // Percent lengths say nothing about shape, and a plan with no stated size renders 300x150.
    expect(readSvgPlan(`<svg ${NS} width="100%" height="100%"></svg>`).problem).toMatch(/states no size/);
    expect(readSvgPlan(`<svg ${NS} style="width:800px;height:600px"></svg>`).problem).toMatch(/states no size/);
    expect(svgAspectFromText(`<svg ${NS}></svg>`)).toBeNull();
    expect(svgAspectFromText('not svg at all')).toBeNull();
    expect(svgAspectFromText('')).toBeNull();
  });

  it('reads the file the way a browser does, so what passes the check is what draws', () => {
    // No namespace: well-formed XML that an <img> draws as nothing.
    expect(readSvgPlan('<svg viewBox="0 0 800 600"><rect/></svg>').problem).toMatch(/not an SVG/);
    // XML is case-sensitive: "viewbox" is ignored, and the size comes from width and height.
    expect(readSvgPlan(`<svg ${NS} viewbox="0 0 800 600" width="1000" height="1000"/>`)).toEqual({ aspect: 1 });
    // The root is the root, not the first "<svg" in the bytes.
    expect(readSvgPlan(`<?xml version="1.0"?><!-- template: <svg viewBox="0 0 10 10"> --><svg ${NS} viewBox="0 0 800 600"/>`)).toEqual({ aspect: 1.3333 });
    // Units are honoured: 1200mm by 80cm is 3:2, not 15:1.
    expect(readSvgPlan(`<svg ${NS} width="1200mm" height="80cm"/>`)).toEqual({ aspect: 1.5 });
    expect(readSvgPlan(`<svg ${NS} width="8.5in" height="792pt"/>`)).toEqual({ aspect: 0.7727 });
    // A prefixed root is still an SVG root.
    expect(readSvgPlan(`<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><svg:rect/></svg:svg>`)).toEqual({ aspect: 1.3333 });
    // Not well-formed: a browser shows a broken image.
    expect(readSvgPlan(`<svg ${NS} viewBox="0 0 800 600"><rect><text>Goods & services</text></svg>`).problem).toMatch(/not well-formed/);
  });

  it('refuses proportions the column cannot hold, saying so', () => {
    expect(readSvgPlan(`<svg ${NS} viewBox="0 0 20000 1"/>`).problem).toMatch(/proportions/);
    expect(readSvgPlan(`<svg ${NS} viewBox="0 0 1 30000"/>`).problem).toMatch(/proportions/);
    expect(readSvgPlan(`<svg ${NS} viewBox="0 0 9999 1"/>`)).toEqual({ aspect: 9999 });
  });

  it('decodes a plan by its byte-order mark', () => {
    const svg = `<?xml version="1.0" encoding="UTF-16"?><svg ${NS} viewBox="0 0 800 600"/>`;
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from(svg).flatMap(ch => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8])]);
    expect(readSvgPlan(decodeSvgBytes(utf16.buffer))).toEqual({ aspect: 1.3333 });
    expect(readSvgPlan(decodeSvgBytes(new TextEncoder().encode(`<svg ${NS} viewBox="0 0 300 600"/>`).buffer))).toEqual({ aspect: 0.5 });
  });

  it('files a plan under its area, with a fresh name per upload', () => {
    expect(areaPlanPath({ area_id: 'A' }, 123)).toBe('A/plan-123.svg');
    expect(areaPlanPath({ id: 'A' }, 123)).toBe('A/plan-123.svg');
  });
});

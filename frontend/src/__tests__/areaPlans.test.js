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
  readSvgPlan,
  decodeSvgBytes,
  areaPlanPath,
  PLAN_ROTATIONS,
  planRotation,
  nextRotation,
  planFrameAspect,
  placeInFrame,
  placeOnDrawing,
  drawingBoxInFrame
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

/**
 * A plan turned in quarter turns. The drawing is laid out at its own shape and turned about the
 * frame's centre, as the browser applies `rotate()` (AreaPlan.jsx). `drawnAt` models that with a
 * rotation matrix, so the frame arithmetic is checked against the picture, not against itself.
 */
describe('turned plans', () => {
  const turned = (rotation) => ({ plan_path: 'a/plan-1.svg', plan_aspect: 2, plan_rotation: rotation });

  /** Where the browser draws the drawing's (x, y): the image box turned about its centre, as fractions of the frame. */
  const drawnAt = (area, { x, y }) => {
    const fw = 300;
    const fh = fw / planFrameAspect(area);
    const box = drawingBoxInFrame(area);
    const bw = (box.width / 100) * fw;
    const bh = (box.height / 100) * fh;
    const ox = (x - 0.5) * bw;
    const oy = (y - 0.5) * bh;
    const t = (box.rotation * Math.PI) / 180;
    return {
      x: (fw / 2 + ox * Math.cos(t) - oy * Math.sin(t)) / fw,
      y: (fh / 2 + ox * Math.sin(t) + oy * Math.cos(t)) / fh
    };
  };
  const expectPlace = (got, want) => {
    expect(got.x).toBeCloseTo(want.x, 9);
    expect(got.y).toBeCloseTo(want.y, 9);
  };

  // A door near the drawing's top left, a press low on the right, and two corners.
  const FEATURES = [{ x: 0.25, y: 0.1 }, { x: 0.8, y: 0.7 }, { x: 0, y: 0 }, { x: 1, y: 1 }];

  it('reads the turn, and takes a quarter turn either way', () => {
    expect(PLAN_ROTATIONS).toEqual([0, 90, 180, 270]);
    expect(planRotation(turned(90))).toBe(90);
    expect(planRotation({ plan_rotation: '180' })).toBe(180);
    // Anything the CHECK would refuse is drawn unturned.
    expect(planRotation({ plan_rotation: 45 })).toBe(0);
    expect(planRotation({ plan_rotation: null })).toBe(0);
    expect(planRotation(undefined)).toBe(0);

    expect(nextRotation(0, 1)).toBe(90);
    expect(nextRotation(270, 1)).toBe(0);
    expect(nextRotation(0, -1)).toBe(270);
    expect(nextRotation(90, -1)).toBe(0);
    expect(PLAN_ROTATIONS.map(r => nextRotation(nextRotation(r, 1), -1))).toEqual(PLAN_ROTATIONS);
  });

  it('draws the frame on its side at 90 and 270, and measures with the drawing\'s own aspect', () => {
    expect([0, 90, 180, 270].map(r => planFrameAspect(turned(r)))).toEqual([2, 0.5, 2, 0.5]);
    expect([0, 90, 180, 270].map(r => planAspect(turned(r)))).toEqual([2, 2, 2, 2]);
    expect(planFrameAspect({ plan_aspect: null, plan_rotation: 0 })).toBe(DEFAULT_PLAN_ASPECT);
  });

  it('lays the drawing out at its own shape, so it covers the frame once turned', () => {
    for (const r of PLAN_ROTATIONS) {
      const area = turned(r);
      const fw = 300;
      const fh = fw / planFrameAspect(area);
      const box = drawingBoxInFrame(area);
      const bw = (box.width / 100) * fw;
      const bh = (box.height / 100) * fh;
      expect(box.rotation).toBe(r);
      expect(bw / bh).toBeCloseTo(2, 9);
      // Turned on its side, the box's height spans the frame's width and its width the height.
      expect(r % 180 ? [bh, bw] : [bw, bh]).toEqual([fw, fh]);
    }
  });

  it('keeps a cell on the same feature of the drawing at 0, 90, 180 and 270', () => {
    for (const r of PLAN_ROTATIONS) {
      for (const feature of FEATURES) expectPlace(placeInFrame(feature, r), drawnAt(turned(r), feature));
    }
    // A clockwise turn: the drawing's top left goes to the top right, then the bottom right, then the bottom left.
    expect(placeInFrame({ x: 0, y: 0 }, 90)).toEqual({ x: 1, y: 0 });
    expect(placeInFrame({ x: 0, y: 0 }, 180)).toEqual({ x: 1, y: 1 });
    expect(placeInFrame({ x: 0, y: 0 }, 270)).toEqual({ x: 0, y: 1 });
    // Row values arrive as numbers or strings.
    expect(placeInFrame({ x: '0.25', y: '0.1' }, 0)).toEqual({ x: 0.25, y: 0.1 });
  });

  it('turns a click back into the place on the drawing it was made over', () => {
    for (const r of PLAN_ROTATIONS) {
      for (const feature of FEATURES) {
        expectPlace(placeOnDrawing(drawnAt(turned(r), feature), r), feature);
        expectPlace(placeOnDrawing(placeInFrame(feature, r), r), feature);
      }
    }
  });

  it('gives the spacing check the same answer at every turn', () => {
    const door = { x: 0.25, y: 0.1 };
    const others = [{ cell_id: 'door', cell_name: 'Door', plan_x: door.x, plan_y: door.y }];
    // 0.03 across a 2:1 drawing is 0.06 of its shorter side, inside 0.08; 0.05 across is 0.1.
    const near = { x: 0.28, y: 0.1 };
    const far = { x: 0.3, y: 0.1 };
    for (const r of PLAN_ROTATIONS) {
      const area = turned(r);
      // As the picker sees it: a click over the place, turned back, then checked with planAspect.
      const clicked = (p) => placeOnDrawing(drawnAt(area, p), r);
      expect(nearestConflict(clicked(near), others, planAspect(area), 0.08)?.cell_id).toBe('door');
      expect(nearestConflict(clicked(far), others, planAspect(area), 0.08)).toBeNull();
      // And the distance on screen, in the turned frame, is the distance the database measures.
      expect(planDistance(placeInFrame(near, r), placeInFrame(door, r), planFrameAspect(area)))
        .toBeCloseTo(planDistance(near, door, 2), 9);
    }
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
  const aspectOf = (text) => readSvgPlan(text).aspect ?? null;

  it('reads the aspect from the viewBox first, then width and height, else refuses', () => {
    // Rounded to four places: the column is numeric(8,4).
    expect(aspectOf(`<svg ${NS} viewBox="0 0 800 600"><rect/></svg>`)).toBe(1.3333);
    expect(aspectOf(`<?xml version="1.0"?><svg ${NS} viewBox="0,0,300,600" width="10" height="10"/>`)).toBe(0.5);
    expect(aspectOf(`<svg ${NS} width="1200px" height="400px"></svg>`)).toBe(3);
    expect(aspectOf(`<svg ${NS} viewBox="0 0 1.2e3 9e2"/>`)).toBe(1.3333);
    expect(aspectOf(`<svg ${NS} viewBox="0,0,\n  800,\n  600"/>`)).toBe(1.3333);
    // Percent lengths say nothing about shape, and a plan with no stated size renders 300x150.
    expect(readSvgPlan(`<svg ${NS} width="100%" height="100%"></svg>`).problem).toMatch(/states no size/);
    expect(readSvgPlan(`<svg ${NS} style="width:800px;height:600px"></svg>`).problem).toMatch(/states no size/);
    expect(aspectOf(`<svg ${NS}></svg>`)).toBeNull();
    expect(aspectOf('not svg at all')).toBeNull();
    expect(aspectOf('')).toBeNull();
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

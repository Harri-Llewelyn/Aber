import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { AreaPlan, AreaPlanPin } from '../components/common/AreaPlan'

/**
 * A pin on the plan's edge is drawn whole. The frame clips what reaches past it, so what keeps a
 * pin whole is the margin the frame keeps round the drawing, and a label near a side edge slides
 * inward to end inside the frame. jsdom lays nothing out, so the geometry is read from App.css and
 * worked out here.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1') }
})

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
const area = { area_id: 'a', area_name: 'Assembly Hall', plan_path: null, plan_aspect: null }

/** The body of the top-level rule whose selector is exactly `selector`. */
const rule = (selector) => {
  const start = APP_CSS.indexOf(`\n${selector} {`)
  if (start === -1) throw new Error(`no rule for ${selector}`)
  const open = APP_CSS.indexOf('{', start)
  return APP_CSS.slice(open + 1, APP_CSS.indexOf('}', open))
}

/** A declaration's first value in px: `padding: 1px 6px` gives 1, `var(--pin-size, 40px)` its fallback. */
const px = (body, prop) => {
  const declaration = body.split(/[;{}]/).map(d => d.trim()).find(d => d.startsWith(`${prop}:`))
  if (!declaration) throw new Error(`no ${prop}`)
  const value = declaration.slice(prop.length + 1).trim()
  return parseFloat(value.match(/^var\(--[\w-]+,\s*([\d.]+px)\)/)?.[1] ?? value)
}

const frame = rule('.area-plan')
const insetX = px(frame, '--plan-inset-x')
const insetY = px(frame, '--plan-inset-y')

/** + - * / and parentheses over plain numbers: enough for the label's calc() once its units are substituted. */
function arithmetic(text) {
  const tokens = text.match(/\d*\.?\d+|[-+*/()]/g)
  let i = 0
  const primary = () => {
    const t = tokens[i++]
    if (t === '(') { const v = sum(); i++; return v }
    if (t === '-') return -primary()
    return Number(t)
  }
  const product = () => {
    let v = primary()
    while (tokens[i] === '*' || tokens[i] === '/') v = tokens[i++] === '*' ? v * primary() : v / primary()
    return v
  }
  const sum = () => {
    let v = product()
    while (tokens[i] === '+' || tokens[i] === '-') v = tokens[i++] === '+' ? v + product() : v - product()
    return v
  }
  return sum()
}

/** The label's sideways shift in px, from App.css, for a label `width` wide at `pinX` across a drawing `drawing` wide. */
function labelShift(pinX, width, drawing) {
  const body = rule('.area-plan-pin-label')
  const clampArgs = body.match(/translate:\s*clamp\(([\s\S]*?)\);/)[1]
  const args = clampArgs.split(/,\s*(?![^()]*\))/).map(a => a.trim())
  expect(args).toHaveLength(3)
  const value = (arg) => arithmetic(arg
    .replace(/var\(--pin-x, [\d.]+\)/g, `(${pinX})`)
    .replace(/var\(--plan-inset-x, [\d.]+px\)/g, `(${insetX})`)
    .replace(/([\d.]+)cqw/g, (_, n) => `(${n} * ${drawing} / 100)`)
    .replace(/([\d.]+)%/g, (_, n) => `(${n} * ${width} / 100)`)
    .replace(/px/g, '')
    .replace(/calc/g, ''))
  const [min, preferred, max] = args.map(value)
  return Math.max(min, Math.min(preferred, max))
}

/** Where a label `width` wide ends up, as [left, right] in px from the drawing's left edge. */
const labelSpan = (pinX, width, drawing) => {
  const left = pinX * drawing - width / 2 + labelShift(pinX, width, drawing)
  return [left, left + width]
}

describe('A pin on the edge of an area plan', () => {
  it('draws the pins inside the drawing, which the frame surrounds with a margin of half a pin', () => {
    render(
      <AreaPlan area={area}>
        <AreaPlanPin x={1} y={0} status="normal" label="MINCAA" selected />
      </AreaPlan>
    )
    const pin = document.querySelector('.area-plan-pin')
    expect(pin.parentElement).toHaveClass('area-plan-drawing')
    expect(pin.style.left).toBe('100%')
    expect(pin.style.top).toBe('0%')
    expect(pin.style.getPropertyValue('--pin-x')).toBe('1')
    // The drawing, not the frame, carries the plan's proportions, so places stay fractions of the plan.
    expect(pin.parentElement.style.aspectRatio).toMatch(/^1\.3333/)
    expect(document.querySelector('.area-plan').style.aspectRatio).toBe('')

    // The frame clips, so the margin is what keeps a pin on the edge whole.
    expect(frame).toMatch(/overflow:\s*hidden/)
    expect(frame).toMatch(/padding:\s*var\(--plan-inset-y\) var\(--plan-inset-x\)/)
    const disc = px(rule('.area-plan-pin-disc'), 'width')
    const gap = px(rule('.area-plan-pin'), 'gap')
    const label = rule('.area-plan-pin-label')
    const labelHeight = px(label, 'font-size') * Number(label.match(/line-height:\s*([\d.]+);/)[1])
      + 2 * px(label, 'padding') + 2 * px(label, 'border')
    const ring = Number(rule('.area-plan-pin-selected .area-plan-pin-disc').match(/0 0 0 (\d+)px/)[1])
    // The pin is centred on its place: half of it reaches up past the disc's top, half down past the label.
    expect(insetY).toBeGreaterThanOrEqual((disc + gap + labelHeight) / 2 + ring)
    expect(insetX).toBeGreaterThanOrEqual(disc / 2 + ring)
  })

  it('slides a label at the right edge inward to end inside the frame, the left edge likewise', () => {
    const drawing = 220
    for (const pinX of [1, 0.98, 0.9]) {
      const [left, right] = labelSpan(pinX, 150, drawing)
      expect(right).toBeLessThanOrEqual(drawing + insetX)
      expect(left).toBeGreaterThanOrEqual(-insetX)
      // Still under its disc: the label runs leftward from it rather than leaving it behind.
      expect(right).toBeGreaterThan(pinX * drawing)
    }
    const [left] = labelSpan(0, 150, drawing)
    expect(left).toBeGreaterThanOrEqual(-insetX)
  })

  it('leaves a label centred under its disc where it fits', () => {
    expect(labelShift(0.5, 150, 400)).toBe(0)
    expect(labelShift(0.85, 60, 400)).toBe(0)
  })

  it('measures a click against the drawing, so a click on the margin lands on the nearest edge', () => {
    const onPlaceClick = vi.fn()
    render(<AreaPlan area={area} onPlaceClick={onPlaceClick} />)
    const plan = document.querySelector('.area-plan')
    plan.querySelector('.area-plan-drawing').getBoundingClientRect = () => (
      { left: insetX, top: insetY, width: 400, height: 300, right: insetX + 400, bottom: insetY + 300 })
    fireEvent.click(plan, { clientX: insetX + 200, clientY: insetY + 150 })
    fireEvent.click(plan, { clientX: 4, clientY: 4 })
    fireEvent.click(plan, { clientX: insetX + 410, clientY: insetY + 310 })
    expect(onPlaceClick.mock.calls).toEqual([[{ x: 0.5, y: 0.5 }], [{ x: 0, y: 0 }], [{ x: 1, y: 1 }]])
  })
})

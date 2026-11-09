import React, { useId, useMemo, useRef, useState } from 'react'
import { DeviceStatusDot } from './DeviceStatusDot'
import { OverflowText } from './OverflowText'
import { HEAT_STEPS, HOURS_OF_DAY, bandRangeWords, heatBands, heatCellWords, heatStep, hourWords, silentWords } from '../../utils/history'
import { DEVICE_STATUS, deviceLifecycleStatus } from '../../utils/deviceStatus'

/** The hours the column heads name: every third, so the 24 fit a narrow page. The others are read to a screen reader. */
const NAMED_EVERY = 3

/**
 * A grid of one row a machine and one column an hour of the day, 00 to 23, each cell coloured by
 * the metric's mean at that hour across the window's days, in the shades of Overview's blocks: one
 * scale across every machine, so an outlier shows. A plain HTML grid that takes the page's width and
 * never scrolls sideways. Never colour alone: the key names the values each shade stands for, a cell
 * is read in words under the grid on the pointer or on keyboard focus, and a screen reader hears the
 * same from the cell. One cell is in the tab order, and the arrow keys, Home and End move between
 * them. A machine with no `cells` row says `absent` in words, or that it does not report the metric.
 *
 * `rows` are the machines, `{ key, name, device?, absent? }`, in the order shown. `grid` is hourGrid()'s
 * answer: each machine's 24 hours and the lowest and highest value.
 *
 *   <HourHeatmap rows={rows} grid={hourGrid(readings, keys)} metric="Spindle/LOAD" unit="kW" />
 */
export function HourHeatmap({ rows, grid, metric, unit }) {
  const id = useId()
  const body = useRef(null)
  // The cell that is in the tab order, and the one being read out, as [row, hour] or null.
  const [active, setActive] = useState(null)
  const [point, setPoint] = useState(null)
  const bands = useMemo(() => heatBands(grid.low, grid.high), [grid.low, grid.high])
  const heated = (i) => Boolean(rows[i]) && grid.cells.has(rows[i].key) && !rows[i].absent
  const first = rows.findIndex((_, i) => heated(i))
  // The tab stop is the cell last focused, or the first cell where its row has gone with a new read.
  const [row0, col0] = active && heated(active[0]) ? active : [first, 0]

  const cellWords = (r, hour) => heatCellWords(r.name, hour, grid.cells.get(r.key)?.[hour] ?? null, unit)
  const pointed = point ? rows[point[0]] : null

  const focusCell = (r, c) => {
    setActive([r, c])
    setPoint([r, c])
    body.current?.querySelector(`[data-cell="${r}-${c}"]`)?.focus()
  }
  const move = (e, r, c) => {
    const lines = rows.map((_, i) => i).filter(heated)
    const at = lines.indexOf(r)
    const target = {
      ArrowRight: [r, Math.min(23, c + 1)],
      ArrowLeft: [r, Math.max(0, c - 1)],
      ArrowDown: [lines[Math.min(lines.length - 1, at + 1)], c],
      ArrowUp: [lines[Math.max(0, at - 1)], c],
      Home: e.ctrlKey ? [lines[0], 0] : [r, 0],
      End: e.ctrlKey ? [lines[lines.length - 1], 23] : [r, 23],
    }[e.key]
    if (!target) return
    e.preventDefault()
    focusCell(target[0], target[1])
  }

  return (
    <div className="heatmap">
      <div className="heatmap-key" role="group" aria-label="Key">
        <span className="heatmap-key-item">
          <span className="heatmap-swatch heatmap-cell-none" aria-hidden="true" />
          No value
        </span>
        {bands.map(b => (
          <span key={b.step} className="heatmap-key-item">
            <span className={`heatmap-swatch heatmap-step-${b.step}`} aria-hidden="true" />
            {bandRangeWords(b, unit)}
          </span>
        ))}
      </div>
      <div
        className="heatmap-grid"
        role="grid"
        aria-label={`${metric}, the mean at each hour of the day`}
        aria-rowcount={rows.length + 1}
        aria-colcount={HOURS_OF_DAY.length + 1}
        ref={body}
        onPointerLeave={() => setPoint(null)}
      >
        <div className="heatmap-row" role="row">
          <span className="heatmap-label" role="columnheader"><span className="sr-only">Machine</span></span>
          {HOURS_OF_DAY.map(h => (
            <span key={h} className="heatmap-hour" role="columnheader" aria-label={hourWords(h)}>
              <span aria-hidden="true">{h % NAMED_EVERY === 0 ? String(h).padStart(2, '0') : ''}</span>
            </span>
          ))}
        </div>
        {rows.map((r, i) => {
          const hours = grid.cells.get(r.key)
          const offline = r.device && deviceLifecycleStatus(r.device) !== DEVICE_STATUS.ONLINE
          return (
            <div key={r.key} className="heatmap-row" role="row">
              <span className="heatmap-label" role="rowheader">
                {r.device && <DeviceStatusDot device={r.device} />}
                <OverflowText className="heatmap-name">{r.name}</OverflowText>
                {offline && <span className="device-offline-word">Offline</span>}
              </span>
              {r.absent || !hours ? (
                <span className="heatmap-absent" role="gridcell" aria-colspan={24}>{r.absent ?? silentWords(r.name, metric)}</span>
              ) : HOURS_OF_DAY.map(h => {
                const cell = hours[h]
                const here = i === row0 && h === col0
                return (
                  <span
                    key={h}
                    role="gridcell"
                    data-cell={`${i}-${h}`}
                    id={`${id}-${i}-${h}`}
                    className={`heatmap-cell ${cell ? `heatmap-step-${heatStep(cell.value, grid.low, grid.high, HEAT_STEPS)}` : 'heatmap-cell-none'}`}
                    tabIndex={here ? 0 : -1}
                    aria-label={cellWords(r, h)}
                    onPointerEnter={() => setPoint([i, h])}
                    onFocus={() => { setActive([i, h]); setPoint([i, h]) }}
                    onBlur={() => setPoint(null)}
                    onKeyDown={e => move(e, i, h)}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
      <p className="heatmap-readout" aria-hidden="true">
        {pointed ? cellWords(pointed, point[1]) : 'Point at a cell, or move to one with the arrow keys, to read it.'}
      </p>
    </div>
  )
}

import React from 'react'
import CopyableId from './CopyableId'
import { plural } from '../../utils/format'
import { unsBridgeOn, unsFilterFor, unsSkipSentence, unsTopicOf, unsTopicsMoved } from '../../utils/unsPath'

/**
 * The Unified Namespace rows of the Devices, Areas and Cells drawers, and the line a rename dialog
 * adds. `index` is utils/unsPath.js's unsPathIndex() of the view's rows: undefined before the read,
 * null when it failed. While the bridge is off each row says so, and nothing is read.
 */

const OFF = 'Not published: the Unified Namespace bridge is off.'
const OFF_HELP = "The bridge republishes every reading on a plain MQTT topic named by the plant. It is off unless ingestion.unsMqttEnabled is set in the chart's values."
const UNREAD = 'Could not be read just now.'

/** A device's topic, why it has none, or that the bridge is off. Null while there is no answer. */
export function unsTopicField({ index, device, cell, area, source, onCopy }) {
  const label = 'Unified Namespace Topic'
  if (!unsBridgeOn()) return { label, value: OFF, full: true, help: OFF_HELP }
  if (index === null) return { label, value: UNREAD, full: true }
  const row = index?.get(device?.asset_id)
  if (!row) return null
  const topic = unsTopicOf(row)
  if (!topic) return { label, value: unsSkipSentence(row.skip_reason, { device, cell, area, source }), full: true }
  return {
    label,
    full: true,
    value: (
      <div>
        <CopyableId value={topic} label="Unified Namespace topic" onNotify={onCopy} className="copyable-id-wrap" />
        <div className="cell-meta">
          Each metric publishes at <span className="mono">&lt;topic&gt;/&lt;metric name&gt;</span>.
        </div>
      </div>
    ),
    help: "Where the bridge republishes this device's readings, retained, as JSON. Renaming the device, its cell or its area moves it. The Sparkplug ID stays the device's identity."
  }
}

/**
 * The subscription filter for everything in an area (`areaId`) or a cell (`cellId`), labelled as a
 * filter: nothing publishes to the area or the cell itself.
 */
export function unsFilterField({ index, areaId, cellId, onCopy }) {
  const label = 'Unified Namespace Filter'
  const what = cellId ? 'cell' : 'area'
  if (!unsBridgeOn()) return { label, value: OFF, full: true, help: OFF_HELP }
  if (index === null) return { label, value: UNREAD, full: true }
  if (index === undefined) return null
  const filter = unsFilterFor(index, { areaId, cellId })
  if (!filter) {
    return {
      label,
      value: `No device in this ${what} is in the Unified Namespace yet.`,
      full: true,
      help: "Each device's details say why it is left out."
    }
  }
  return {
    label,
    full: true,
    value: <CopyableId value={filter} label="Unified Namespace filter" onNotify={onCopy} className="copyable-id-wrap" />,
    help: `A subscription filter, not a topic: nothing publishes to the ${what} itself. It matches the readings of every device in it. # matches every level below${filter.includes('/+/') ? ', and + any Sparkplug group' : ''}.`
  }
}

/**
 * Under a name being changed: how many devices' topics the rename moves. Only while the bridge
 * publishes, and only when it moves one.
 */
export function UnsRenameNote({ index, renamed, areaId, cellId, deviceId }) {
  if (!renamed || !unsBridgeOn()) return null
  const moved = unsTopicsMoved(index, { areaId, cellId, deviceId })
  if (moved === 0) return null
  return (
    <div className="form-hint">
      {deviceId
        ? 'Renaming it moves its Unified Namespace topic.'
        : `Renaming it moves the Unified Namespace topics of ${plural(moved, 'device')}.`}
      {' '}A program still subscribed to an old topic gets no new readings.
    </div>
  )
}

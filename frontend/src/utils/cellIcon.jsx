import React from 'react'
import {
  IconFactory, IconBot, IconCog, IconCircuitBoard,
  IconGauge, IconBuilding2, IconTruck, IconZap,
} from '../components/common/Icons'

/**
 * The cell icon registry. Mirrors the `cells_icon_valid` CHECK constraint: the database stores a
 * key, and only a bundled component can render it, so adding an icon is two edits. `label` names
 * the kind of cell ("Robotic assembly"), which is what the person choosing is describing.
 */
export const CELL_ICONS = [
  { key: 'Factory', label: 'General cell', Icon: IconFactory },
  { key: 'Bot', label: 'Robotic assembly', Icon: IconBot },
  { key: 'Cog', label: 'CNC & machining', Icon: IconCog },
  { key: 'CircuitBoard', label: 'PLC & controllers', Icon: IconCircuitBoard },
  { key: 'Gauge', label: 'Metrology & quality', Icon: IconGauge },
  { key: 'Building2', label: 'BMS & facility', Icon: IconBuilding2 },
  { key: 'Truck', label: 'AGV & logistics', Icon: IconTruck },
  { key: 'Zap', label: 'Energy & power', Icon: IconZap },
]

/** The database's default, and this module's fallback. One value, stated once. */
export const DEFAULT_CELL_ICON = 'Factory'

const BY_KEY = new Map(CELL_ICONS.map((entry) => [entry.key, entry]))

/**
 * The component for an icon key, falling back to the default rather than throwing: a cell row can
 * outlive this file's knowledge of its icon.
 */
export function cellIconComponent(key) {
  return (BY_KEY.get(key) || BY_KEY.get(DEFAULT_CELL_ICON)).Icon
}

/**
 * Render a cell's icon. Takes the cell rather than the key so every render site shares the
 * fallback.
 */
export function CellIcon({ cell, size = 16, className = '' }) {
  const Icon = cellIconComponent(cell?.icon)
  return <Icon size={size} className={className} />
}

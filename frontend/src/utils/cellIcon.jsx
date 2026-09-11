import React from 'react'
import {
  IconFactory, IconBot, IconCog, IconCircuitBoard,
  IconGauge, IconBuilding2, IconTruck, IconZap,
} from '../components/common/Icons'

/**
 * The cell icon registry.
 *
 * MIRRORS THE `cells_icon_valid` CHECK CONSTRAINT (archived migration 0021), and the mirroring is the point:
 * the database stores a KEY, not markup and not a URL, so the only thing that can render it is a
 * bundled component. A key the database accepts and this file does not know is a cell that draws
 * nothing -- which is why the constraint is a closed set rather than free text, and why adding an
 * icon is deliberately two edits.
 *
 * `label` is what the picker shows. It names the KIND OF CELL rather than the shape of the glyph
 * ("Robotic assembly", not "robot") because the person choosing is describing their floor, not
 * browsing an icon set.
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
 * The component for an icon key, falling back to the default.
 *
 * FALLS BACK RATHER THAN THROWING. A cell row can outlive this file's knowledge of its icon -- a
 * database restored from a newer schema, or a rollback -- and a card that renders the wrong glyph
 * is a far better failure than a shopfloor map that crashes on one unrecognised string.
 */
export function cellIconComponent(key) {
  return (BY_KEY.get(key) || BY_KEY.get(DEFAULT_CELL_ICON)).Icon
}

/**
 * Render a cell's icon.
 *
 * Takes the CELL rather than the key so callers cannot forget the fallback -- the three render
 * sites (Overview map, Cells tab, the picker's preview) all went through their own `cell.icon ||
 * 'Factory'` before this existed, which is three places for the default to drift.
 */
export function CellIcon({ cell, size = 16, className = '' }) {
  const Icon = cellIconComponent(cell?.icon)
  return <Icon size={size} className={className} />
}

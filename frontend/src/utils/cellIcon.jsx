import React from 'react'
import { picturesFor } from './iconPictures'

/**
 * The cell icon registry. Mirrors the `cells_icon_valid` CHECK constraint: the database stores a
 * key, and only a bundled component can render it, so a key added to one is added to the other.
 * Each `label` names the picture ("Robot"), from utils/iconPictures.js, which areas share.
 */
export const CELL_ICONS = picturesFor([
  'Factory', 'Bot', 'Cog', 'CircuitBoard', 'Gauge', 'Building2', 'Truck', 'Zap',
])

/** The database's default, and this module's fallback. One value, stated once. */
export const DEFAULT_CELL_ICON = 'Factory'

const BY_KEY = new Map(CELL_ICONS.map((entry) => [entry.key, entry]))

/** The registry entry for a key, or undefined for a key cells do not offer. */
export function cellIconEntry(key) {
  return BY_KEY.get(key)
}

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
export function CellIcon({ cell, size = 16 }) {
  const Icon = cellIconComponent(cell?.icon)
  return <Icon size={size} />
}

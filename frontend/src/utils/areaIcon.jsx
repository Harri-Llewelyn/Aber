import React from 'react'
import { picturesFor } from './iconPictures'

/**
 * The area icon registry. Mirrors the `areas_icon_valid` CHECK constraint (0001_baseline_schema.sql)
 * the way utils/cellIcon.jsx mirrors `cells_icon_valid`: the database stores a key, only a bundled
 * component can render it, and a key added to one is added to the other. Each `label` names the
 * picture ("Office block"), from utils/iconPictures.js, which cells share.
 */
export const AREA_ICONS = picturesFor([
  'Building2', 'Factory', 'Warehouse', 'FlaskConical', 'Truck', 'Parking', 'Trees', 'Zap',
])

/** The database's default, and this module's fallback. */
export const DEFAULT_AREA_ICON = 'Building2'

const BY_KEY = new Map(AREA_ICONS.map((entry) => [entry.key, entry]))

/** The registry entry for a key, or undefined for a key areas do not offer. */
export function areaIconEntry(key) {
  return BY_KEY.get(key)
}

/** The component for an icon key, falling back to the default rather than throwing. */
export function areaIconComponent(key) {
  return (BY_KEY.get(key) || BY_KEY.get(DEFAULT_AREA_ICON)).Icon
}

/** Render an area's icon. Takes the area so every render site shares the fallback. */
export function AreaIcon({ area, size = 16 }) {
  const Icon = areaIconComponent(area?.icon)
  return <Icon size={size} />
}

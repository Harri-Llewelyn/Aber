import React from 'react'
import {
  IconBuilding2, IconFactory, IconWarehouse, IconParkingSquare,
  IconTrees, IconFlaskConical, IconTruck, IconZap,
} from '../components/common/Icons'

/**
 * The area icon registry. Mirrors the `areas_icon_valid` CHECK constraint (0097) the way
 * utils/cellIcon.jsx mirrors `cells_icon_valid`: the database stores a key, only a bundled component
 * can render it, and adding one is two edits. `label` names what the area is for.
 */
export const AREA_ICONS = [
  { key: 'Building2', label: 'Office & general', Icon: IconBuilding2 },
  { key: 'Factory', label: 'Production hall', Icon: IconFactory },
  { key: 'Warehouse', label: 'Warehouse & stores', Icon: IconWarehouse },
  { key: 'FlaskConical', label: 'Laboratory', Icon: IconFlaskConical },
  { key: 'Truck', label: 'Loading bay & logistics', Icon: IconTruck },
  { key: 'Parking', label: 'Car park', Icon: IconParkingSquare },
  { key: 'Trees', label: 'Open area & yard', Icon: IconTrees },
  { key: 'Zap', label: 'Plant room & utilities', Icon: IconZap },
]

/** The database's default, and this module's fallback. */
export const DEFAULT_AREA_ICON = 'Building2'

const BY_KEY = new Map(AREA_ICONS.map((entry) => [entry.key, entry]))

/** The component for an icon key, falling back to the default rather than throwing. */
export function areaIconComponent(key) {
  return (BY_KEY.get(key) || BY_KEY.get(DEFAULT_AREA_ICON)).Icon
}

/** Render an area's icon. Takes the area so every render site shares the fallback. */
export function AreaIcon({ area, size = 16 }) {
  const Icon = areaIconComponent(area?.icon)
  return <Icon size={size} />
}

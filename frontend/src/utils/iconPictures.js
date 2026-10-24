import {
  IconFactory, IconBot, IconCog, IconCircuitBoard, IconGauge, IconBuilding2, IconTruck, IconZap,
  IconWarehouse, IconFlaskConical, IconParkingSquare, IconTrees,
} from '../components/common/Icons'

/**
 * Every glyph a cell or an area may show, by the key the database stores, with words for what it
 * draws. An icon is a picture to tell rows apart and classifies nothing, so a key has one label at
 * both levels. Which keys each level offers is its own CHECK's business (utils/cellIcon.jsx,
 * utils/areaIcon.jsx).
 */
export const ICON_PICTURES = {
  Factory: { label: 'Factory', Icon: IconFactory },
  Bot: { label: 'Robot', Icon: IconBot },
  Cog: { label: 'Gear', Icon: IconCog },
  CircuitBoard: { label: 'Circuit board', Icon: IconCircuitBoard },
  Gauge: { label: 'Gauge', Icon: IconGauge },
  Building2: { label: 'Office block', Icon: IconBuilding2 },
  Truck: { label: 'Lorry', Icon: IconTruck },
  Zap: { label: 'Lightning bolt', Icon: IconZap },
  Warehouse: { label: 'Warehouse', Icon: IconWarehouse },
  FlaskConical: { label: 'Flask', Icon: IconFlaskConical },
  Parking: { label: 'Parking sign', Icon: IconParkingSquare },
  Trees: { label: 'Trees', Icon: IconTrees },
}

/** One level's registry, in picker order, from the keys its CHECK admits. */
export function picturesFor(keys) {
  return keys.map((key) => ({ key, ...ICON_PICTURES[key] }))
}

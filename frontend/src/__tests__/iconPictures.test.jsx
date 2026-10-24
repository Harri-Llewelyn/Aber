import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { ICON_PICTURES } from '../utils/iconPictures'
import { CELL_ICONS, DEFAULT_CELL_ICON, cellIconEntry } from '../utils/cellIcon'
import { AREA_ICONS, DEFAULT_AREA_ICON, areaIconEntry } from '../utils/areaIcon'

/**
 * Cell and area icons are pictures to tell rows apart, and classify nothing. So each glyph has one
 * label, the words for what it draws, and the same glyph reads the same at both levels.
 */

const BOTH = [...CELL_ICONS, ...AREA_ICONS]

const groupBy = (entries, keyOf) => {
  const groups = new Map()
  for (const e of entries) {
    const k = keyOf(e)
    if (!groups.has(k)) groups.set(k, new Set())
    groups.get(k).add(e.label)
  }
  return groups
}

describe('one label per glyph, at both levels', () => {
  it('gives no key two labels', () => {
    for (const [key, labels] of groupBy(BOTH, e => e.key)) {
      expect([...labels], key).toHaveLength(1)
    }
  })

  it('gives no drawing two labels, and no label two drawings', () => {
    for (const [Icon, labels] of groupBy(BOTH, e => e.Icon)) {
      expect([...labels], Icon.name).toHaveLength(1)
    }
    const drawingsByLabel = new Map()
    for (const e of BOTH) drawingsByLabel.set(e.label, new Set([...(drawingsByLabel.get(e.label) || []), e.Icon]))
    for (const [label, drawings] of drawingsByLabel) expect(drawings.size, label).toBe(1)
  })

  it('names the twelve pictures in the words decided for them', () => {
    expect(Object.fromEntries(Object.entries(ICON_PICTURES).map(([k, v]) => [k, v.label]))).toEqual({
      Factory: 'Factory',
      Bot: 'Robot',
      Cog: 'Gear',
      CircuitBoard: 'Circuit board',
      Gauge: 'Gauge',
      Building2: 'Office block',
      Truck: 'Lorry',
      Zap: 'Lightning bolt',
      Warehouse: 'Warehouse',
      FlaskConical: 'Flask',
      Parking: 'Parking sign',
      Trees: 'Trees',
    })
    // Every picture is offered at one level or the other.
    expect(new Set(BOTH.map(e => e.key)).size).toBe(Object.keys(ICON_PICTURES).length)
  })

  it('draws every entry it offers', () => {
    for (const e of BOTH) {
      expect(typeof e.Icon, e.key).toBe('function')
      expect(e.label, e.key).toBeTruthy()
    }
  })
})

/**
 * Each level offers exactly the keys its CHECK admits, read from the migrations, so an icon the
 * picker offers is one the database stores. The two sets overlap but stay separate.
 */
describe('each level offers its own CHECK\'s keys', () => {
  const MIGRATIONS = path.resolve(__dirname, '../../../supabase/migrations')
  // The last definition in migration order is the one in force.
  const latestCheck = (pattern) => {
    let keys = null
    for (const file of fs.readdirSync(MIGRATIONS).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8')
      for (const m of sql.matchAll(pattern)) keys = [...m[1].matchAll(/'(\w+)'/g)].map(k => k[1])
    }
    return keys
  }

  it('offers a cell the eight keys of cells_icon_valid, and an area those of areas_icon_valid', () => {
    const cellKeys = latestCheck(/CONSTRAINT cells_icon_valid CHECK \(\(icon = ANY \(ARRAY\[([^\]]*)\]/g)
    const areaKeys = latestCheck(/CONSTRAINT areas_icon_valid CHECK \(\(icon = ANY \(ARRAY\[([^\]]*)\]/g)
    expect(cellKeys, 'cells_icon_valid has moved or no longer parses').toHaveLength(8)
    expect(areaKeys, 'areas_icon_valid has moved or no longer parses').toHaveLength(8)
    expect(CELL_ICONS.map(e => e.key).sort()).toEqual([...cellKeys].sort())
    expect(AREA_ICONS.map(e => e.key).sort()).toEqual([...areaKeys].sort())
  })

  it('looks a key up in its own level only', () => {
    expect(cellIconEntry('Bot')?.label).toBe('Robot')
    expect(areaIconEntry('Bot')).toBeUndefined()
    expect(areaIconEntry('Parking')?.label).toBe('Parking sign')
    expect(cellIconEntry('Parking')).toBeUndefined()
    expect(cellIconEntry(DEFAULT_CELL_ICON)).toBeTruthy()
    expect(areaIconEntry(DEFAULT_AREA_ICON)).toBeTruthy()
  })
})

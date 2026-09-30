import { describe, it, expect } from 'vitest'
import {
  kpis, kpiByName, iso22400Sections, iso22400Prefill, kpiTooltip, KPI_CATEGORY
} from '../utils/iso22400'
import { STANDARDS } from '../utils/standards'
import { composeMetricName } from '../utils/metricGroup'

// A slice of what iso22400_vocabulary holds once 0002_seed_data.sql has run.
const vocabulary = [
  { name: 'QUALITY', kpi_id: 'Q', category: 'OEE', unit: 'PERCENT', formula: 'Q = GQ / PQ', description: 'Quality ratio', semantic_id: 'https://aber.local/semantics/iso22400/QUALITY' },
  // ISO 22400-2's own term for the factor industry calls Performance. The catalog's
  // OEE/PERFORMANCE was superseded by OEE/EFFECTIVENESS in archived migration 0032.
  { name: 'EFFECTIVENESS', kpi_id: 'E', category: 'OEE', unit: 'PERCENT', formula: 'E = (PRI x PQ) / APT', description: 'Effectiveness ratio', semantic_id: 'https://aber.local/semantics/iso22400/EFFECTIVENESS' },
  { name: 'AVAILABILITY', kpi_id: 'A', category: 'OEE', unit: 'PERCENT', formula: 'A = APT / PBT', description: 'Availability ratio', semantic_id: 'https://aber.local/semantics/iso22400/AVAILABILITY' },
  { name: 'MTBF', kpi_id: 'MTBF', category: 'Maintenance', unit: 'HOUR', formula: 'MTBF = APT / number of failures', description: 'Mean operating time between failures', semantic_id: 'https://aber.local/semantics/iso22400/MTBF' },
  { name: 'SCRAP_RATIO', kpi_id: 'SR', category: 'Quality', unit: 'PERCENT', formula: 'SR = SQ / PQ', description: 'Scrap ratio', semantic_id: 'https://aber.local/semantics/iso22400/SCRAP_RATIO' }
]

describe('kpis', () => {
  it('orders by name regardless of the order the API returned them in', () => {
    expect(kpis(vocabulary).map(k => k.name)).toEqual(['AVAILABILITY', 'EFFECTIVENESS', 'MTBF', 'QUALITY', 'SCRAP_RATIO'])
  })

  it('survives an empty or missing vocabulary', () => {
    expect(kpis([])).toEqual([])
    expect(kpis(null)).toEqual([])
    expect(kpiByName(null, 'MTBF')).toBeNull()
  })
})

describe('iso22400Sections', () => {
  it('leads with OEE — it is what people open the panel for', () => {
    expect(iso22400Sections(vocabulary).map(s => s.title)).toEqual(['OEE', 'Maintenance', 'Quality'])
  })

  it('gives every section a stable unique key for collapse state', () => {
    const keys = iso22400Sections(vocabulary).map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('files a KPI under its own category, not all of them under OEE', () => {
    const maintenance = iso22400Sections(vocabulary).find(s => s.title === 'Maintenance')
    expect(maintenance.entries.map(k => k.name)).toEqual(['MTBF'])
  })

  it('uses ISO 22400-2 terminology — EFFECTIVENESS, not PERFORMANCE', () => {
    // Archived migration 0032 aligned the vocabulary with the standard's own wording and superseded the
    // catalog's OEE/PERFORMANCE metric. The old token must not reappear as a KPI definition.
    expect(kpis(vocabulary).map(k => k.name)).toContain('EFFECTIVENESS')
    expect(kpis(vocabulary).map(k => k.name)).not.toContain('PERFORMANCE')
    expect(kpiByName(vocabulary, 'EFFECTIVENESS').kpi_id).toBe('E')
  })
})

describe('iso22400Prefill', () => {
  const availability = kpiByName(vocabulary, 'AVAILABILITY')

  it('takes the unit and semantic id from the standard rather than asking', () => {
    const prefill = iso22400Prefill(availability)
    expect(prefill.units).toBe('PERCENT')
    expect(prefill.semanticId).toBe('https://aber.local/semantics/iso22400/AVAILABILITY')
    expect(prefill.standard).toBe(STANDARDS.ISO22400)
  })

  it('suggests the KPI family as the group, so the composed name matches the live catalog', () => {
    // The catalog already holds OEE/AVAILABILITY (archived migration 0019). A prefill that suggested any
    // other group would fork the taxonomy against immutable names.
    const prefill = iso22400Prefill(availability)
    expect(composeMetricName(prefill.group, '', prefill.type, '')).toBe('OEE/AVAILABILITY')
  })

  it('maps every KPI onto SAMPLE, the only MTConnect category that carries units', () => {
    for (const kpi of vocabulary) {
      expect(iso22400Prefill(kpi).category).toBe(KPI_CATEGORY)
    }
    expect(KPI_CATEGORY).toBe('SAMPLE')
  })

  it('returns null for nothing, so a cleared picker does not half-fill the form', () => {
    expect(iso22400Prefill(null)).toBeNull()
    expect(iso22400Prefill(undefined)).toBeNull()
  })
})

describe('kpiTooltip', () => {
  it('carries the formula, which is what makes a KPI searchable by meaning', () => {
    expect(kpiTooltip(kpiByName(vocabulary, 'MTBF'))).toContain('APT / number of failures')
  })

  it('shows the ISO symbol when it differs from the name', () => {
    expect(kpiTooltip(kpiByName(vocabulary, 'AVAILABILITY'))).toContain('(A)')
    // MTBF is its own symbol; repeating it would just be noise.
    expect(kpiTooltip(kpiByName(vocabulary, 'MTBF'))).not.toContain('(MTBF)')
  })
})

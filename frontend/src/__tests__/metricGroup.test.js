import { describe, it, expect } from 'vitest'
import {
  deriveMetricGroup, metricGroupOf, groupCatalog, catalogGroups, UNGROUPED_LABEL,
  knownGroupNames, canonicaliseGroup, isValidMetricName, metricNameError,
  groupOptionsByStandard, LOCAL_STANDARD_LABEL, groupOptionsForStandard
} from '../utils/metricGroup'

const metric = (name, extra = {}) => ({ metric_uuid: name, name, ...extra })

describe('deriveMetricGroup', () => {
  it('takes the first path segment', () => {
    expect(deriveMetricGroup('Axes/C/ANGLE')).toBe('Axes')
    expect(deriveMetricGroup('Environmental/HUMIDITY_RELATIVE')).toBe('Environmental')
  })

  it('returns null for a name with no separator', () => {
    // The whole starter catalog is flat; treating each of those as its own group would make
    // grouping worse than no grouping.
    expect(deriveMetricGroup('temperature')).toBeNull()
    expect(deriveMetricGroup('availability')).toBeNull()
  })

  it('returns null when the first segment would be empty', () => {
    // Mirrors the SQL's NULLIF guard for a name that merely starts with the separator.
    expect(deriveMetricGroup('/ANGLE')).toBeNull()
  })

  it('is unaffected by underscores, which are legal inside a segment', () => {
    // MTConnect data item types are UPPER_SNAKE, so this is the common case, not an edge case.
    expect(deriveMetricGroup('Axes/C/ANGULAR_VELOCITY')).toBe('Axes')
  })

  it('handles trailing separators and non-strings without throwing', () => {
    expect(deriveMetricGroup('Axes/')).toBe('Axes')
    expect(deriveMetricGroup('')).toBeNull()
    expect(deriveMetricGroup(null)).toBeNull()
    expect(deriveMetricGroup(undefined)).toBeNull()
  })
})

describe('metricGroupOf', () => {
  it('prefers the stored generated column', () => {
    expect(metricGroupOf({ name: 'Axes/C/ANGLE', metric_group: 'Axes' })).toBe('Axes')
  })

  it('falls back to local derivation when the column is absent', () => {
    // A row built client-side before it has been round-tripped through PostgREST.
    expect(metricGroupOf({ name: 'Axes/C/ANGLE' })).toBe('Axes')
    expect(metricGroupOf({ name: 'Axes/C/ANGLE', metric_group: null })).toBe('Axes')
  })

  it('is null for an ungrouped metric or no metric at all', () => {
    expect(metricGroupOf({ name: 'temperature', metric_group: null })).toBeNull()
    expect(metricGroupOf(null)).toBeNull()
  })
})

describe('groupCatalog', () => {
  const catalog = [
    metric('temperature'),
    metric('Environmental/HUMIDITY_RELATIVE'),
    metric('Axes/X/POSITION'),
    metric('Axes/C/ANGLE'),
    metric('availability')
  ]

  it('buckets metrics by their first segment, groups sorted, ungrouped last', () => {
    const groups = groupCatalog(catalog)
    expect(groups.map(g => g.label)).toEqual(['Axes', 'Environmental', UNGROUPED_LABEL])
    expect(groups[0].metrics.map(m => m.name)).toEqual(['Axes/C/ANGLE', 'Axes/X/POSITION'])
  })

  it('always places the ungrouped bucket last, not in alphabetical position', () => {
    // Otherwise "Ungrouped" buries itself under U and the mid-migration catalog reads oddly.
    const groups = groupCatalog([metric('Zebra/Stripes'), metric('flat')])
    expect(groups.map(g => g.label)).toEqual(['Zebra', UNGROUPED_LABEL])
  })

  it('marks the ungrouped bucket with a null key so it is not mistaken for a group', () => {
    const ungrouped = groupCatalog(catalog).find(g => g.isUngrouped)
    expect(ungrouped.key).toBeNull()
    expect(ungrouped.metrics.map(m => m.name)).toEqual(['availability', 'temperature'])
  })

  it('orders groups case-insensitively', () => {
    const groups = groupCatalog([metric('beta/x'), metric('Alpha/y')])
    expect(groups.map(g => g.label)).toEqual(['Alpha', 'beta'])
  })

  it('omits the ungrouped bucket entirely when every metric is categorised', () => {
    const groups = groupCatalog([metric('Axes/A'), metric('Axes/B')])
    expect(groups).toHaveLength(1)
    expect(groups[0].isUngrouped).toBe(false)
  })

  it('does not mutate the input array order', () => {
    const input = [metric('Axes/B'), metric('Axes/A')]
    groupCatalog(input)
    expect(input.map(m => m.name)).toEqual(['Axes/B', 'Axes/A'])
  })

  it('handles an empty or missing catalog', () => {
    expect(groupCatalog([])).toEqual([])
    expect(groupCatalog(null)).toEqual([])
  })
})

describe('catalogGroups', () => {
  it('lists real groups only — the absence of a group is not a group', () => {
    expect(catalogGroups([metric('Axes/A'), metric('flat'), metric('Environmental/B')]))
      .toEqual(['Axes', 'Environmental'])
  })

  it('is empty for a wholly flat catalog', () => {
    expect(catalogGroups([metric('temperature'), metric('availability')])).toEqual([])
  })
})

describe('knownGroupNames', () => {
  const registry = [{ name: 'Axes' }, { name: 'Environmental' }, { name: 'OEE' }]

  it('offers the curated registry even before any metric uses it', () => {
    // The bootstrapping case: a wholly flat catalog must still get a populated picker.
    expect(knownGroupNames(registry, [metric('temperature')]))
      .toEqual(['Axes', 'Environmental', 'OEE'])
  })

  it('includes groups in use but never registered', () => {
    // A metric inserted through the API can introduce a group the registry never saw.
    expect(knownGroupNames(registry, [metric('Hydraulic/PRESSURE')]))
      .toEqual(['Axes', 'Environmental', 'Hydraulic', 'OEE'])
  })

  it('does not list a group twice when it is both registered and in use', () => {
    expect(knownGroupNames(registry, [metric('Axes/C/ANGLE')]))
      .toEqual(['Axes', 'Environmental', 'OEE'])
  })

  it('prefers the registry spelling, since that is what the database treats as canonical', () => {
    expect(knownGroupNames([{ name: 'Axes' }], [metric('axes/Legacy')])).toEqual(['Axes'])
  })

  it('copes with either source missing', () => {
    expect(knownGroupNames(null, [metric('Axes/A')])).toEqual(['Axes'])
    expect(knownGroupNames(registry, null)).toEqual(['Axes', 'Environmental', 'OEE'])
    expect(knownGroupNames(null, null)).toEqual([])
  })
})

describe('groupOptionsByStandard', () => {
  const registry = [
    { name: 'Axes', standard: 'MTConnect' },
    { name: 'Controller', standard: 'MTConnect' },
    { name: 'OEE', standard: 'ISO 22400' },
    { name: 'Bespoke', standard: null }
  ]

  it('buckets groups by the standard they come from', () => {
    const options = groupOptionsByStandard(registry, [])
    expect(options.map(o => o.label)).toEqual(['ISO 22400', 'MTConnect', LOCAL_STANDARD_LABEL])
    expect(options.find(o => o.label === 'MTConnect').names).toEqual(['Axes', 'Controller'])
  })

  it('puts local groups last, after every named standard', () => {
    const options = groupOptionsByStandard(registry, [])
    expect(options[options.length - 1].label).toBe(LOCAL_STANDARD_LABEL)
    expect(options[options.length - 1].names).toEqual(['Bespoke'])
  })

  it('files a group that is in use but unregistered under Local', () => {
    // knownGroupNames picks it up from the catalog; the registry has no standard for it.
    const options = groupOptionsByStandard(registry, [metric('Hydraulic/PRESSURE')])
    expect(options.find(o => o.label === LOCAL_STANDARD_LABEL).names).toEqual(['Bespoke', 'Hydraulic'])
  })

  it('matches the registry case-insensitively when assigning a standard', () => {
    const options = groupOptionsByStandard([{ name: 'Axes', standard: 'MTConnect' }], [metric('axes/Legacy')])
    expect(options).toEqual([{ label: 'MTConnect', names: ['Axes'] }])
  })

  it('omits a standard with no groups, and copes with no registry at all', () => {
    expect(groupOptionsByStandard([], [metric('Axes/A')]))
      .toEqual([{ label: LOCAL_STANDARD_LABEL, names: ['Axes'] }])
    expect(groupOptionsByStandard(null, null)).toEqual([])
  })

  it('offers exactly the names knownGroupNames does, just bucketed', () => {
    const flat = knownGroupNames(registry, [metric('Hydraulic/PRESSURE')])
    const bucketed = groupOptionsByStandard(registry, [metric('Hydraulic/PRESSURE')])
      .flatMap(o => o.names)
    expect(bucketed.sort()).toEqual(flat.slice().sort())
  })
})

describe('canonicaliseGroup', () => {
  const known = ['Axes', 'Environmental']

  it('resolves a case variant to the established spelling', () => {
    // enforce_metric_group_spelling rejects the fork outright; the UI agrees with it rather
    // than letting the user find out by hitting the error.
    expect(canonicaliseGroup('axes', known)).toBe('Axes')
    expect(canonicaliseGroup('AXES', known)).toBe('Axes')
  })

  it('passes a genuinely new group through, trimmed', () => {
    expect(canonicaliseGroup('  Hydraulic  ', known)).toBe('Hydraulic')
  })

  it('leaves an exact match alone', () => {
    expect(canonicaliseGroup('Axes', known)).toBe('Axes')
  })

  it('is empty for empty input', () => {
    expect(canonicaliseGroup('   ', known)).toBe('')
    expect(canonicaliseGroup(null, known)).toBe('')
  })
})

describe('isValidMetricName', () => {
  it('accepts grouped and ungrouped names', () => {
    expect(isValidMetricName('Axes/C/ANGULAR_VELOCITY')).toBe(true)
    expect(isValidMetricName('temperature')).toBe(true)
  })

  it('rejects empty segments', () => {
    // A leading separator would derive a NULL group off a name that plainly looks grouped, and
    // the name is immutable, so the mismatch could never be corrected in place.
    expect(isValidMetricName('/ANGLE')).toBe(false)
    expect(isValidMetricName('Axes/')).toBe(false)
    expect(isValidMetricName('Axes//ANGLE')).toBe(false)
  })

  it('rejects blank input', () => {
    expect(isValidMetricName('')).toBe(false)
    expect(isValidMetricName('   ')).toBe(false)
    expect(isValidMetricName(null)).toBe(false)
  })

  it('rejects characters outside the Factory+ segment alphabet', () => {
    // Factory+ permits only alphanumerics and the underscore inside a segment. '.' is the separator
    // a reader from another stack reaches for first.
    expect(isValidMetricName('Legacy.Dotted.Name')).toBe(false)
    expect(isValidMetricName('has spaces')).toBe(false)
    expect(isValidMetricName('Axes/C-Axis/ANGLE')).toBe(false)
    expect(isValidMetricName('Axes/C:1/ANGLE')).toBe(false)
    expect(isValidMetricName('Motor#1/TEMP')).toBe(false)
  })

  it('accepts every metric the seeded catalog actually uses', () => {
    // The database adds the same rule as a CHECK. `name` is immutable, so a name that slipped past
    // the client can never be corrected, only deprecated.
    for (const name of [
      'Axes/C/ANGULAR_VELOCITY/ACTUAL', 'Axes/DISPLACEMENT', 'Controller/EMERGENCY_STOP',
      'Controller/EXECUTION', 'Controller/FIRMWARE', 'Machine/OperatingMode',
      'MotionDevice/OverridePercent', 'OEE/AVAILABILITY', 'OEE/EFFECTIVENESS', 'OEE/QUALITY',
      'SERIAL_NUMBER', 'Systems/TEMPERATURE', 'safety_interlock', 'max_temp_threshold',
    ]) {
      expect(isValidMetricName(name), name).toBe(true)
    }
  })
})

describe('metricNameError', () => {
  it('returns null for a valid name', () => {
    expect(metricNameError('Axes/C/ANGLE')).toBeNull()
    expect(metricNameError('safety_interlock')).toBeNull()
  })

  it('names the separator fault rather than the character set', () => {
    expect(metricNameError('/ANGLE')).toMatch(/cannot start with/)
    expect(metricNameError('Axes/')).toMatch(/cannot end with/)
    expect(metricNameError('Axes//ANGLE')).toMatch(/empty segment/)
  })

  it('lists the offending characters', () => {
    // The point of a message over a disabled button: it says which key to stop pressing.
    expect(metricNameError('Legacy.Dotted')).toMatch(/"\."/)
    expect(metricNameError('has spaces')).toMatch(/space/)
  })

  it('asks for a name rather than complaining about one when empty', () => {
    expect(metricNameError('')).toMatch(/Enter a metric name/)
  })

  it('agrees with deriveMetricGroup on everything it accepts', () => {
    // The invariant the guard exists to protect: an accepted grouped name always derives the
    // group the user actually picked.
    for (const name of ['Axes/ANGLE', 'Axes/C/ANGULAR_VELOCITY']) {
      expect(isValidMetricName(name)).toBe(true)
      expect(deriveMetricGroup(name)).toBe('Axes')
    }
  })
})

// The Add Metric form's Group picker filters by the selected Standard. Its own function, since
// groupOptionsByStandard()'s contract is every known group, bucketed.
describe('groupOptionsForStandard', () => {
  const registry = [
    { name: 'Axes', standard: 'MTConnect' },
    { name: 'Controller', standard: 'MTConnect' },
    { name: 'OEE', standard: 'ISO 22400' },
    { name: 'MotionDevice', standard: 'OPC UA' },
    { name: 'Hydraulic', standard: null }
  ]
  const metrics = []
  const namesFor = (standard) =>
    groupOptionsForStandard(registry, metrics, standard).flatMap(b => b.names).sort()

  it('offers only the selected standard, plus local groups', () => {
    expect(namesFor('MTConnect')).toEqual(['Axes', 'Controller', 'Hydraulic'])
    expect(namesFor('ISO 22400')).toEqual(['Hydraulic', 'OEE'])
    expect(namesFor('OPC UA')).toEqual(['Hydraulic', 'MotionDevice'])
  })

  it('always includes local groups, whatever the standard', () => {
    // Nothing ties a group to a standard: metric_groups.standard records where a group came from,
    // not what may use it, so a deployment that invented `Hydraulic` can file an MTConnect data
    // item under it.
    for (const standard of ['MTConnect', 'ISO 22400', 'OPC UA']) {
      expect(namesFor(standard)).toContain('Hydraulic')
    }
  })

  it('leaves only local groups for the Custom standard, which is the empty string', () => {
    // STANDARDS.CUSTOM is '' -- a custom metric is by definition not drawn from a vocabulary.
    expect(namesFor('')).toEqual(['Hydraulic'])
  })

  it('never offers a group belonging to a different standard', () => {
    expect(namesFor('MTConnect')).not.toContain('OEE')
    expect(namesFor('ISO 22400')).not.toContain('Axes')
  })

  it('keeps the bucket labels, so the picker still groups its optgroups', () => {
    const buckets = groupOptionsForStandard(registry, metrics, 'MTConnect')
    expect(buckets.map(b => b.label)).toEqual(['MTConnect', LOCAL_STANDARD_LABEL])
  })

  it('files an unregistered in-use group under Local, so it stays reachable', () => {
    const withUsed = groupOptionsForStandard(registry, [{ name: 'Spindle/SPEED' }], 'MTConnect')
    expect(withUsed.flatMap(b => b.names)).toContain('Spindle')
  })
})

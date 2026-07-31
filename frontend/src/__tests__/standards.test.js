import { describe, it, expect } from 'vitest'
import {
  STANDARDS, STANDARD_OPTIONS, SEMANTIC_ID_TYPES, DEFAULT_SEMANTIC_ID_TYPE,
  inferSemanticIdType, standardLabel, LOCAL_EXTENSION_LABEL,
  LOCAL_SEMANTIC_NAMESPACE, MTCONNECT_SEMANTIC_NAMESPACE, ISO22400_SEMANTIC_NAMESPACE,
  mtconnectSemanticId, mtconnectVocabularySemanticId
} from '../utils/standards'
import { MTCONNECT_STANDARD } from '../utils/mtconnect'

describe('standards registry', () => {
  it('stores a local extension as an empty standard, not the word "Custom"', () => {
    // The column is provenance and NULL means "no standard behind this". A literal 'Custom' would
    // read as a fourth standard and an AAS export would try to find a namespace for it.
    expect(STANDARDS.CUSTOM).toBe('')
    const custom = STANDARD_OPTIONS.find(o => o.label.startsWith('Custom'))
    expect(custom.value).toBe('')
  })

  it('offers every standard exactly once', () => {
    const values = STANDARD_OPTIONS.map(o => o.value)
    expect(new Set(values).size).toBe(values.length)
    expect(values).toContain(STANDARDS.MTCONNECT)
    expect(values).toContain(STANDARDS.ISO22400)
    expect(values).toContain(STANDARDS.OPCUA)
  })

  it('keeps one definition of the MTConnect provenance string', () => {
    // Two constants holding 'MTConnect' would silently fork the day one of them was corrected.
    expect(MTCONNECT_STANDARD).toBe(STANDARDS.MTCONNECT)
  })

  it('mirrors the CHECK constraint on semantic_id_type (migration 0029)', () => {
    expect(SEMANTIC_ID_TYPES).toEqual(['IRI', 'IRDI', 'ModelReference'])
    expect(SEMANTIC_ID_TYPES).toContain(DEFAULT_SEMANTIC_ID_TYPE)
  })
})

describe('inferSemanticIdType', () => {
  it('recognises an http(s) URI as an IRI', () => {
    expect(inferSemanticIdType('http://opcfoundation.org/UA/Robotics/ActualPosition')).toBe('IRI')
    expect(inferSemanticIdType('https://factoryplus.local/semantics/iso22400/MTBF')).toBe('IRI')
  })

  it('recognises a URN as an IRI', () => {
    expect(inferSemanticIdType('urn:example:concept:1')).toBe('IRI')
  })

  it('recognises an ISO/IEC 11179-6 IRDI', () => {
    expect(inferSemanticIdType('0173-1#02-AAO677#002')).toBe('IRDI')
  })

  it('guesses nothing rather than guessing wrong', () => {
    // A wrong inference is worse than none: it is prefilled, so it gets believed and saved.
    expect(inferSemanticIdType('ActualPosition')).toBe('')
    expect(inferSemanticIdType('')).toBe('')
    expect(inferSemanticIdType(null)).toBe('')
    expect(inferSemanticIdType('  ')).toBe('')
  })
})

describe('semantic id namespaces', () => {
  it('mints everything under one visibly-local base', () => {
    // The namespace is the honesty mechanism: `factoryplus.local` says whose identifier this is.
    // An id under mtconnect.org or iso.org would assert an interoperability that does not exist.
    expect(LOCAL_SEMANTIC_NAMESPACE).toBe('https://factoryplus.local/semantics')
    expect(MTCONNECT_SEMANTIC_NAMESPACE.startsWith(LOCAL_SEMANTIC_NAMESPACE)).toBe(true)
    expect(ISO22400_SEMANTIC_NAMESPACE.startsWith(LOCAL_SEMANTIC_NAMESPACE)).toBe(true)
    expect(MTCONNECT_SEMANTIC_NAMESPACE).not.toContain('mtconnect.org')
  })

  it('pins the MTConnect namespace to the major version, not the schema release', () => {
    // The vocabulary is generated from schema 2.8, but an id that changed on every regeneration
    // would defeat the purpose of being a stable identifier.
    expect(MTCONNECT_SEMANTIC_NAMESPACE).toContain('/v2.0')
    expect(MTCONNECT_SEMANTIC_NAMESPACE).not.toContain('2.8')
  })
})

describe('mtconnectSemanticId', () => {
  it('mirrors the SQL in migration 0032 — namespace plus the whole metric name', () => {
    expect(mtconnectSemanticId('Axes/C/ANGLE'))
      .toBe('https://factoryplus.local/semantics/mtconnect/v2.0/Axes/C/ANGLE')
  })

  it('uses the full path, not just the type — a catalog entry is a specific observation', () => {
    // Axes/C/ANGLE and Axes/X/ANGLE are different data items on different components.
    expect(mtconnectSemanticId('Axes/C/ANGLE')).not.toBe(mtconnectSemanticId('Axes/X/ANGLE'))
  })

  it('handles an ungrouped name', () => {
    expect(mtconnectSemanticId('SERIAL_NUMBER'))
      .toBe('https://factoryplus.local/semantics/mtconnect/v2.0/SERIAL_NUMBER')
  })

  it('returns empty for an empty name rather than a dangling namespace', () => {
    expect(mtconnectSemanticId('')).toBe('')
    expect(mtconnectSemanticId(null)).toBe('')
    expect(mtconnectSemanticId('   ')).toBe('')
  })

  it('produces something inferSemanticIdType reads back as an IRI', () => {
    expect(inferSemanticIdType(mtconnectSemanticId('Axes/C/ANGLE'))).toBe('IRI')
  })
})

describe('mtconnectVocabularySemanticId', () => {
  it('scopes a concept id by kind, because the vocabularies can collide on a name', () => {
    expect(mtconnectVocabularySemanticId('DATA_ITEM_TYPE', 'ANGLE'))
      .toBe('https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ANGLE')
    expect(mtconnectVocabularySemanticId('COMPONENT', 'Axes'))
      .toBe('https://factoryplus.local/semantics/mtconnect/v2.0/Component/Axes')
    expect(mtconnectVocabularySemanticId('SUB_TYPE', 'ACTUAL'))
      .toBe('https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ACTUAL')
    expect(mtconnectVocabularySemanticId('UNIT', 'MILLIMETER'))
      .toBe('https://factoryplus.local/semantics/mtconnect/v2.0/Unit/MILLIMETER')
    expect(mtconnectVocabularySemanticId('NATIVE_UNIT', 'HOUR'))
      .toBe('https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/HOUR')
  })

  it('keeps a component and a data item type of the same name apart', () => {
    expect(mtconnectVocabularySemanticId('COMPONENT', 'X'))
      .not.toBe(mtconnectVocabularySemanticId('DATA_ITEM_TYPE', 'X'))
  })

  it('is distinct from the observation-level id for the same token', () => {
    // The vocabulary row identifies the concept; the catalog row identifies a specific data item.
    expect(mtconnectVocabularySemanticId('DATA_ITEM_TYPE', 'ANGLE')).not.toBe(mtconnectSemanticId('ANGLE'))
  })

  it('returns empty for an empty name', () => {
    expect(mtconnectVocabularySemanticId('DATA_ITEM_TYPE', '')).toBe('')
  })
})

describe('standardLabel', () => {
  it('names the absence of a standard rather than rendering blank', () => {
    expect(standardLabel(null)).toBe(LOCAL_EXTENSION_LABEL)
    expect(standardLabel('')).toBe(LOCAL_EXTENSION_LABEL)
    expect(standardLabel('ISO 22400')).toBe('ISO 22400')
  })
})

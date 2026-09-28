import { describe, it, expect } from 'vitest'
import {
  STANDARDS, STANDARD_OPTIONS, SEMANTIC_ID_TYPES, DEFAULT_SEMANTIC_ID_TYPE,
  inferSemanticIdType, followSemanticIdType, storedSemanticIdPair, sameSemanticIdPair, standardLabel,
  LOCAL_EXTENSION_LABEL,
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

  it('mirrors the CHECK constraints on semantic_id_type (migration 0012)', () => {
    // ModelReference is withdrawn: the exporter emits every id as an ExternalReference, and one
    // text column cannot carry a ModelReference's typed key chain.
    expect(SEMANTIC_ID_TYPES).toEqual(['IRI', 'IRDI'])
    expect(SEMANTIC_ID_TYPES).toContain(DEFAULT_SEMANTIC_ID_TYPE)
  })
})

describe('inferSemanticIdType', () => {
  it('recognises an http(s) URI as an IRI', () => {
    expect(inferSemanticIdType('http://opcfoundation.org/UA/Robotics/ActualPosition')).toBe('IRI')
    expect(inferSemanticIdType('https://aber.local/semantics/iso22400/MTBF')).toBe('IRI')
  })

  it('recognises a URN as an IRI', () => {
    expect(inferSemanticIdType('urn:example:concept:1')).toBe('IRI')
  })

  it('recognises an ISO/IEC 11179-6 IRDI', () => {
    expect(inferSemanticIdType('0173-1#02-AAO677#002')).toBe('IRDI')
  })

  it('recognises the IEC CDD form the Digital Nameplate seeds', () => {
    // 0002_seed_data.sql, ManufacturerName and ManufacturerProductRoot. Empty registration
    // authority parts and an underscore in the organisation part are both in the seed.
    expect(inferSemanticIdType('0112/2///61987#ABA565#009')).toBe('IRDI')
    expect(inferSemanticIdType('0112/2///61360_7#AAS011#001')).toBe('IRDI')
  })

  it('recognises the ECLASS property-value pair the Digital Nameplate seeds', () => {
    // 0002_seed_data.sql, AssetSpecificProperties: two IRDIs joined by a slash.
    expect(inferSemanticIdType('0173-1#02-ABI218#003/0173-1#01-AGZ672#004')).toBe('IRDI')
  })

  it('does not call an IRDI-like near miss an IRDI', () => {
    expect(inferSemanticIdType('0173-1#02-AAO677')).toBe('')             // no version
    expect(inferSemanticIdType('173-1#02-AAO677#002')).toBe('')          // three-digit ICD
    expect(inferSemanticIdType('0173-1##002')).toBe('')                  // no data identifier
    expect(inferSemanticIdType('0173-1#02-AAO677#002/')).toBe('')        // dangling pair
    expect(inferSemanticIdType('see 0173-1#02-AAO677#002')).toBe('')     // free text around one
    expect(inferSemanticIdType('0173-1#02-AAO677#002 (ECLASS)')).toBe('')
  })

  it('reads a URL holding an IRDI as the IRI it is', () => {
    expect(inferSemanticIdType('https://eclass.example/0173-1#02-AAO677#002')).toBe('IRI')
  })

  it('guesses nothing rather than guessing wrong', () => {
    // A wrong inference is worse than none: it is prefilled, so it gets believed and saved.
    expect(inferSemanticIdType('ActualPosition')).toBe('')
    expect(inferSemanticIdType('')).toBe('')
    expect(inferSemanticIdType(null)).toBe('')
    expect(inferSemanticIdType('  ')).toBe('')
  })
})

describe('followSemanticIdType', () => {
  const IRI = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate'
  const IRDI = '0112/2///61987#ABA565#009'

  it('guesses the type for a first id', () => {
    expect(followSemanticIdType('', '', IRI)).toBe('IRI')
  })

  it('retypes an id whose type was the guess, so replacing an IRI with an IRDI says IRDI', () => {
    expect(followSemanticIdType(IRI, 'IRI', IRDI)).toBe('IRDI')
  })

  it('keeps a type chosen against the guess', () => {
    expect(followSemanticIdType('ActualPosition', 'IRI', 'ActualPositionX')).toBe('IRI')
  })

  it('clears the type with the id, so a retracted claim leaves nothing half-filled', () => {
    expect(followSemanticIdType(IRI, 'IRI', '')).toBe('')
    expect(followSemanticIdType('ActualPosition', 'IRDI', '   ')).toBe('')
  })
})

describe('storedSemanticIdPair', () => {
  it('trims the id and drops a type that has no id', () => {
    expect(storedSemanticIdPair('  urn:x  ', 'IRI')).toEqual({ semanticId: 'urn:x', semanticIdType: 'IRI' })
    expect(storedSemanticIdPair('', 'IRDI')).toEqual({ semanticId: '', semanticIdType: '' })
    expect(storedSemanticIdPair(null, null)).toEqual({ semanticId: '', semanticIdType: '' })
  })
})

describe('sameSemanticIdPair', () => {
  it('compares pairs as they would be stored', () => {
    expect(sameSemanticIdPair({ semanticId: ' urn:x ', semanticIdType: 'IRI' }, { semanticId: 'urn:x', semanticIdType: 'IRI' })).toBe(true)
    // A type on a blank id is not stored, so it does not make two blanks differ.
    expect(sameSemanticIdPair({ semanticId: '', semanticIdType: 'IRDI' }, { semanticId: '', semanticIdType: '' })).toBe(true)
    expect(sameSemanticIdPair({ semanticId: 'urn:x', semanticIdType: 'IRI' }, { semanticId: 'urn:x', semanticIdType: 'IRDI' })).toBe(false)
    expect(sameSemanticIdPair(null, { semanticId: 'urn:x', semanticIdType: 'IRI' })).toBe(false)
  })
})

describe('semantic id namespaces', () => {
  it('mints everything under one visibly-local base', () => {
    // The namespace is the honesty mechanism: `aber.local` says whose identifier this is.
    // An id under mtconnect.org or iso.org would assert an interoperability that does not exist.
    expect(LOCAL_SEMANTIC_NAMESPACE).toBe('https://aber.local/semantics')
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
  it('is the vocabulary id of the data item type, the form mtconnect_vocabulary seeds (#457)', () => {
    expect(mtconnectSemanticId('ANGLE'))
      .toBe('https://aber.local/semantics/mtconnect/v2.0/DataItemType/ANGLE')
    expect(mtconnectSemanticId('ANGLE')).toBe(mtconnectVocabularySemanticId('DATA_ITEM_TYPE', 'ANGLE'))
  })

  it('names the concept, so two metrics of one type share an id', () => {
    // Axes/X/POSITION and Axes/W/POSITION are two data items and one concept. The component path,
    // instance and subType stay in the name and the sub_type column.
    expect(mtconnectSemanticId('POSITION'))
      .toBe('https://aber.local/semantics/mtconnect/v2.0/DataItemType/POSITION')
    expect(mtconnectSemanticId('POSITION')).not.toContain('Axes')
  })

  it('returns empty for an empty type rather than a dangling namespace', () => {
    expect(mtconnectSemanticId('')).toBe('')
    expect(mtconnectSemanticId(null)).toBe('')
    expect(mtconnectSemanticId('   ')).toBe('')
  })

  it('produces something inferSemanticIdType reads back as an IRI', () => {
    expect(inferSemanticIdType(mtconnectSemanticId('ANGLE'))).toBe('IRI')
  })
})

describe('mtconnectVocabularySemanticId', () => {
  it('scopes a concept id by kind, because the vocabularies can collide on a name', () => {
    expect(mtconnectVocabularySemanticId('DATA_ITEM_TYPE', 'ANGLE'))
      .toBe('https://aber.local/semantics/mtconnect/v2.0/DataItemType/ANGLE')
    expect(mtconnectVocabularySemanticId('COMPONENT', 'Axes'))
      .toBe('https://aber.local/semantics/mtconnect/v2.0/Component/Axes')
    expect(mtconnectVocabularySemanticId('SUB_TYPE', 'ACTUAL'))
      .toBe('https://aber.local/semantics/mtconnect/v2.0/SubType/ACTUAL')
    expect(mtconnectVocabularySemanticId('UNIT', 'MILLIMETER'))
      .toBe('https://aber.local/semantics/mtconnect/v2.0/Unit/MILLIMETER')
    expect(mtconnectVocabularySemanticId('NATIVE_UNIT', 'HOUR'))
      .toBe('https://aber.local/semantics/mtconnect/v2.0/NativeUnit/HOUR')
  })

  it('keeps a component and a data item type of the same name apart', () => {
    expect(mtconnectVocabularySemanticId('COMPONENT', 'X'))
      .not.toBe(mtconnectVocabularySemanticId('DATA_ITEM_TYPE', 'X'))
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

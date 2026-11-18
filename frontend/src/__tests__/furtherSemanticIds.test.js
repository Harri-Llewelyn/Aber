import { describe, it, expect } from 'vitest'
import {
  FURTHER_ID_MAX_LENGTH, FURTHER_SOURCE_MAX_LENGTH, MAX_FURTHER_SEMANTIC_IDS,
  furtherIdProblem, furtherIdsChange, furtherIdsOf
} from '../utils/furtherSemanticIds'

const OWN = 'nsu=http://opcfoundation.org/UA/Machinery/;i=6003'
const ECLASS = '0112/2///61987#ABA951#009'
const CDD = '0112/2///62683#ACE000#001'
const row = (semanticId, semanticIdType = 'IRDI', source = '') => ({ semanticId, semanticIdType, source })

describe('the further semantic ids of a metric', () => {
  it('reads the rows a metric carries by id, with the type and source as the dialog edits them', () => {
    const metric = {
      further_semantic_ids: [
        { semantic_id: CDD, semantic_id_type: 'IRDI', source: null },
        { semantic_id: ECLASS, semantic_id_type: 'IRDI', source: 'ECLASS 14.0' }
      ]
    }
    expect(furtherIdsOf(metric)).toEqual([row(CDD), row(ECLASS, 'IRDI', 'ECLASS 14.0')].sort((a, b) => a.semanticId.localeCompare(b.semanticId)))
    expect(furtherIdsOf({})).toEqual([])
    expect(furtherIdsOf(null)).toEqual([])
  })

  it('states the limits the table holds', () => {
    expect([MAX_FURTHER_SEMANTIC_IDS, FURTHER_ID_MAX_LENGTH, FURTHER_SOURCE_MAX_LENGTH]).toEqual([10, 2000, 500])
  })
})

describe('why an id typed under Further Semantic ID cannot be added yet', () => {
  const ask = (over = {}) => furtherIdProblem({
    draft: { semanticId: ECLASS, semanticIdType: 'IRDI' }, source: '', ownId: OWN, listed: [], ...over
  })

  it('says nothing about an empty field, and nothing about an id that can be added', () => {
    expect(ask({ draft: { semanticId: '', semanticIdType: '' } })).toBeNull()
    expect(ask({ draft: { semanticId: '   ', semanticIdType: 'IRI' } })).toBeNull()
    expect(ask()).toBeNull()
  })

  it('refuses a metric with no id of its own, the metric’s own id, and an id already listed', () => {
    expect(ask({ ownId: '' })).toMatch(/Give the metric a semantic id of its own first/)
    expect(ask({ draft: { semanticId: ` ${OWN} `, semanticIdType: 'ExpandedNodeId' } })).toMatch(/metric’s own semantic id/)
    expect(ask({ listed: [ECLASS] })).toMatch(/already in the list/)
  })

  it('refuses an eleventh, an overlong id, a missing type and an overlong source', () => {
    const ten = Array.from({ length: 10 }, (_, n) => `https://example.org/${n}`)
    expect(ask({ listed: ten })).toMatch(/at most 10 further semantic ids/)
    expect(ask({ draft: { semanticId: 'x'.repeat(2001), semanticIdType: 'IRI' } })).toMatch(/at most 2000 characters/)
    expect(ask({ draft: { semanticId: ECLASS, semanticIdType: '' } })).toMatch(/Choose the reference type/)
    expect(ask({ source: 'y'.repeat(501) })).toMatch(/source is at most 500 characters/)
    expect(ask({ source: `  ${'y'.repeat(500)}  ` })).toBeNull()
  })
})

describe('what saving the list writes', () => {
  it('writes nothing for the list the metric has', () => {
    expect(furtherIdsChange([row(ECLASS)], [row(ECLASS)])).toBeNull()
    expect(furtherIdsChange([], [])).toBeNull()
  })

  it('adds what is new, with its source trimmed or null, and removes what is gone', () => {
    expect(furtherIdsChange([row(ECLASS)], [row(ECLASS), row(CDD, 'IRDI', '  The template  ')])).toEqual({
      add: [{ semantic_id: CDD, semantic_id_type: 'IRDI', source: 'The template' }], remove: []
    })
    expect(furtherIdsChange([row(ECLASS), row(CDD)], [row(CDD)])).toEqual({ add: [], remove: [ECLASS] })
    expect(furtherIdsChange([row(ECLASS)], [row(CDD)])).toEqual({
      add: [{ semantic_id: CDD, semantic_id_type: 'IRDI', source: null }], remove: [ECLASS]
    })
  })

  it('treats an id taken out and put back as no change, and one put back as another type as its replacement', () => {
    expect(furtherIdsChange([row(ECLASS, 'IRDI', 'ECLASS 14.0')], [row(ECLASS, 'IRDI', 'ECLASS 14.0')])).toBeNull()
    expect(furtherIdsChange([row(ECLASS, 'IRDI')], [row(ECLASS, 'IRI')])).toEqual({
      add: [{ semantic_id: ECLASS, semantic_id_type: 'IRI', source: null }], remove: [ECLASS]
    })
  })
})

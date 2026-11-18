import { describe, it, expect } from 'vitest'
import { mtconnectVocabularyTab } from '../components/common/MTConnectVocabularyPanel'

/**
 * A data item type shows the text MTConnect publishes for it (migration 0301); every other kind of
 * entry, and a type with no text, shows its name alone.
 */
const VOCABULARY = [
  { kind: 'DATA_ITEM_TYPE', name: 'POSITION', category: 'SAMPLE', semantic_id: 'p', description: 'point along an axis in a cartesian coordinate system.' },
  { kind: 'DATA_ITEM_TYPE', name: 'ELEVATION', category: 'SAMPLE', semantic_id: 'e', description: null },
  { kind: 'COMPONENT', name: 'Axes', category: null, semantic_id: 'a', description: null },
  // A unit that shares a data item type's name is not given that type's text.
  { kind: 'UNIT', name: 'POSITION', category: null, semantic_id: 'u', description: null }
]

const itemIn = (tab, title, name) =>
  tab.sections.find(s => s.title.startsWith(title)).items.find(i => i.name === name)

describe('the MTConnect tab shows each data item type its own definition', () => {
  const tab = mtconnectVocabularyTab({ vocabulary: VOCABULARY, catalog: [] })

  it('names the type, then says what it is', () => {
    expect(tab.tooltipFor(itemIn(tab, 'Data Item Types', 'POSITION')))
      .toBe('POSITION — point along an axis in a cartesian coordinate system.')
  })

  it('leaves a type with no text to its name', () => {
    expect(tab.tooltipFor(itemIn(tab, 'Data Item Types', 'ELEVATION'))).toBe('')
  })

  it('gives a component or a unit no definition, even beside a type of that name', () => {
    expect(tab.tooltipFor(itemIn(tab, 'Components', 'Axes'))).toBe('')
    expect(tab.tooltipFor(itemIn(tab, 'Units', 'POSITION'))).toBe('')
  })
})

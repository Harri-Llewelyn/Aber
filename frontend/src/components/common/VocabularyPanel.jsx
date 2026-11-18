import React, { useState, useMemo } from 'react'
import { IconBookOpen, IconFileCode } from './Icons'
import { CardHeading } from './CardHeading'
import { TabStrip } from './TabStrip'
import { SearchInput } from './SearchInput'
import { EmptyState } from './EmptyState'
import { ExpandAllToggle } from './ExpandAllToggle'
import { useUrlState, useUrlTab, pathSlug } from '../../hooks/useUrlState'
import { VocabularySections } from './VocabularySections'

/**
 * The standard vocabularies as the page's one card: its heading, a tab per standard whose tooltip
 * is the standard's `hint`, a toolbar row (the search), the row Expand all starts, then the selected
 * standard's sections, which scroll inside the card (`.card-fill`; the page supplies `.page-fill`). What a
 * standard is, and what to watch for in it, is on the page's help page. What differs per standard
 * arrives as a tab descriptor (how sections are derived, what an entry's tooltip says, the id it
 * shows on a line of its own (`idFor`, `{ label, value }`), a sentence on a line of its own after the
 * tooltip (`noteFor`, a standard's source for the entry), what counts as in use); see
 * common/MTConnectVocabularyPanel.jsx and its siblings. A descriptor's `notice` is a line the
 * standard asks to be shown with it, such as QUDT's credit, at the right-hand end of the row Expand
 * all starts. The search matches the name, the tooltip and the id. Sections start collapsed,
 * and searching opens only the sections that match. An entry is clickable when its tab has an
 * `onUse` and the viewer can add a metric.
 *
 * A tab whose rows the page does not hold, such as the vocabularies a site imported, carries a
 * `panel` instead: an element that loads its own data and draws everything under the tab bar, with
 * the same `VocabularySections` for its concepts. The tab bar and the heading are the panel's frame
 * all the same.
 */
export function VocabularyPanel({ title = 'Vocabulary', subtitle, tabs, canAddMetric }) {
  const available = (tabs || []).filter(Boolean)
  // The standard on show, in the path by its slug (`/vocabulary/opc-ua`); the first is the bare
  // page. The search is a query parameter that stays across a switch, so one query asks every
  // standard.
  const [activeSlug, setActiveSlug, slugHref] = useUrlTab('vocabulary', available.map(t => pathSlug(t.id)), pathSlug(available[0]?.id), { keep: ['search'] })
  const activeId = available.find(t => pathSlug(t.id) === activeSlug)?.id
  const setActiveId = (id) => setActiveSlug(pathSlug(id))
  const [search, setSearch] = useUrlState('search')
  const [expanded, setExpanded] = useState({})

  // Falls back to the first tab rather than rendering nothing: the vocabularies load
  // asynchronously, so the selected id can briefly name a tab that does not exist yet.
  const active = available.find(t => t.id === activeId) || available[0]

  const query = search.trim().toLowerCase()

  // Matches the tooltip as well as the name: an ISO KPI is far more findable by "scrap" or by its
  // formula than by the exact token, and the tooltip is where that text lives.
  const filtered = useMemo(() => {
    const sections = active?.sections || []
    if (!query) return sections
    return sections
      .map(s => ({
        ...s,
        items: s.items.filter(i =>
          i.name.toLowerCase().includes(query) ||
          (active.tooltipFor?.(i) || '').toLowerCase().includes(query) ||
          (active.idFor?.(i)?.value || '').toLowerCase().includes(query)
        )
      }))
      .filter(s => s.items.length > 0)
  }, [active, query])

  if (!active) return null

  // While searching, a section is open unless explicitly collapsed -- the matches are the point.
  // Section keys are namespaced per standard, so one map serves every tab without collisions.
  const isOpen = (key) => (query ? expanded[key] !== false : expanded[key] === true)
  const toggle = (key) => setExpanded(prev => ({ ...prev, [key]: !isOpen(key) }))
  // Writes every section of this standard explicitly, `false` included, so Collapse all also
  // closes the sections a search opened.
  const setAll = (open) => setExpanded(prev => ({
    ...prev,
    ...Object.fromEntries((active.sections || []).map(s => [s.key, open]))
  }))

  // The tab names the standard on show, so nothing below repeats it. The search text survives a
  // switch, so one query asks every standard.
  const head = (
    <>
      <CardHeading icon={<IconFileCode size={15} />} title={title} description={subtitle} />
      <TabStrip
        ariaLabel={title}
        value={active.id}
        onChange={setActiveId}
        hrefFor={id => slugHref(pathSlug(id))}
        tabs={available.map(tab => ({
          id: tab.id,
          label: tab.label,
          description: tab.hint || `Browse the ${tab.label} vocabulary.`,
        }))}
      />
    </>
  )

  if (active.panel) {
    return (
      <div className="card card-fill">
        {head}
        {active.panel}
      </div>
    )
  }

  return (
    <div className="card card-fill">
      {head}

      <div className="filter-bar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={active.searchPlaceholder || 'Search the vocabulary…'}
          ariaLabel={`Search the ${active.label} vocabulary`}
        />
      </div>

      {/* The control that acts on the sections sits at the start of the row over them, not in the
          toolbar. */}
      <div className="groups-header">
        <ExpandAllToggle
          anyOpen={filtered.some(s => isOpen(s.key))}
          onExpandAll={() => setAll(true)}
          onCollapseAll={() => setAll(false)}
          disabled={filtered.length === 0}
        />
        {active.notice && <span className="vocab-notice">{active.notice}</span>}
      </div>

      {query && filtered.length === 0 && (
        <EmptyState
          icon={<IconBookOpen size={36} />}
          message={`Nothing in the ${active.label} vocabulary matches “${search}”.`}
        />
      )}

      {/* The card's scroller. At most seven sections per standard, so the headings are scanned as a
          list; each pins to the top while its chips scroll under it. */}
      <div className="vocab-sections card-fill-scroll">
        <VocabularySections
          sections={filtered}
          tab={active}
          canAddMetric={canAddMetric}
          isOpen={isOpen}
          toggle={toggle}
        />
      </div>
    </div>
  )
}

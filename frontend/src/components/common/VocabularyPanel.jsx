import React, { useState, useMemo } from 'react'
import { IconChevronDown, IconChevronUp, IconCheck, IconBookOpen, IconFileCode, IconPlus } from './Icons'
import { HelpTip } from './HelpTip'
import { CardHeading } from './CardHeading'
import { TabStrip } from './TabStrip'
import { SearchInput } from './SearchInput'
import { EmptyState } from './EmptyState'
import { ExpandAllToggle } from './ExpandAllToggle'

/**
 * The standard vocabularies as the page's one card: its heading, a tab per standard, a toolbar row
 * (the standard's "?", the search, Expand all), then the selected standard's sections, which scroll
 * inside the card (`.card-fill`; the page supplies `.page-fill`). What differs per standard arrives
 * as a tab descriptor (how sections are derived, what an entry's tooltip says, what counts as in
 * use); see common/MTConnectVocabularyPanel.jsx and its siblings. Sections start collapsed, and
 * searching opens only the sections that match. An entry is clickable when its tab has an `onUse`
 * and the viewer can add a metric.
 */
export function VocabularyPanel({ title = 'Vocabulary', subtitle, tabs, canAddMetric }) {
  const available = (tabs || []).filter(Boolean)
  const [activeId, setActiveId] = useState(available[0]?.id)
  const [search, setSearch] = useState('')
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
          (active.tooltipFor?.(i) || '').toLowerCase().includes(query)
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

  /* The standard's own description and its caveats, read on demand rather than standing above every
     entry: they say what the vocabulary is, which is a thing to check once, not a thing to re-read
     on each visit. */
  const standardTip = (
    <>
      {active.description}
      {(active.notes || []).map((note, i) => (
        <span key={i} className="vocab-note">
          {note.label && <strong>{note.label}</strong>}
          {note.body}
        </span>
      ))}
    </>
  )

  return (
    <div className="card card-fill">
      <CardHeading icon={<IconFileCode size={15} />} title={title} description={subtitle} />

      {/* The tab names the standard on show, so nothing below repeats it. The search text survives
          a switch, so one query asks every standard. */}
      <TabStrip
        ariaLabel="Standard"
        value={active.id}
        onChange={setActiveId}
        tabs={available.map(tab => ({
          id: tab.id,
          label: tab.label,
          title: tab.hint || `Browse the ${tab.label} vocabulary`,
        }))}
      />

      <div className="filter-bar">
        <HelpTip label={`About the ${active.label} vocabulary`} text={standardTip} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={active.searchPlaceholder || 'Search the vocabulary…'}
          ariaLabel={`Search the ${active.label} vocabulary`}
        />
        <ExpandAllToggle
          anyOpen={filtered.some(s => isOpen(s.key))}
          onExpandAll={() => setAll(true)}
          onCollapseAll={() => setAll(false)}
          disabled={filtered.length === 0}
        />
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
        {filtered.map(section => {
          const open = isOpen(section.key)
          const used = active.isUsed ? section.items.filter(i => active.isUsed(i)).length : 0
          return (
            <div key={section.key}>
              {/* The button is the keyboard control; a click anywhere else on the band toggles too,
                  except on the "?", which a button cannot contain. */}
              <div
                className="vocab-section-head"
                onClick={e => { if (!e.target.closest('button')) toggle(section.key) }}
              >
                <button
                  type="button"
                  className="table-group-button"
                  onClick={() => toggle(section.key)}
                  aria-expanded={open}
                  title={open ? 'Collapse this section' : 'Expand this section'}
                >
                  {open ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                  <span className="table-group-label">{section.title}</span>
                </button>
                {section.hint && <HelpTip label={`About ${section.title}`} text={section.hint} />}
                {used > 0 && (
                  <span className="vocab-in-use" title={`${used} already used by a catalog metric`}>
                    {used} in use
                  </span>
                )}
              </div>

              {open && (
                <div className="vocab-section-body">
                  <div className="vocab-chips">
                    {section.items.map(item => {
                      const inUse = active.isUsed ? active.isUsed(item) : false
                      const actionable =
                        !!active.onUse && canAddMetric && (active.isActionable ? active.isActionable(item) : true)
                      const meta = active.metaFor?.(item)
                      const tooltip = active.tooltipFor?.(item) || item.name
                      return (
                        <span
                          key={item.id || item.name}
                          role={actionable ? 'button' : undefined}
                          tabIndex={actionable ? 0 : undefined}
                          onClick={actionable ? () => active.onUse(item) : undefined}
                          onKeyDown={actionable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); active.onUse(item) } } : undefined}
                          aria-label={actionable
                            ? `Start a catalog metric from ${item.name}${inUse ? ', already used by one' : ''}`
                            : undefined}
                          className={`mono vocab-chip${inUse ? ' vocab-chip-used' : ''}${actionable ? ' vocab-chip-action' : ''}`}
                          title={
                            inUse ? `${tooltip} — already used by a catalog metric`
                              : actionable ? `${tooltip} — click to start a new catalog metric from this`
                                : tooltip
                          }
                        >
                          {inUse && <IconCheck size={10} />}{item.name}
                          {meta && <span className="vocab-chip-meta">{meta}</span>}
                          {/* Shown on hover and keyboard focus only (App.css); its space is kept at
                              rest so a chip does not grow and re-wrap the row under the pointer. */}
                          {actionable && <IconPlus size={10} className="vocab-chip-plus" />}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

import React, { useState, useMemo } from 'react'
import { IconChevronDown, IconChevronUp, IconCheck, IconBookOpen, IconFileCode } from './Icons'
import { HelpTip } from './HelpTip'
import { PageHeading } from './PageHeading'
import { SectionCount } from './SectionCount'
import { SearchInput } from './SearchInput'
import { EmptyState } from './EmptyState'

/**
 * The standard vocabularies as a page: one heading that does not change, a tab per standard, and
 * the selected standard's entries in a card of its own. What differs per standard arrives as a tab
 * descriptor (how sections are derived, what an entry's tooltip says, what counts as in use); see
 * common/MTConnectVocabularyPanel.jsx and its siblings. Sections start collapsed, and searching
 * opens only the sections that match. An entry is clickable when its tab has an `onUse` and the
 * viewer can add a metric.
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

  const total = (active.sections || []).reduce((n, s) => n + s.items.length, 0)
  const matches = filtered.reduce((n, s) => n + s.items.length, 0)

  // While searching, a section is open unless explicitly collapsed -- the matches are the point.
  // Section keys are namespaced per standard, so one map serves every tab without collisions.
  const isOpen = (key) => (query ? expanded[key] !== false : expanded[key] === true)
  const toggle = (key) => setExpanded(prev => ({ ...prev, [key]: !isOpen(key) }))

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
    <>
    <PageHeading icon={<IconFileCode size={15} />} title={title}>{subtitle}</PageHeading>

    {/* A segmented control rather than a dropdown so all four counts are visible at once. Above the
        card, not inside it: the heading names the page and this names which vocabulary is in it.
        The search text survives a switch, so one query asks every standard. */}
    <div
      role="tablist"
      aria-label="Standard"
      style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: 'var(--stack)' }}
    >
      {available.map(tab => {
        const selected = tab.id === active.id
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={selected}
            onClick={() => setActiveId(tab.id)}
            className={`btn btn-sm ${selected ? 'btn-primary' : 'btn-ghost'}`}
            title={tab.hint || `Browse the ${tab.label} vocabulary`}
          >
            {tab.label}
            <span className="section-count" style={{ marginLeft: '6px' }}>
              {(tab.sections || []).reduce((n, s) => n + s.items.length, 0)}
            </span>
          </button>
        )
      })}
    </div>

    <div className="card">
      {/* The card names the standard on show; the page heading above it says what the page is. */}
      <div className="card-header">
        <h3 className="section-title">
          {active.label}
          <HelpTip label={`About the ${active.label} vocabulary`} text={standardTip} />
          <SectionCount total={total} shown={matches} />
        </h3>
      </div>

      <div className="card-body">
        <div className="filter-bar">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={active.searchPlaceholder || 'Search the vocabulary…'}
            ariaLabel={`Search the ${active.label} vocabulary`}
          />
        </div>
      </div>

      {query && filtered.length === 0 && (
        <EmptyState
          icon={<IconBookOpen size={36} />}
          message={`Nothing in the ${active.label} vocabulary matches “${search}”.`}
        />
      )}

      {/* At most seven sections per standard, so the headings are scanned as a list. */}
      <div className="vocab-sections">
        {filtered.map(section => {
          const open = isOpen(section.key)
          const used = active.isUsed ? section.items.filter(i => active.isUsed(i)).length : 0
          return (
            <div key={section.key}>
              <div className="vocab-section-head">
                <button
                  type="button"
                  className="table-group-button"
                  onClick={() => toggle(section.key)}
                  aria-expanded={open}
                  title={open ? 'Collapse this section' : 'Expand this section'}
                >
                  {open ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                  <span className="table-group-label">{section.title}</span>
                  <span className="section-count">{section.items.length}</span>
                  {used > 0 && (
                    <span className="vocab-in-use" title={`${used} already used by a catalog metric`}>
                      {used} in use
                    </span>
                  )}
                </button>
              </div>

              {open && (
                <div className="vocab-section-body">
                  {section.hint && <p className="vocab-section-hint">{section.hint}</p>}
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
                          className={`mono vocab-chip${inUse ? ' vocab-chip-used' : ''}${actionable ? ' vocab-chip-action' : ''}`}
                          title={
                            inUse ? `${tooltip} — already used by a catalog metric`
                              : actionable ? `${tooltip} — click to start a new catalog metric from this`
                                : tooltip
                          }
                        >
                          {inUse && <IconCheck size={10} />}{item.name}
                          {meta && <span className="vocab-chip-meta">{meta}</span>}
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
    </>
  )
}

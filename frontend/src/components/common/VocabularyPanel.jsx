import React, { useState, useMemo } from 'react'
import { IconChevronDown, IconChevronUp, IconCheck, IconX, IconFileCode } from './Icons'
import { HelpTip } from './HelpTip'
import { PageHeading } from './PageHeading'

/**
 * The standard vocabularies as a page: one heading that does not change, a tab per standard, and
 * the selected standard's entries in a card of its own -- the shape Access Control and Settings
 * use. What differs per standard arrives as a tab descriptor (how sections are derived, what an
 * entry's tooltip says, what counts as in use); see common/MTConnectVocabularyPanel.jsx and its
 * siblings. Sections start collapsed, and searching expands only the sections that match.
 */
export function VocabularyPanel({ title = 'Standard Vocabulary Reference', subtitle, tabs, canAddMetric }) {
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
        <span key={i} style={{ display: 'block', marginTop: '6px' }}>
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

    <div className="card" style={{ marginBottom: 'var(--stack)' }}>
      {/* The card names the standard on show; the page heading above it says what the page is. */}
      <div className="card-header">
        <h3 className="section-title">
          {active.label}
          <HelpTip label={`About the ${active.label} vocabulary`} text={standardTip} />
          <span className="section-count">{query ? `${matches} / ${total}` : total}</span>
        </h3>
      </div>

      {/* One control row inside the card, where every other list page keeps its filters. */}
      <div className="card-body">
      <div className="filter-bar">
        <input
          className="form-control"
          style={{ width: '240px' }}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={active.searchPlaceholder || 'Search the vocabulary…'}
          title="Filter the selected standard by name or description"
        />
        {search && (
          <button className="btn btn-ghost btn-sm" onClick={() => setSearch('')} title="Clear the search">
            <IconX size={13} />
          </button>
        )}
      </div>
      </div>{/* .card-body */}

      {query && filtered.length === 0 && (
        <div className="empty-state">
          <div className="empty-text">Nothing in the {active.label} vocabulary matches “{search}”.</div>
        </div>
      )}

      <div style={{ padding: '4px var(--inset) 12px' }}>
        {filtered.map(section => {
          const open = isOpen(section.key)
          const used = active.isUsed ? section.items.filter(i => active.isUsed(i)).length : 0
          return (
            <div key={section.key} style={{ borderTop: '1px solid var(--border)' }}>
              <button
                type="button"
                onClick={() => toggle(section.key)}
                aria-expanded={open}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: '7px',
                  /* Tight padding: with ~14 sections per standard the headings are scanned as a
                     list. */
                  padding: '6px 2px', background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text-primary)', textAlign: 'left', font: 'inherit'
                }}
                title={open ? 'Collapse this section' : 'Expand this section'}
              >
                {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                <span style={{ fontWeight: 600, fontSize: '13px' }}>{section.title}</span>
                <span className="section-count">{section.items.length}</span>
                {used > 0 && (
                  <span style={{ fontSize: '11px', color: 'var(--success-text)' }} title={`${used} already used by a catalog metric`}>
                    {used} in use
                  </span>
                )}
              </button>

              {open && (
                <div style={{ paddingBottom: '9px' }}>
                  {section.hint && (
                    <p style={{ color: 'var(--text-muted)', fontSize: '11px', margin: '0 0 8px 22px' }}>{section.hint}</p>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginLeft: '22px' }}>
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
                          className="mono"
                          style={{
                            fontSize: '11px', padding: '3px 7px', borderRadius: 'var(--radius)',
                            border: `1px solid ${inUse ? 'var(--success)' : 'var(--border)'}`,
                            color: inUse ? 'var(--success)' : 'var(--text-muted)',
                            background: inUse ? 'rgba(34,197,94,0.08)' : 'var(--bg-glass)',
                            cursor: actionable ? 'pointer' : 'default',
                            display: 'inline-flex', alignItems: 'center', gap: '4px'
                          }}
                          title={
                            inUse ? `${tooltip} — already used by a catalog metric`
                              : actionable ? `${tooltip} — click to start a new catalog metric from this`
                                : tooltip
                          }
                        >
                          {inUse && <IconCheck size={10} />}{item.name}
                          {meta && <span style={{ opacity: 0.65 }}>{meta}</span>}
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

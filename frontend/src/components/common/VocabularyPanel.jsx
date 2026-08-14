import React, { useState, useMemo } from 'react'
import { IconChevronDown, IconChevronUp, IconCheck, IconX } from './Icons'

/**
 * One browsable reference card covering every standard vocabulary.
 *
 * Previously three stacked cards, one per standard. They asked the same two questions -- "does the
 * standard define a word for this?" and "have we adopted it yet?" -- and answered them identically,
 * so three cards meant three search boxes, three scroll targets, and a page whose length grew with
 * every standard adopted. One card with a standard selector is a single place to look, and makes
 * the standards read as alternatives to pick between, which is what they are at the moment of
 * naming a metric.
 *
 * What differs per standard arrives as a tab descriptor rather than as three near-identical
 * components: how sections are derived, what an entry's tooltip says, and what counts as "already
 * in use". See common/MTConnectVocabularyPanel.jsx and its siblings.
 *
 * Sections start collapsed -- MTConnect alone is ~600 entries. Searching expands only the sections
 * that match, so a query answers "where does this live?" as well as "does it exist?".
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

  return (
    <>
      {/* ONE CONTROL ROW, the shape every other page uses: what you are looking at on the left,
          what you are looking for on the right. The standard pills used to sit inside the card
          under its header and the search box floated in that header beside the title, so the two
          halves of one decision were separated by a heading -- and the title and its explanation
          had to wrap around a 220px input that had nothing to do with them. */}
      <div className="filter-bar">
        {/* A segmented control rather than a dropdown because the whole point is that all four
            counts are visible at once -- that is what tells you the vocabularies are different
            sizes and different kinds of thing. The search text deliberately survives a switch, so
            "which standard has a word for this?" is one query rather than four. */}
        <div role="tablist" aria-label="Standard" style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
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

        <input
          className="form-control filter-bar-spacer"
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

    <div className="card" style={{ marginBottom: '24px' }}>
      {/* The header is the title and its explanation, full width, with nothing floating in it. */}
      <div className="card-header vocab-header">
        <div>
          <h3 className="section-title">
            {title} <span className="section-count">{query ? `${matches} / ${total}` : total}</span>
          </h3>
          {subtitle && <div className="vocab-subtitle">{subtitle}</div>}
        </div>
      </div>

      {/* Lead sentence, then the caveats as separate labelled lines.
          This was one paragraph of six sentences that ran the width of the card, and the two facts
          in it that stop someone making a mistake -- "reference only, not what your devices
          publish", and how a name is actually composed -- were buried mid-run. */}
      <div className="vocab-description">
        <p>{active.description}</p>
        {(active.notes || []).map((note, i) => (
          <p key={i} className="vocab-note">
            {note.label && <strong className="vocab-note-label">{note.label}</strong>}
            {note.body}
          </p>
        ))}
      </div>

      {query && filtered.length === 0 && (
        <div className="empty-state">
          <div className="empty-text">Nothing in the {active.label} vocabulary matches “{search}”.</div>
        </div>
      )}

      <div style={{ padding: '4px 20px 16px' }}>
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
                  /* 10px -> 6px. With ~14 sections per standard this was ~56px of padding alone
                     between the first heading and the last, on a page whose job is to let someone
                     scan a list of section names. */
                  padding: '6px 2px', background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text)', textAlign: 'left', font: 'inherit'
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

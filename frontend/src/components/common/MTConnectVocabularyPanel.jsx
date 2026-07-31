import React, { useState, useMemo } from 'react'
import { vocabularySections, adoptedVocabulary } from '../../utils/mtconnect'
import { IconChevronDown, IconChevronUp, IconCheck, IconX } from './Icons'

/**
 * Browsable view of the MTConnect controlled vocabularies.
 *
 * The Metric Catalog above it lists what this deployment's devices actually publish -- a handful of
 * entries. That made the standard behind them invisible: 249 data item types were reachable only by
 * scrolling a dropdown inside the Add Metric form, so the page looked like it had no vocabulary at
 * all. This panel is the reference view; it never writes anything.
 *
 * Sections start collapsed because the full vocabulary is ~600 entries and nobody wants it unrolled
 * on arrival. Searching expands only the sections that match, so a query answers "where does this
 * live?" as well as "does it exist?".
 */
export function MTConnectVocabularyPanel({ vocabulary, catalog, onUseType, canAddMetric }) {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState({})

  const sections = useMemo(() => vocabularySections(vocabulary), [vocabulary])
  const adopted = useMemo(() => adoptedVocabulary(catalog), [catalog])

  const query = search.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!query) return sections
    return sections
      .map(s => ({ ...s, names: s.names.filter(n => n.toLowerCase().includes(query)) }))
      .filter(s => s.names.length > 0)
  }, [sections, query])

  const total = sections.reduce((n, s) => n + s.names.length, 0)
  const matches = filtered.reduce((n, s) => n + s.names.length, 0)

  // While searching, a section is open unless explicitly collapsed -- the matches are the point.
  const isOpen = (key) => (query ? expanded[key] !== false : expanded[key] === true)
  const toggle = (key) => setExpanded(prev => ({ ...prev, [key]: !isOpen(key) }))

  return (
    <div className="card" style={{ marginBottom: '24px' }}>
      <div className="card-header">
        <h3 className="section-title">
          MTConnect Vocabulary <span className="section-count">{query ? `${matches} / ${total}` : total}</span>
        </h3>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input
            className="form-control form-control-sm"
            style={{ width: '220px' }}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search the vocabulary…"
            title="Filter every section by name"
          />
          {search && (
            <button className="btn btn-ghost btn-sm" onClick={() => setSearch('')} title="Clear the search">
              <IconX size={13} />
            </button>
          )}
        </div>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '12px 20px 0' }}>
        The controlled vocabularies a metric name is built from, generated from the{' '}
        <span className="mono">mtconnect/schema</span> repository. Reference only — this is the
        standard's list of available words, not a list of metrics your devices publish. A metric is
        a component path plus a data item type, so <span className="mono">ANGLE</span> here becomes{' '}
        <span className="mono">Axes/C/ANGLE</span> in the catalog above. Entries already used by a
        catalog metric are ticked.
      </p>

      {query && filtered.length === 0 && (
        <div className="empty-state"><div className="empty-text">Nothing in the vocabulary matches “{search}”.</div></div>
      )}

      <div style={{ padding: '12px 20px 20px' }}>
        {filtered.map(section => {
          const open = isOpen(section.key)
          const used = section.names.filter(n => adopted.has(n)).length
          return (
            <div key={section.key} style={{ borderTop: '1px solid var(--border)' }}>
              <button
                type="button"
                onClick={() => toggle(section.key)}
                aria-expanded={open}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '10px 2px', background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text)', textAlign: 'left', font: 'inherit'
                }}
                title={open ? 'Collapse this section' : 'Expand this section'}
              >
                {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                <span style={{ fontWeight: 600, fontSize: '13px' }}>{section.title}</span>
                <span className="section-count">{section.names.length}</span>
                {used > 0 && (
                  <span style={{ fontSize: '11px', color: 'var(--success-text)' }} title={`${used} already used by a catalog metric`}>
                    {used} in use
                  </span>
                )}
              </button>

              {open && (
                <div style={{ paddingBottom: '12px' }}>
                  {section.hint && (
                    <p style={{ color: 'var(--text-muted)', fontSize: '11px', margin: '0 0 8px 22px' }}>{section.hint}</p>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginLeft: '22px' }}>
                    {section.names.map(name => {
                      const inUse = adopted.has(name)
                      // Only data item types are actionable: a component or a unit is not a metric
                      // on its own, so prefilling the form with one would produce nothing useful.
                      const actionable = !!onUseType && canAddMetric && section.key.startsWith('type:')
                      return (
                        <span
                          key={name}
                          role={actionable ? 'button' : undefined}
                          tabIndex={actionable ? 0 : undefined}
                          onClick={actionable ? () => onUseType(name) : undefined}
                          onKeyDown={actionable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onUseType(name) } } : undefined}
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
                            inUse ? `${name} — already used by a catalog metric`
                              : actionable ? `${name} — click to start a new catalog metric from this type`
                                : name
                          }
                        >
                          {inUse && <IconCheck size={10} />}{name}
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

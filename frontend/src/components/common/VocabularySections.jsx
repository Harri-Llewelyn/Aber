import React from 'react'
import { IconChevronDown, IconChevronUp, IconCheck, IconPlus } from './Icons'
import { HelpTip } from './HelpTip'
import { Tooltip } from './Tooltip'

/**
 * A vocabulary's sections as the Vocabulary page draws them: a heading that opens and closes (with its
 * "N in use" count) and, when open, one chip for each entry. `tab` is the tab descriptor
 * VocabularyPanel documents, whose `isUsed`, `isActionable`, `onUse`, `metaFor`, `tooltipFor`,
 * `idFor` and `noteFor` decide what a chip says and does; `isOpen(key)` and `toggle(key)` are the caller's state.
 * VocabularyPanel draws the standards' tabs with it, and a tab with a panel of its own (Imported) draws
 * its concepts with it, so a chip looks and acts the same on every tab.
 */
export function VocabularySections({ sections, tab: active, canAddMetric, isOpen, toggle }) {
  return (
    <>
      {sections.map(section => {
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
              >
                {open ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
                <span className="table-group-label">{section.title}</span>
              </button>
              {section.hint && <HelpTip label={`About ${section.title}`} text={section.hint} />}
              {used > 0 && (
                <Tooltip text={`${used} already used by a catalog metric`}>
                  <span className="vocab-in-use">{used} in use</span>
                </Tooltip>
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
                    // The id on a line of its own, in mono as CopyableId shows one; the hint last.
                    const id = active.idFor?.(item)
                    const note = active.noteFor?.(item)
                    const hint = inUse ? 'Already used by a catalog metric.'
                      : actionable ? 'Press it to start a new catalog metric from this.' : null
                    return (
                      <Tooltip
                        key={item.id || item.name}
                        text={<>
                          {tooltip}
                          {id && <span className="tooltip-line">{id.label} <span className="copyable-id-full">{id.value}</span></span>}
                          {note && <span className="tooltip-line">{note}</span>}
                          {hint && <span className="tooltip-line">{hint}</span>}
                        </>}
                      >
                        <span
                          role={actionable ? 'button' : undefined}
                          tabIndex={actionable ? 0 : undefined}
                          onClick={actionable ? () => active.onUse(item) : undefined}
                          onKeyDown={actionable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); active.onUse(item) } } : undefined}
                          aria-label={actionable
                            ? `Start a catalog metric from ${item.name}${inUse ? ', already used by one' : ''}`
                            : undefined}
                          className={`mono vocab-chip${inUse ? ' vocab-chip-used' : ''}${actionable ? ' vocab-chip-action' : ''}`}
                        >
                          {inUse && <IconCheck size={10} />}{item.name}
                          {meta && <span className="vocab-chip-meta">{meta}</span>}
                          {/* Shown on hover and keyboard focus only (App.css); its space is kept at
                              rest so a chip does not grow and re-wrap the row under the pointer. */}
                          {actionable && <IconPlus size={10} className="vocab-chip-plus" />}
                        </span>
                      </Tooltip>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

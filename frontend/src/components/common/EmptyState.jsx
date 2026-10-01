import React from 'react'

/**
 * What a list says when it has no rows: one sentence with a full stop. `message` is for a list
 * with no filter set, `filteredMessage` for one that a filter emptied, chosen by `filtered`.
 * `icon` is an element (an Icon component); `children` sit under the sentence, for a button that
 * offers a way out.
 *
 * @example
 * <EmptyState icon={<IconFactory size={40} />} filtered={filterCount > 0}
 *   message="No cells yet." filteredMessage="No cells match these filters." />
 */
export function EmptyState({ icon, message, filteredMessage, filtered = false, children }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-text">{filtered && filteredMessage ? filteredMessage : message}</div>
      {children}
    </div>
  )
}

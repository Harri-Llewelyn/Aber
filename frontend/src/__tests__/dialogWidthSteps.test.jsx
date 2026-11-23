import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Modal } from '../components/common/Modal'
import { ConfirmModal } from '../components/modals/ConfirmModal'
import { ArchiveModal } from '../components/modals/ArchiveModal'
import { RestoreEntityModal } from '../components/modals/RestoreEntityModal'
import { RestoreMetricModal } from '../components/modals/RestoreMetricModal'
import { ShortcutsModal } from '../components/modals/ShortcutsModal'

// The box inside the <dialog>, which carries the step's class.
const box = () => screen.getByRole('dialog').firstElementChild

describe('the width steps a caller names', () => {
  it('takes "default" as the bare .modal, as leaving size out does', () => {
    render(<Modal title="T" size="default" onClose={vi.fn()} />)
    expect(box().className).toBe('modal')
  })

  it('puts a dialog\'s own layout class beside its step', () => {
    render(<Modal title="T" size="lg" className="schema-detail-modal" onClose={vi.fn()} />)
    expect(box().className).toBe('modal modal-lg schema-detail-modal')
  })

  it('opens a confirm at sm unless it asks for another step', () => {
    const { unmount } = render(<ConfirmModal title="Q" message="Sure?" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(box().className).toBe('modal modal-sm')
    unmount()

    render(<ConfirmModal title="Q" size="default" message="Sure?" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(box().className).toBe('modal')
  })
})

describe('taking out and bringing back', () => {
  // The scale's rule decides, not the pairing: Archive holds a field, the two Restores hold none.
  it('opens Archive, a form with one select, at the default step', () => {
    render(<ArchiveModal entityId="cell-1" displayName="Assembly Line 1" onArchive={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Auto-purge' })).toBeTruthy()
    expect(box().className).toBe('modal')
  })

  it('opens both Restore confirms, which hold no field, at sm', () => {
    const { unmount } = render(<RestoreEntityModal type="cell" name="Line 1" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(box()).toHaveClass('modal-sm')
    unmount()

    render(
      <RestoreMetricModal
        metric={{ name: 'spindle_temp', superseded_by: null }}
        replacement={null} onConfirm={vi.fn()} onCancel={vi.fn()}
      />
    )
    expect(box()).toHaveClass('modal-sm')
    expect(screen.getByRole('dialog').querySelector('input, select, textarea')).toBeNull()
  })
})

describe('Keyboard shortcuts', () => {
  it('opens at the wide step with every group in the one grid that sets them two to a row', () => {
    render(<ShortcutsModal onClose={vi.fn()} />)
    expect(box()).toHaveClass('modal-wide')
    const grid = box().querySelector('.shortcut-groups')
    expect(grid).toBeTruthy()
    const groups = box().querySelectorAll('.shortcut-group')
    expect(groups.length).toBeGreaterThan(1)
    expect([...groups].every(g => g.parentElement === grid)).toBe(true)
  })
})

import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Modal } from '../components/common/Modal'
import { IconArchive, IconPencil } from '../components/common/Icons'
import { ConfirmModal } from '../components/modals/ConfirmModal'
import { ArchiveModal } from '../components/modals/ArchiveModal'
import { RestoreEntityModal } from '../components/modals/RestoreEntityModal'
import { ApproveQuarantineModal } from '../components/modals/ApproveQuarantineModal'
import { declaration } from '../test/themeColours'

/**
 * A dialog's header: the act's icon, the act, then the record after a dash, in mono. frontend/README.md,
 * "A dialog's header names its act". Drift check 612 reads every dialog's from source.
 */

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

const heading = () => screen.getByRole('heading', { level: 2 })

describe("a dialog's header", () => {
  it('draws the record after the act and a dash, in mono, and is named by both', () => {
    render(<Modal title="Edit Area" subject="Assembly" icon={<IconPencil size={18} />} onClose={vi.fn()} />)
    expect(heading()).toHaveTextContent('Edit Area — Assembly')
    const subject = heading().querySelector('.modal-subject')
    expect(subject).toHaveClass('mono')
    expect(subject).toHaveTextContent(/^Assembly$/)
    expect(screen.getByRole('dialog', { name: 'Edit Area — Assembly' })).toBeInTheDocument()
    expect(heading().firstChild.tagName.toLowerCase()).toBe('svg')
  })

  it('draws no dash without a record', () => {
    render(<Modal title="New Area" icon={<IconPencil size={18} />} onClose={vi.fn()} />)
    expect(heading()).toHaveTextContent(/^New Area$/)
    expect(heading().querySelector('.modal-subject')).toBeNull()
  })

  it('is the lead that describes the dialog', () => {
    render(<Modal title="Edit Area" subject="Assembly" icon={<IconPencil size={18} />} lead="Saves the changes to this area." onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('Saves the changes to this area.')
  })

  it("passes a confirm's record to the frame", () => {
    render(<ConfirmModal title="Remove Link" subject="Drawings" icon={<IconArchive size={18} />} message="Remove it?" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(heading()).toHaveTextContent('Remove Link — Drawings')
  })

  it('wraps a long record in the title, and never cuts it', () => {
    expect(declaration(APP_CSS, '.modal-header-row .modal-title', 'overflow-wrap')).toBe('anywhere')
    for (const prop of ['white-space', 'text-overflow', 'overflow']) {
      expect(declaration(APP_CSS, '.modal-title .modal-subject', prop)).toBeNull()
    }
  })

  // jsdom lays nothing out, so the rules a wrapped title rests on are read from App.css.
  describe('when the title wraps', () => {
    const px = (selector, prop) => Number(declaration(APP_CSS, selector, prop)?.match(/^(\d+)px$/)?.[1])
    const TITLE = '.modal-header-row .modal-title'
    const ICON = '.modal-header-row .modal-title > svg'

    it('keeps the icon at its 18px, beside the first line and centred on it', () => {
      render(<Modal title="Archive Device" subject="CNC Mill 01" icon={<IconArchive size={18} />} onClose={vi.fn()} />)
      const icon = heading().firstElementChild
      expect(icon.matches(ICON)).toBe(true)
      expect(icon.getAttribute('width')).toBe('18')
      expect(declaration(APP_CSS, ICON, 'flex-shrink')).toBe('0')
      // Beside the first line, not the middle of the block: the title's items start at its top.
      expect(declaration(APP_CSS, TITLE, 'align-items')).toBe('flex-start')
      expect(px(ICON, 'margin-top')).toBe((px(TITLE, 'line-height') - 18) / 2)
    })

    it('keeps the close button top right, level with the first line', () => {
      render(<Modal title="Archive Device" subject="CNC Mill 01" icon={<IconArchive size={18} />} onClose={vi.fn()} />)
      const row = document.querySelector('.modal-header-row')
      expect(row.lastElementChild).toHaveClass('modal-header-controls')
      expect(within(row.lastElementChild).getByRole('button', { name: 'Close' })).toHaveClass('btn-icon')
      expect(declaration(APP_CSS, '.modal-header-row', 'align-items')).toBe('flex-start')
      expect(declaration(APP_CSS, '.modal-header-controls', 'flex')).toBe('none')
      // Each line of the title is as tall as the button, so the first sits level with it.
      expect(px(TITLE, 'line-height')).toBe(px('.btn-icon', 'height'))
      expect(px(TITLE, 'min-height')).toBe(px('.btn-icon', 'height'))
    })
  })
})

describe('Archive, Restore and Approve & Onboard name what they act on', () => {
  it('Archive names the type and the record', () => {
    render(<ArchiveModal type="device" entityId="d-1" displayName="CNC Mill 01" onArchive={vi.fn()} onCancel={vi.fn()} />)
    expect(heading()).toHaveTextContent('Archive Device — CNC Mill 01')
    expect(within(heading()).getByText('CNC Mill 01')).toHaveClass('modal-subject')
  })

  it.each([
    ['a device nobody registered', {}, /^Admits a device nobody has registered/],
    ['a registered device held again', { requarantined_at: '2026-11-20T10:00:00Z' }, /^Admits again a registered device/],
  ])('Approve & Onboard names the device, and its lead says it is %s', (_, held, lead) => {
    render(
      <ApproveQuarantineModal
        item={{ asset_id: 'd-1', asset_name: 'CNC 9', reported_identity: 'cnc-9', entity_type: 'DEVICE', gateway_id: null, ...held }}
        cells={[]} gateways={[]} suggestion={null} onApprove={vi.fn()} onMerge={vi.fn()} onCancel={vi.fn()}
      />
    )
    expect(heading()).toHaveTextContent('Approve & Onboard — CNC 9')
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(lead)
  })

  it('Restore names them the same way', () => {
    render(<RestoreEntityModal type="device" name="CNC Mill 01" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(heading()).toHaveTextContent('Restore Device — CNC Mill 01')
  })
})

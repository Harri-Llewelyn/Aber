import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ArchiveModal } from '../components/modals/ArchiveModal'

/**
 * The Archive dialog's button names the act its title names, as Restore's does, and only a gateway's
 * dialog says what archiving a gateway also does.
 */

const open = (type) =>
  render(<ArchiveModal type={type} entityId="e-1" displayName="Press Hall" onArchive={vi.fn()} onCancel={vi.fn()} />)

const GATEWAY_LINE = /revokes its broker credential and archives its forge repository/

describe('the Archive dialog', () => {
  it.each([
    ['area', 'Archive Area'],
    ['cell', 'Archive Cell'],
    ['gateway', 'Archive Gateway'],
    ['device', 'Archive Device'],
  ])('names the act alike in the title and the button, for a %s', (type, act) => {
    open(type)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(`${act} — Press Hall`)
    expect(screen.getByRole('button', { name: act })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
  })

  it('says a gateway loses its broker credential and its repository is archived', () => {
    open('gateway')
    expect(screen.getByRole('dialog')).toHaveTextContent(GATEWAY_LINE)
    expect(screen.getByRole('dialog')).toHaveTextContent(/brings it back\. It also revokes .* repository\. Raw readings are not held back/)
  })

  it.each(['area', 'cell', 'device'])('says nothing of a gateway in a %s\'s dialog', (type) => {
    open(type)
    expect(screen.getByRole('dialog')).not.toHaveTextContent(GATEWAY_LINE)
    expect(screen.getByRole('dialog')).toHaveTextContent(/brings it back\. Raw readings are not held back/)
  })
})

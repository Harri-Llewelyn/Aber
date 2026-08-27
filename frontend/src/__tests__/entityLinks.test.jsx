import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EntityLinksModal } from '../components/modals/EntityLinksModal'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'

/**
 * Links, formerly Document Links (issue #62).
 *
 * WHAT CHANGED IS THE VOCABULARY, NOT THE MODEL. `public.links` is
 * `(entity_type, entity_id, display_name, url, link_tag)` -- an arbitrary labelled URL against
 * an arbitrary entity. Nothing about it was ever document-specific, so the name was the only thing
 * stopping anyone attaching an asset-register entry or a file share. The issue asked for a new
 * asset-register FIELD on gateways and devices; a tag on this feature does the same job without a
 * migration, without a form field on two more pages, and without a second place asset URLs live.
 *
 * THE STORED TAG VALUES ARE UNCHANGED AND THESE TESTS PIN THAT. `link_tag` carries no CHECK
 * constraint, so the frontend's TAG_LABELS is the only enumeration of the vocabulary -- which makes
 * adding a tag free and makes renaming a key silent data loss: every row written before the rename
 * keeps the old string and renders as Other. Labels are display; keys are data.
 *
 * The endpoint and column are now `links` / `link_tag`, matching what the UI has always called
 * them -- roadmap item 6, migration 0049. The tag VALUES did not move with them, which is the
 * distinction the paragraph above turns on.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }
})

const link = (overrides = {}) => ({
  id: 'link-1',
  entity_type: 'device',
  entity_id: 'dev-1',
  display_name: 'Operating Manual',
  url: 'https://company.sharepoint.com/documents/manual.pdf',
  link_tag: 'other',
  ...overrides
})

const show = async (rows = [link()], canManage = true) => {
  api.get.mockResolvedValue(rows)
  render(
    <EntityLinksModal
      entityType="device" entityId="dev-1" entityName="Sim_CNC_Mill_01"
      onClose={vi.fn()} showToast={vi.fn()}
      hasPermission={(p) => canManage && p === PERMISSION_UUIDS.LINK_MANAGE}
    />
  )
  await waitFor(() => expect(document.querySelector('.modal')).toBeTruthy())
}

const modal = () => within(document.querySelector('.modal'))
const openForm = () => fireEvent.click(screen.getByRole('button', { name: /Add Link/i }))
const tagSelect = () => document.querySelector('select.form-control')

beforeEach(() => { vi.clearAllMocks() })

// ---------------------------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------------------------

describe('the link vocabulary', () => {
  it('calls them Links, not Document Links', async () => {
    await show()

    // The name was the thing blocking the feature's general use: someone with an EZOfficeInventory
    // URL could always have pasted it here, and would never have thought to look.
    expect(modal().getByText(/^Links —/)).toBeTruthy()
    expect(modal().getByText(/Attached Links \(1\)/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Document Links/)
  })

  it('offers Asset Register and File Repository alongside the original tags', async () => {
    await show()
    openForm()

    const options = [...tagSelect().options].map(o => o.textContent)
    expect(options).toEqual([
      'Image', 'Health & Safety', 'Procurement', 'Schematic',
      'Asset Register', 'File Repository', 'Other'
    ])
  })

  it('labels the field Tag, matching the column it writes', async () => {
    await show()
    openForm()

    expect(modal().getByText('Tag')).toBeTruthy()
    expect(modal().queryByText(/Classification/i)).toBeNull()
  })

  /*
   * FILE REPOSITORY IS A DIFFERENT KIND OF ENTRY and its hint has to say so. Every other tag points
   * at something that exists; this one points at where files BELONG. The platform deliberately
   * stores no measurement data, so naming its home is the most it can usefully do -- and a hint
   * implying the link opens a file would misdescribe the one tag that most needs explaining.
   */
  it('explains the selected tag, and says File Repository is a destination', async () => {
    await show()
    openForm()

    fireEvent.change(tagSelect(), { target: { value: 'file_repository' } })
    const hint = modal().getByText(/where files for this asset are saved/i)
    expect(hint).toBeTruthy()
    expect(hint.textContent).toMatch(/stores no such files/i)
  })

  it('names an external tracker on the Asset Register hint', async () => {
    await show()
    openForm()

    fireEvent.change(tagSelect(), { target: { value: 'asset_register' } })
    expect(modal().getByText(/EZOfficeInventory/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
// Stored values
// ---------------------------------------------------------------------------------------------

describe('stored tag values', () => {
  it('still renders a tag written before the rename', async () => {
    // The keys are data. If `health_and_safety` had been renamed with its label, every existing
    // row would quietly fall through to Other -- and nothing would report it.
    await show([link({ link_tag: 'health_and_safety' })])

    expect(modal().getByText('Health & Safety')).toBeTruthy()
  })

  it('writes the new tags under the keys the column expects', async () => {
    await show([])
    openForm()

    fireEvent.change(modal().getByPlaceholderText(/Operating Manual/), { target: { value: 'EZOffice entry' } })
    fireEvent.change(modal().getByPlaceholderText(/sharepoint/i), { target: { value: 'https://example.com/asset/1' } })
    fireEvent.change(tagSelect(), { target: { value: 'asset_register' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Link/i }))

    await waitFor(() => expect(api.post).toHaveBeenCalled())
    // Wire and UI now agree -- roadmap item 6 closed the divergence this used to pin.
    expect(api.post).toHaveBeenCalledWith('/api/v1/links', expect.objectContaining({
      link_tag: 'asset_register',
      entity_type: 'device',
      entity_id: 'dev-1'
    }))
  })

  it('falls back to Other for a tag it does not know', async () => {
    // The column has no CHECK constraint, so a row can carry anything. An unknown tag must render
    // as something rather than as a blank badge.
    await show([link({ link_tag: 'invented_by_someone' })])

    expect(modal().getByText('Other')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
// The empty and permission states
// ---------------------------------------------------------------------------------------------

describe('the states around the list', () => {
  it('says no links rather than no documents when empty', async () => {
    await show([])

    expect(modal().getByText(/No links attached to this device/i)).toBeTruthy()
  })

  it('hides the add control without the manage permission', async () => {
    await show([link()], false)

    expect(screen.getByRole('button', { name: /Add Link/i })).toBeDisabled()
  })
})

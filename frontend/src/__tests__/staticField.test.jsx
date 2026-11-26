import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StaticEmpty, StaticField, StaticFields } from '../components/common/StaticField'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'

/**
 * A value nobody can change is a StaticField: the name over the value, Not set when it is empty, the
 * reason in words under it, and a copy for an identifier. frontend/README.md, "A value nobody can
 * change is a label".
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

let written
beforeEach(() => {
  written = []
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async (t) => { written.push(t) }) } })
})
afterEach(() => { vi.unstubAllGlobals() })

/** The field whose name is this. */
const field = (name) => screen.getByText(name, { selector: 'dt' }).closest('dl')

describe('StaticField', () => {
  it('is a description list: the name, then the value, then why, so they are read together', () => {
    render(<StaticField label="Site Key" value="broughton" reason="Fixed at install." />)
    const list = field('Site Key')
    expect([...list.children].map(el => [el.tagName, el.textContent])).toEqual([
      ['DT', 'Site Key'], ['DD', 'broughton'], ['DD', 'Fixed at install.'],
    ])
    expect(list.querySelector('dd').className).toBe('form-static')
    expect(list.querySelector('dd.form-hint')).toHaveTextContent('Fixed at install.')
    // Text, not a control that is switched off.
    expect(list.querySelector('input, select, textarea, [disabled]')).toBeNull()
  })

  it('says Not set for an empty value, in the drawers’ words and look', () => {
    for (const value of [null, undefined, '', false]) {
      const { unmount } = render(<StaticField label="Description" value={value} />)
      const empty = field('Description').querySelector('.form-static > .context-field-empty')
      expect(empty).toHaveTextContent(/^Not set$/)
      unmount()
    }
    // A value that is a word is shown as it is.
    render(<StaticField label="Units" value="None" />)
    expect(field('Units').querySelector('.form-static')).toHaveTextContent(/^None$/)
    expect(field('Units').querySelector('.context-field-empty')).toBeNull()
  })

  it('draws an identifier in mono, and copies it by a click', async () => {
    const onCopy = vi.fn()
    render(<StaticField label="Sparkplug Group" value="Aber" mono copyable onCopy={onCopy} />)
    const value = field('Sparkplug Group').querySelector('.form-static')
    expect(value).toHaveClass('mono')
    fireEvent.click(within(value).getByRole('button', { name: 'Copy sparkplug group Aber' }))
    await waitFor(() => expect(written).toEqual(['Aber']))
    expect(onCopy).toHaveBeenCalledWith('Copied sparkplug group to clipboard', 'success')
  })

  it('names what it copies by `copyLabel` where the label does not', async () => {
    render(<StaticField label="Name" value="Axes/X/POSITION" mono copyable copyLabel="metric name" />)
    expect(screen.getByRole('button', { name: 'Copy metric name Axes/X/POSITION' })).toBeInTheDocument()
  })

  it('puts its help beside the name, and its more under the reason', () => {
    render(
      <StaticField label="Reference Type" value="IRI" help="How to read the id" reason="Fixed by the version.">
        <p className="form-hint">One more thing.</p>
      </StaticField>
    )
    const list = field('Reference Type')
    expect(within(list.querySelector('dt')).getByRole('button', { name: 'What Reference Type means' })).toBeInTheDocument()
    expect([...list.querySelectorAll('dd')].map(dd => dd.textContent)).toEqual(['IRI', 'Fixed by the version.', 'One more thing.'])
  })

  it('stands beside another in StaticFields, and a list with nothing says so in StaticEmpty', () => {
    render(
      <>
        <StaticFields>
          <StaticField label="Units" value="None" />
          <StaticField label="Sparkplug Datatype" value="Double" />
        </StaticFields>
        <StaticEmpty>This schema models no metrics.</StaticEmpty>
      </>
    )
    const row = document.querySelector('.static-fields')
    expect([...row.querySelectorAll('dt')].map(dt => dt.textContent)).toEqual(['Units', 'Sparkplug Datatype'])
    expect(screen.getByText('This schema models no metrics.')).toHaveClass('form-static', 'context-field-empty')
  })
})

describe('Edit Device Configuration, for someone who may edit devices', () => {
  const DEVICE = {
    asset_id: 'aaaaaaaa-0000-4000-8000-000000000001', asset_name: 'CNC_01', sparkplug_id: 'devaaaaaaaa000040008000',
    status: 'ONLINE', is_quarantined: false, is_archived: false, active_gateway_id: 'gw-1', cell_id: 'cell-1',
    location_scope: 'cell', conformance_policy: 'audit', submodel_schema_ids: [], created_at: '2026-07-20T12:00:00Z',
  }
  const route = (path) => {
    if (path.startsWith('/api/v1/gateways')) {
      return Promise.resolve([{ gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1', location_scope: 'cell', status: 'ONLINE', is_archived: false, devices: [] }])
    }
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Cell 1', is_archived: false }])
    if (path.startsWith('/api/v1/devices')) return Promise.resolve([DEVICE])
    return Promise.resolve([])
  }

  it('keeps every field a control: nothing an editor could change is a static field', async () => {
    api.get.mockImplementation(route)
    render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} />)
    await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
    fireEvent.click(within(document.querySelector('.page-main')).getByText('CNC_01'))
    fireEvent.click(within(document.querySelector('.context-panel')).getByText('Edit Details'))
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByLabelText('Serving Gateway')).toBeEnabled()
    expect(within(dialog).getByRole('group', { name: /^Schemas \(optional\)/ })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Schema Conformance')).toBeEnabled()
    expect(within(dialog).getByRole('radiogroup', { name: 'Location' })).toBeInTheDocument()
    expect(dialog.querySelectorAll('.static-field')).toHaveLength(0)
  })
})

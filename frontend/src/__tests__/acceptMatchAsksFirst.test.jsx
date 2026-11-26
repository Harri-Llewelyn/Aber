import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApproveQuarantineModal } from '../components/modals/ApproveQuarantineModal'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'
import { deviceUrl } from '../routes'
import { supabase } from '../lib/supabaseClient'
import { tabLink } from '../test/tabBar'

/**
 * Accept Match merges a quarantined device into a provisioned one and deletes the quarantined row. It
 * asks first, naming both devices: which is kept, which is deleted, and what carries over. The words
 * are held against the database's merge by drift check 573.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const QUARANTINED = 'cccccccc-0000-4000-8000-000000001602'
const PROVISIONED = 'aaaaaaaa-0000-4000-8000-000000001602'

const item = (over = {}) => ({
  asset_id: QUARANTINED, asset_name: 'CNC 9', reported_identity: 'cnc-9-old', entity_type: 'DEVICE', gateway_id: 'gw-1', ...over
})
const match = (over = {}) => ({ candidateId: PROVISIONED, candidateName: 'CNC_09', evidence: '80% name match', ...over })

const element = (props) => (
  <ApproveQuarantineModal
    item={item()} cells={[]} gateways={[]} suggestion={match()}
    onApprove={vi.fn()} onMerge={vi.fn()} onCancel={vi.fn()} {...props}
  />
)
const show = (props = {}) => render(element(props))
const approval = () => screen.getByRole('dialog', { name: /Approve Discovered Device/ })
const question = () => screen.queryByRole('dialog', { name: /^Accept Match — / })
const press = () => fireEvent.click(within(approval()).getAllByRole('button', { name: 'Accept Match' })[0])

beforeEach(() => vi.clearAllMocks())

describe('Accept Match', () => {
  it('merges nothing when it is pressed, and asks, naming the device kept and the one deleted', () => {
    const onMerge = vi.fn()
    show({ onMerge })
    press()

    expect(onMerge).not.toHaveBeenCalled()
    expect(question()).toHaveAccessibleDescription(
      "Merge the quarantined device 'CNC 9' (published as cnc-9-old) into 'CNC_09'? 'CNC_09' is kept, and the quarantined device is deleted.")
    expect(within(question()).getByRole('button', { name: 'Accept Match' })).toHaveClass('btn-danger')
    // A plain question: the device merged into is one the person can see.
    expect(within(question()).queryByRole('textbox')).toBeNull()
  })

  it('says what carries over and what does not', () => {
    show()
    press()
    const text = question().textContent.replace(/\s+/g, ' ')
    expect(text).toContain(
      "Carried over: the ID it publishes under, its status, the time of its first birth, and the values its birth announced. Its messages then arrive as 'CNC_09'.")
    expect(text).toContain(
      'Not carried over: its name, gateway, location and schemas, and anything else set on it, such as a nameplate, links or captures. '
      + 'These are deleted with it. Readings already recorded for it do not move.')
    expect(text).toContain("'CNC_09' keeps its own gateway. If the device publishes through another, it is held in Quarantine again.")
  })

  it('names only the device when it published no ID', () => {
    show({ item: item({ reported_identity: null }) })
    press()
    expect(question()).toHaveAccessibleDescription(/^Merge the quarantined device 'CNC 9' into 'CNC_09'\?/)
  })

  it('merges nothing on Cancel, and leaves the approval open', () => {
    const onMerge = vi.fn()
    const onCancel = vi.fn()
    show({ onMerge, onCancel })
    press()
    fireEvent.click(within(question()).getByRole('button', { name: 'Cancel' }))

    expect(question()).toBeNull()
    expect(approval()).toBeInTheDocument()
    expect(onMerge).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('closes the question on Escape, and not the approval under it', () => {
    const onCancel = vi.fn()
    show({ onCancel })
    press()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(question()).toBeNull()
    expect(approval()).toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('merges once it is confirmed, and says it is running', async () => {
    let finish
    const onMerge = vi.fn(() => new Promise((resolve) => { finish = resolve }))
    show({ onMerge })
    press()
    fireEvent.click(within(question()).getByRole('button', { name: 'Accept Match' }))

    expect(onMerge).toHaveBeenCalledTimes(1)
    expect(onMerge).toHaveBeenCalledWith(QUARANTINED, PROVISIONED)
    const running = within(question()).getByRole('button', { name: /Merging/ })
    expect(running).toBeDisabled()
    await act(async () => { finish() })
  })

  it('shows a refusal as it was worded, in the question, which stays open', async () => {
    const onMerge = vi.fn().mockRejectedValue(new Error('Forbidden: Insufficient privileges'))
    show({ onMerge })
    press()
    fireEvent.click(within(question()).getByRole('button', { name: 'Accept Match' }))
    expect(await within(question()).findByRole('alert')).toHaveTextContent('Forbidden: Insufficient privileges')
    expect(question()).not.toBeNull()
  })

  it('drops the question when another device is suggested instead, or none is', () => {
    const { rerender } = show()
    press()
    expect(question()).not.toBeNull()
    rerender(element({ suggestion: match({ candidateId: 'other', candidateName: 'CNC_10' }) }))
    expect(question()).toBeNull()
    rerender(element({ suggestion: null }))
    expect(question()).toBeNull()
  })

  it('says in its hint that the match is kept and the quarantined device deleted, and that it asks first', () => {
    show()
    const hint = approval().querySelector('.callout .form-hint')
    expect(hint.textContent.replace(/\s+/g, ' ')).toBe(
      'A provisioned device awaiting its first birth (80% name match). If this is the same machine publishing under another ID, '
      + "accepting the match keeps that device's existing configuration and deletes this quarantined duplicate, "
      + 'rather than approving it as a brand new device. It asks first.')
  })

  it('is not offered for a gateway, which has no match to merge into', () => {
    render(
      <ApproveQuarantineModal
        item={item({ entity_type: 'GATEWAY', asset_name: 'Edge 9' })} cells={[]} gateways={[]} suggestion={match()}
        onApprove={vi.fn()} onMerge={vi.fn()} onCancel={vi.fn()} />
    )
    expect(screen.queryByRole('button', { name: 'Accept Match' })).toBeNull()
  })
})

describe('approving as a new device, beside it', () => {
  it('still shows a refusal in the approval dialog', async () => {
    const onApprove = vi.fn().mockRejectedValue(new Error('Invalid approval request'))
    show({ onApprove })
    fireEvent.click(within(approval()).getByRole('button', { name: /Approve & Onboard/ }))
    expect(await within(approval()).findByRole('alert')).toHaveTextContent('Invalid approval request')
  })

  it('holds Accept Match while an approval runs', async () => {
    let finish
    show({ onApprove: vi.fn(() => new Promise((resolve) => { finish = resolve })) })
    fireEvent.click(within(approval()).getByRole('button', { name: /Approve & Onboard/ }))
    expect(within(approval()).getByRole('button', { name: 'Accept Match' })).toBeDisabled()
    await act(async () => { finish() })
    expect(within(approval()).getByRole('button', { name: 'Accept Match' })).toBeEnabled()
  })
})

describe('the Quarantine tab', () => {
  it('sends the merge only once the question is confirmed, and says so', async () => {
    supabase.functions.invoke.mockResolvedValue({ data: { success: true }, error: null })
    const quarantined = { ...item(), quarantine_id: QUARANTINED, gateway_name: 'Line_A_Gateway', reported_metrics: [], birth_payload: '[]', is_quarantined: true }
    const provisioned = {
      asset_id: PROVISIONED, asset_name: 'CNC_09', sparkplug_id: 'devaaaaaaaa000040008000', status: 'OFFLINE',
      is_quarantined: false, is_archived: false, active_gateway_id: 'gw-1', cell_id: null, location_scope: 'gateway',
      first_dbirth_at: null, created_at: '2026-11-20T12:00:00Z'
    }
    api.get.mockImplementation((path) => Promise.resolve(
      path.startsWith('/api/v1/quarantine') ? [quarantined] : path.startsWith('/api/v1/devices') ? [provisioned] : []))
    const showToast = vi.fn()
    render(<DevicesTab showToast={showToast} onSelectDevice={vi.fn()} hasPermission={() => true} />)
    fireEvent.click(tabLink('Quarantine'))
    fireEvent.click(await screen.findByRole('button', { name: /Approve & Onboard/ }))
    press()
    expect(supabase.functions.invoke).not.toHaveBeenCalled()

    fireEvent.click(within(question()).getByRole('button', { name: 'Accept Match' }))
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalledWith('approve-quarantine', {
      body: { device_id: QUARANTINED, merge_into_device_id: PROVISIONED }
    }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith(
      "Device 'CNC 9' matched and merged into the provisioned device", 'success', { to: deviceUrl(PROVISIONED) })
  })
})

import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationsTab } from '../components/tabs/AutomationsTab'
import { AUTOMATION_WRITE_TITLE } from '../utils/automations'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

/**
 * The Automations list: each automation's alias, what its triggers watch in words, whether it is
 * enabled, whether it is firing now and when it last fired. Search narrows it, `?entity=` narrows it
 * to the automations that apply to one device, a row's switch enables or disables it, ticking rows
 * picks what Export writes, and for a role that may not write the page offers no control that would
 * be refused.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      readAutomations: vi.fn(),
      automationsDocument: vi.fn(),
      automationsForEntity: vi.fn(),
      resolveId: vi.fn(),
      setAutomationEnabled: vi.fn(),
      applyAutomations: vi.fn(),
      automationOfTrigger: vi.fn(),
      // What the editor page reads when an alert's link opens an automation.
      automationRow: vi.fn(),
      readAutomationAlerts: vi.fn(),
      deleteAutomation: vi.fn(),
      get: vi.fn(),
    },
  }
})

const download = vi.hoisted(() => ({ blobs: [] }))
vi.mock('../utils/downloadBlob', () => ({ downloadBlob: (blob, name) => download.blobs.push({ blob, name }) }))

const LATHE = '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13'
const MILL = '8f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b14'
const TRIGGER_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TRIGGER_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const NOW = new Date('2026-11-09T12:00:00Z').getTime()

const hot = {
  id: 'lathe-3-spindle-hot', alias: 'Lathe 3 spindle bearing hot', description: 'Check the coolant.', enabled: true,
  triggers: [{ trigger: 'threshold', device: LATHE, metric: 'Spindle/BEARING_TEMPERATURE', above: 80, for: '5m' }],
  actions: [{ action: 'alert', severity: 'warning' }],
}
const slow = {
  id: 'press-slow', alias: 'Press cycle slow', description: '', enabled: false,
  triggers: [{ trigger: 'threshold', device: [LATHE, MILL], metric: 'Press/CYCLE_TIME', above: 12 }],
  actions: [{ action: 'alert', severity: 'critical' }],
}

const read = (over = {}) => ({
  automations: [hot, slow],
  devices: { [LATHE]: { name: 'Lathe 3', place: 'Cell 2 · Machining' }, [MILL]: { name: 'Mill 1', place: null } },
  rows: [
    { id: 'row-hot', key: hot.id, updated_at: '2026-11-08T09:00:00Z', automation_triggers: [{ id: TRIGGER_A, is_archived: false }] },
    { id: 'row-slow', key: slow.id, updated_at: '2026-11-08T09:00:00Z', automation_triggers: [{ id: TRIGGER_B, is_archived: false }] },
  ],
  active: [{ id: 'f1', fingerprint: `condition:${TRIGGER_A}:${LATHE}:Spindle/BEARING_TEMPERATURE`, severity: 'warning', starts_at: '2026-11-09T11:00:00Z' }],
  history: [
    { id: 'f1', fingerprint: `condition:${TRIGGER_A}:${LATHE}:Spindle/BEARING_TEMPERATURE`, status: 'firing', starts_at: '2026-11-09T11:00:00Z', ends_at: null, severity: 'warning' },
    { id: 'f0', fingerprint: `condition:${TRIGGER_B}:${LATHE}:Press/CYCLE_TIME`, status: 'resolved', starts_at: '2026-11-07T08:00:00Z', ends_at: '2026-11-07T08:30:00Z', severity: 'critical' },
  ],
  ...over,
})

const show = async ({ role = 'Shopfloor_Manager', toast = vi.fn(), url = '/automations' } = {}) => {
  window.history.replaceState(null, '', url)
  await act(async () => { render(<AutomationsTab showToast={toast} userRole={role} hasPermission={() => true} />) })
  return toast
}

const row = (alias) => screen.getByText(alias).closest('tr')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  download.blobs.length = 0
  api.readAutomations.mockResolvedValue(read())
  api.automationsForEntity.mockResolvedValue([])
  api.resolveId.mockResolvedValue([])
  api.setAutomationEnabled.mockResolvedValue({})
  api.get.mockResolvedValue([])
  api.automationsDocument.mockResolvedValue({ automations: [hot], devices: read().devices })
  api.automationRow.mockResolvedValue({ id: 'row-hot', key: hot.id, automation_triggers: [{ id: TRIGGER_A }] })
  api.readAutomationAlerts.mockResolvedValue({ active: [], history: [] })
})
afterEach(() => { vi.useRealTimers() })

describe('the list', () => {
  it('says each automation by its alias and id, what it watches in words, and whether it is enabled', async () => {
    await show()
    expect(row('Lathe 3 spindle bearing hot')).toHaveTextContent('lathe-3-spindle-hot')
    expect(row('Lathe 3 spindle bearing hot')).toHaveTextContent('Spindle/BEARING_TEMPERATURE above 80 for 5 min on Lathe 3')
    // Two devices are counted, not named.
    expect(row('Press cycle slow')).toHaveTextContent('Press/CYCLE_TIME above 12 on 2 devices')
    expect(within(row('Lathe 3 spindle bearing hot')).getByRole('switch', { name: 'Enabled: Lathe 3 spindle bearing hot' })).toBeChecked()
    expect(within(row('Press cycle slow')).getByRole('switch', { name: 'Enabled: Press cycle slow' })).not.toBeChecked()
    // Never by colour alone: each state is said in words too.
    expect(row('Lathe 3 spindle bearing hot')).toHaveTextContent('On')
    expect(row('Press cycle slow')).toHaveTextContent('Off')
  })

  it('links each alias to its automation', async () => {
    await show()
    expect(screen.getByRole('link', { name: 'Lathe 3 spindle bearing hot' })).toHaveAttribute('href', '/automations/lathe-3-spindle-hot')
  })

  it('shows what is firing now, from the alerts of its triggers, and when each last fired', async () => {
    await show()
    expect(row('Lathe 3 spindle bearing hot')).toHaveTextContent('1 firing')
    expect(row('Lathe 3 spindle bearing hot')).toHaveTextContent('1h ago')
    expect(row('Press cycle slow')).not.toHaveTextContent('firing')
    expect(row('Press cycle slow')).toHaveTextContent('2d ago')
  })

  it('says Never for an automation that has not fired', async () => {
    api.readAutomations.mockResolvedValue(read({ history: [], active: [] }))
    await show()
    expect(row('Press cycle slow')).toHaveTextContent('Never')
    expect(row('Lathe 3 spindle bearing hot')).toHaveTextContent('Never')
  })

  it('puts the full time of the last firing in its tooltip', async () => {
    await show()
    const cell = within(row('Lathe 3 spindle bearing hot')).getByText('1h ago')
    expect(tooltipOf(cell)).toMatch(/9 Nov 2026, 11:00/)
  })

  it('opens on name order, and sorts by a column on a click, keeping the order in the address', async () => {
    await show()
    const names = () => [...document.querySelectorAll('tbody tr')].map(r => r.querySelectorAll('td')[1].querySelector('strong').textContent)
    expect(names()).toEqual(['Lathe 3 spindle bearing hot', 'Press cycle slow'])
    fireEvent.click(screen.getByRole('button', { name: /Last fired/ }))
    // Ascending by time: the one that fired longest ago first.
    expect(names()).toEqual(['Press cycle slow', 'Lathe 3 spindle bearing hot'])
    expect(window.location.search).toBe('?sort=last')
    fireEvent.click(screen.getByRole('button', { name: /Last fired/ }))
    expect(names()).toEqual(['Lathe 3 spindle bearing hot', 'Press cycle slow'])
  })

  it('says so when there is no automation, and what to do', async () => {
    api.readAutomations.mockResolvedValue(read({ automations: [], rows: [], active: [], history: [] }))
    await show()
    expect(screen.getByText(/No automation yet\. Choose New Automation to write one, or Upload/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Export/ })).toBeDisabled()
  })

  it('says a read that failed, with its reason, instead of an empty list', async () => {
    api.readAutomations.mockRejectedValue(new Error('permission denied for table automations'))
    await show()
    expect(await screen.findByText(/The automations could not be read: permission denied for table automations/)).toBeInTheDocument()
  })
})

describe('the search', () => {
  it('comes first in the toolbar and narrows by name, id, metric, device and description', async () => {
    await show()
    const bar = document.querySelector('.filter-bar')
    expect(bar.firstElementChild.querySelector('input[type="search"]')).not.toBeNull()
    const search = screen.getByRole('searchbox', { name: /Search automations/ })
    for (const [text, kept] of [['press', 'Press cycle slow'], ['bearing_temperature', 'Lathe 3 spindle bearing hot'], ['mill 1', 'Press cycle slow'], ['coolant', 'Lathe 3 spindle bearing hot'], ['press-slow', 'Press cycle slow']]) {
      fireEvent.change(search, { target: { value: text } })
      const names = [...document.querySelectorAll('tbody tr strong')].map(s => s.textContent)
      expect(names, text).toEqual([kept])
    }
    expect(window.location.search).toBe('?search=press-slow')
  })

  it('says which text found nothing, and Clear filters puts the list back', async () => {
    await show()
    fireEvent.change(screen.getByRole('searchbox', { name: /Search automations/ }), { target: { value: 'zebra' } })
    expect(screen.getByText(/No automation matches/)).toHaveTextContent('zebra')
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }))
    expect(screen.getAllByRole('switch')).toHaveLength(2)
    expect(window.location.search).toBe('')
  })
})

describe('from a device to its automations', () => {
  const rows = [
    { automation_id: 'a', key: 'lathe-3-spindle-hot', alias: 'Lathe 3 spindle bearing hot', enabled: true, reason: 'named' },
    { automation_id: 'a', key: 'lathe-3-spindle-hot', alias: 'Lathe 3 spindle bearing hot', enabled: true, reason: 'site-wide' },
  ]

  it('narrows the list to the automations that apply, names the device in a chip, and says why each applies', async () => {
    api.automationsForEntity.mockResolvedValue(rows)
    api.resolveId.mockResolvedValue([{ kind: 'device', id: LATHE, name: 'Lathe 3' }])
    await show({ url: `/automations?entity=${LATHE}` })
    await screen.findByText('Applies to')
    expect(api.automationsForEntity).toHaveBeenCalledWith(LATHE)
    expect(screen.getByText('Applies to').closest('.automation-chip')).toHaveTextContent('Applies to Lathe 3')
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1)
    const reasons = row('Lathe 3 spindle bearing hot')
    expect(within(reasons).getByText('Named')).toBeInTheDocument()
    expect(within(reasons).getByText('Site-wide')).toBeInTheDocument()
    expect(tooltipOf(within(reasons).getByText('Site-wide'))).toBe('It applies to every modelled device, this one included.')
  })

  it('clears the filter from the chip, back to every automation', async () => {
    api.automationsForEntity.mockResolvedValue(rows)
    api.resolveId.mockResolvedValue([{ kind: 'device', id: LATHE, name: 'Lathe 3' }])
    await show({ url: `/automations?entity=${LATHE}` })
    await screen.findByText('Applies to')
    fireEvent.click(screen.getByRole('button', { name: /Show every automation/ }))
    await waitFor(() => expect(document.querySelectorAll('tbody tr')).toHaveLength(2))
    expect(window.location.search).toBe('')
    expect(screen.queryByText('Applies to')).toBeNull()
  })

  it('says when nothing applies to the entity, and keeps the chip to undo it', async () => {
    api.automationsForEntity.mockResolvedValue([])
    await show({ url: `/automations?entity=${MILL}` })
    expect(await screen.findByText(/No automation applies to this entity/)).toBeInTheDocument()
    // With the name unknown, the chip carries the id.
    expect(document.querySelector('.automation-chip')).toHaveTextContent(MILL)
  })

  it('drops an entity that is not an id from the address', async () => {
    await show({ url: '/automations?entity=lathe' })
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(api.automationsForEntity).not.toHaveBeenCalled()
  })
})

describe('turning one on or off', () => {
  it('disables an enabled automation at once, and says so in a toast that links to it', async () => {
    const toast = await show()
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Enabled: Lathe 3 spindle bearing hot' })) })
    expect(api.setAutomationEnabled).toHaveBeenCalledWith('lathe-3-spindle-hot', false)
    expect(toast).toHaveBeenCalledWith("Automation 'Lathe 3 spindle bearing hot' disabled", 'success', { to: '/automations/lathe-3-spindle-hot' })
    // The list is read again, so the row shows what the database now says.
    expect(api.readAutomations).toHaveBeenCalledTimes(2)
  })

  it('enables a disabled one', async () => {
    const toast = await show()
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Enabled: Press cycle slow' })) })
    expect(api.setAutomationEnabled).toHaveBeenCalledWith('press-slow', true)
    expect(toast).toHaveBeenCalledWith("Automation 'Press cycle slow' enabled", 'success', { to: '/automations/press-slow' })
  })

  it("shows the database's refusal, as it worded it", async () => {
    api.setAutomationEnabled.mockRejectedValue(new Error('This automation has no live trigger, so there is nothing to enable. Add a trigger first.'))
    const toast = await show()
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Enabled: Press cycle slow' })) })
    expect(toast).toHaveBeenCalledWith('This automation has no live trigger, so there is nothing to enable. Add a trigger first.', 'error')
  })
})

describe('for a role that may not write', () => {
  it.each(['Operator', 'Auditor'])('leaves %s no write control: the switches, Upload and New Automation are off, and say who may', async (role) => {
    await show({ role })
    for (const sw of screen.getAllByRole('switch')) expect(sw).toBeDisabled()
    for (const name of [/Upload/, /New Automation/]) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(button).toHaveClass('btn-disabled')
      expect(tooltipOf(button)).toBe(AUTOMATION_WRITE_TITLE)
    }
    expect(AUTOMATION_WRITE_TITLE).toBe('Requires Administrator or Shopfloor Manager')
    // A reader may still take the automations away as a file.
    expect(screen.getByRole('button', { name: /Export/ })).toBeEnabled()
    fireEvent.click(within(row('Press cycle slow')).getByRole('switch'))
    expect(api.setAutomationEnabled).not.toHaveBeenCalled()
  })

  it.each(['Administrator', 'Shopfloor_Manager'])('gives %s every control', async (role) => {
    await show({ role })
    for (const sw of screen.getAllByRole('switch')) expect(sw).toBeEnabled()
    expect(screen.getByRole('button', { name: /Upload/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /New Automation/ })).toBeEnabled()
  })

  it('keeps the toolbar in its order: search, then Upload, Export and New Automation last, each filled', async () => {
    await show()
    const actions = [...document.querySelectorAll('.filter-bar-actions button')].map(b => b.textContent.trim())
    expect(actions).toEqual(['Upload', 'Export', 'New Automation'])
    for (const b of document.querySelectorAll('.filter-bar-actions button')) expect(b).toHaveClass('btn-primary')
  })
})

describe('Export', () => {
  const doc = { automations: [hot], devices: { [LATHE]: { name: 'Lathe 3', place: 'Cell 2 · Machining' } } }

  it('writes every automation as automations.yaml when none is ticked', async () => {
    api.automationsDocument.mockResolvedValue({ automations: [hot, slow], devices: read().devices })
    const toast = await show()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export' })) })
    expect(api.automationsDocument).toHaveBeenCalledWith(null)
    expect(download.blobs).toHaveLength(1)
    expect(download.blobs[0].name).toBe('automations.yaml')
    const text = await download.blobs[0].blob.text()
    expect(text).toContain('- id: lathe-3-spindle-hot')
    expect(text).toContain('- id: press-slow')
    expect(text).toContain(`device: ${LATHE} # Lathe 3 · Cell 2 · Machining`)
    expect(toast).toHaveBeenCalledWith('Exported 2 automations to automations.yaml', 'success')
  })

  it('writes the ticked ones, and the button says how many', async () => {
    api.automationsDocument.mockResolvedValue(doc)
    await show()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Lathe 3 spindle bearing hot' }))
    expect(screen.getByRole('button', { name: 'Export 1' })).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export 1' })) })
    expect(api.automationsDocument).toHaveBeenCalledWith(['lathe-3-spindle-hot'])
    expect(await download.blobs[0].blob.text()).not.toContain('press-slow')
  })

  it('ticks every automation shown from the header, and clears them again', async () => {
    await show()
    const all = screen.getByRole('checkbox', { name: 'Select every automation shown' })
    fireEvent.click(all)
    expect(screen.getByRole('button', { name: 'Export 2' })).toBeInTheDocument()
    fireEvent.click(all)
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument()
  })

  it('says a failure as an error', async () => {
    api.automationsDocument.mockRejectedValue(new Error('network down'))
    const toast = await show()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export' })) })
    expect(toast).toHaveBeenCalledWith('network down', 'error')
    expect(download.blobs).toHaveLength(0)
  })
})

describe('New Automation', () => {
  it('opens the editor on an example at /automations/new', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: /New Automation/ }))
    expect(window.location.pathname).toBe('/automations/new')
  })
})

describe('an alert opens its automation', () => {
  it('finds the automation by the trigger the alert names, and opens it in place of the redirect', async () => {
    api.automationOfTrigger.mockResolvedValue({ key: 'lathe-3-spindle-hot' })
    await show({ url: `/automations?trigger=${TRIGGER_A}` })
    await waitFor(() => expect(window.location.pathname).toBe('/automations/lathe-3-spindle-hot'))
    expect(api.automationOfTrigger).toHaveBeenCalledWith(TRIGGER_A)
  })

  it('says the automation has been deleted when none owns the trigger any more', async () => {
    api.automationOfTrigger.mockResolvedValue(null)
    await show({ url: `/automations?trigger=${TRIGGER_A}` })
    expect(await screen.findByText(/has been deleted/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Show every automation' })).toHaveAttribute('href', '/automations')
  })
})

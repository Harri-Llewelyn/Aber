import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { visiblePages } from '../navigation'
import { DEFAULT_ROLE_PERMISSIONS_MAP } from '../hooks/usePermissions'
import { entityUrl, findEntityUrl, identityUrl, personUrl, trailUrl } from '../routes'
import { DIRECTORY_KINDS } from '../utils/entities'
import { KNOWN_PRINCIPALS } from '../utils/serviceIdentities'

/**
 * The records the top bar's search finds: which read answers them, what a row says, where it opens for each
 * role, what an id offers, how many of a kind are listed, and that nothing a person is about to press moves
 * as they arrive. The rows are entity_directory's (0321), which the database narrows to each reader.
 */

vi.mock('../api', () => ({
  api: { findEntities: vi.fn(), listPeople: vi.fn(), listUserAccounts: vi.fn(), get: vi.fn() }
}))
// No help rows, so a heading in help/ cannot change these cases.
vi.mock('../help/searchIndex', async (importOriginal) => ({ ...(await importOriginal()), searchHelp: () => [] }))

import { api } from '../api'
import { GlobalSearch, RECORD_KIND_LIMIT } from '../components/common/GlobalSearch'

const uuid = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const rec = (kind, id, name, extra = {}) => ({
  kind, id, name, description: null, state: 'active', variant: null, second_ids: [],
  area_id: null, cell_id: null, gateway_id: null, device_id: null, page_id: id, ...extra,
})

const SEMANTIC = 'https://admin-shell.io/zvei/nameplate/2/0/Nameplate/ContactInformation/AddressInformation/Street'
const DEVICE = rec('devices', uuid(4), 'Haas 10', { second_ids: ['deva00000000000400080000', 'plc-10'] })
const METRIC = rec('metric_catalog', uuid(7), 'Axes/TEMP', { second_ids: [SEMANTIC] })
const RETIRED = rec('gateways', uuid(32), 'Scrapped edge', { state: 'retired', page_id: null, second_ids: ['gwyold'] })

/** One of each kind, with where its own page opens it and what the row says. */
const KINDS = [
  [rec('areas', uuid(1), 'Machine Shop'), 'Area', entityUrl('area', uuid(1))],
  [rec('cells', uuid(2), 'Bay 1'), 'Cell', entityUrl('cell', uuid(2))],
  [rec('gateways', uuid(3), 'Edge 1', { second_ids: ['gwya0'] }), 'Gateway', entityUrl('gateway', uuid(3))],
  [DEVICE, 'Device', entityUrl('device', uuid(4))],
  [rec('schemas', uuid(6), 'Lathe_Schema', { variant: 'archived' }), 'Schema', entityUrl('schema', uuid(6))],
  [METRIC, 'Metric', entityUrl('metric', uuid(7))],
  [rec('metric_catalog', uuid(8), 'Parts/RATE', { variant: 'derived' }), 'Metric', entityUrl('metric', uuid(8), 'derived')],
  [rec('automations', uuid(9), 'Coolant is low', { second_ids: ['coolant-low'], page_id: 'coolant-low' }), 'Automation', entityUrl('automation', 'coolant-low')],
  [rec('captures', uuid(10), 'Press 3', { variant: 'device', page_id: uuid(44), second_ids: ['devb/0f.json'] }), 'Capture', entityUrl('capture', uuid(44), 'device')],
  [rec('backups', uuid(11), '20261124T031500Z', { second_ids: ['20261124T031500Z'], page_id: uuid(99) }), 'Backup', entityUrl('backup', uuid(99))],
  [rec('service_principals', uuid(12), 'Line 4 report'), 'Machine Identity', entityUrl('identity', uuid(12))],
]

const ADA = { user_id: uuid(20), email: 'ada@example.test', display_name: 'Ada Lovelace', status: 'active' }
const BOB = { user_id: uuid(21), email: 'bob@example.test', display_name: null, status: 'removed' }

const pagesOf = (role) => visiblePages(p => (DEFAULT_ROLE_PERMISSIONS_MAP[role] || []).includes(p), role)
const show = (role = 'Administrator') => {
  const props = { tabs: pagesOf(role), currentTab: 'site-map', userRole: role, onNavigate: vi.fn(), onSelectSetting: vi.fn(), onSelectSection: vi.fn(), onOpen: vi.fn() }
  return { ...props, ...render(<GlobalSearch {...props} />) }
}
const box = () => screen.getByRole('combobox')
const type = (value) => {
  fireEvent.focus(box())
  fireEvent.change(box(), { target: { value } })
}
const options = () => screen.queryAllByRole('option')
const labelOf = (option) => option.querySelector('.global-search-result-label').textContent
const detailOf = (option) => option.querySelector('.global-search-result-detail')?.textContent ?? null
const idOf = (option) => option.querySelector('.global-search-record-id')?.textContent ?? null
const labels = () => options().map(labelOf)
const optionOf = (label) => options().find(o => labelOf(o) === label)
const highlighted = () => labelOf(options().find(o => o.getAttribute('aria-selected') === 'true'))
const asked = () => api.findEntities.mock.calls.map(call => call[0])
/** Answers one search at a time, when the case says so. */
const held = () => {
  const answers = []
  api.findEntities.mockImplementation(() => new Promise((resolve, reject) => answers.push({ resolve, reject })))
  return answers
}

beforeEach(() => {
  vi.clearAllMocks()
  api.findEntities.mockReset().mockResolvedValue([])
  api.listPeople.mockReset().mockResolvedValue([ADA, BOB])
  api.listUserAccounts.mockReset().mockResolvedValue([{ user_id: ADA.user_id, email: ADA.email, display_name: ADA.display_name }])
  api.get.mockReset().mockResolvedValue([])
})

describe('the search', () => {
  it('asks the one search for an id and for a name, with each kind\'s share', async () => {
    show('Operator')
    type(DEVICE.id)
    await waitFor(() => expect(api.findEntities).toHaveBeenCalledWith(DEVICE.id, { share: RECORD_KIND_LIMIT, kinds: DIRECTORY_KINDS }))
    type('haas')
    await waitFor(() => expect(api.findEntities).toHaveBeenCalledWith('haas', { share: RECORD_KIND_LIMIT, kinds: DIRECTORY_KINDS }))
    expect(api.findEntities).toHaveBeenCalledTimes(2)
  })

  it('asks once for ten keystrokes typed together, with what they add up to', async () => {
    show('Operator')
    const text = 'haas 10 b'
    for (let i = 1; i <= text.length; i++) type(text.slice(0, i))
    await waitFor(() => expect(api.findEntities).toHaveBeenCalled())
    expect(asked()).toEqual([text])
  })

  it('asks from two characters, and nothing for one or for spaces', async () => {
    show('Operator')
    type('l')
    type('  l  ')
    type('la')
    await waitFor(() => expect(api.findEntities).toHaveBeenCalled())
    expect(asked()).toEqual(['la'])
  })

  for (const [row, kind, url] of KINDS) {
    const what = `${kind.toLowerCase()} (${row.variant ?? row.kind})`
    it(`finds a ${what} by its id and by its name, and opens its own page`, async () => {
      api.findEntities.mockResolvedValue([row])
      for (const text of [row.id, row.name, ...row.second_ids]) {
        const { onOpen, unmount } = show()
        type(text)
        const option = (await screen.findByText(row.name, { selector: '.global-search-result-label *' })).closest('[role="option"]')
        expect(detailOf(option)).toBe(kind)
        expect(option.querySelector('.global-search-result-icon svg')).not.toBeNull()
        fireEvent.click(option)
        expect(onOpen, text).toHaveBeenCalledWith(url)
        unmount()
      }
    })
  }

  it('says an archived row is archived and opens its page, and a retired one on the Entities page', async () => {
    const archived = rec('cells', uuid(30), 'Old bay', { state: 'archived' })
    api.findEntities.mockResolvedValue([archived, rec('cells', uuid(31), 'Old yard', { state: 'retired', page_id: null })])
    const { onOpen } = show('Shopfloor_Manager')
    type('old ')
    expect(detailOf((await screen.findByText('Old bay')).closest('[role="option"]'))).toBe('Cell · Archived')
    expect(detailOf(optionOf('Old yard'))).toBe('Cell · Retired')
    fireEvent.click(optionOf('Old bay'))
    expect(onOpen).toHaveBeenCalledWith(entityUrl('cell', archived.id))
    type('old ')
    fireEvent.click((await screen.findByText('Old yard')).closest('[role="option"]'))
    expect(onOpen).toHaveBeenLastCalledWith(findEntityUrl(uuid(31)))
  })

  it('opens the Entities page for a backup whose run is gone, which no page opens', async () => {
    api.findEntities.mockResolvedValue([rec('backups', uuid(11), '20261124T031500Z', { page_id: null })])
    const { onOpen } = show()
    type('20261124T031500Z')
    fireEvent.click((await screen.findByText('20261124T031500Z', { selector: '.global-search-result-label *' })).closest('[role="option"]'))
    expect(onOpen).toHaveBeenCalledWith(findEntityUrl(uuid(11)))
  })

  it('draws a kind this build does not know, under its own word, and opens it on the Entities page', async () => {
    api.findEntities.mockResolvedValue([rec('something_new', uuid(70), 'Haas thing')])
    const { onOpen } = show('Operator')
    type('haas')
    const option = (await screen.findByText('Haas thing')).closest('[role="option"]')
    expect(detailOf(option)).toBe('something_new')
    fireEvent.click(option)
    expect(onOpen).toHaveBeenCalledWith(findEntityUrl(uuid(70)))
  })
})

describe('each role', () => {
  const IDENTITY = KINDS.at(-1)[0]

  it('opens a machine identity on Access Control for an Administrator, and on Entities for an Auditor', async () => {
    api.findEntities.mockResolvedValue([IDENTITY])
    for (const [role, url] of [['Administrator', identityUrl(IDENTITY.id)], ['Auditor', findEntityUrl(IDENTITY.id)]]) {
      const { onOpen, unmount } = show(role)
      type('line 4')
      fireEvent.click((await screen.findByText('Line 4 report')).closest('[role="option"]'))
      expect(onOpen, role).toHaveBeenCalledWith(url)
      unmount()
    }
  })

  it('opens what every role may open on its own page', async () => {
    api.findEntities.mockResolvedValue([DEVICE])
    for (const role of ['Operator', 'Shopfloor_Manager', 'Auditor']) {
      const { onOpen, unmount } = show(role)
      type('haas')
      fireEvent.click((await screen.findByText('Haas 10')).closest('[role="option"]'))
      expect(onOpen, role).toHaveBeenCalledWith(entityUrl('device', DEVICE.id))
      unmount()
    }
  })

  it('reads people once, as the bar is first opened, for the two roles that may, each by its own read', async () => {
    for (const [role, read, other] of [['Administrator', api.listPeople, api.listUserAccounts], ['Auditor', api.listUserAccounts, api.listPeople]]) {
      const { unmount } = show(role)
      expect(read, role).not.toHaveBeenCalled()
      type('ada')
      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
      fireEvent.keyDown(box(), { key: 'Escape' })
      type('ada@')
      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
      expect(read, role).toHaveBeenCalledTimes(1)
      expect(other, role).not.toHaveBeenCalled()
      unmount()
      vi.clearAllMocks()
    }
  })

  it('never reads people for another role, nor before the role is known', async () => {
    for (const role of ['Operator', 'Shopfloor_Manager', null]) {
      const { unmount } = show(role)
      type('ada')
      await waitFor(() => expect(api.findEntities).toHaveBeenCalled())
      expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument()
      expect(api.listPeople, role).not.toHaveBeenCalled()
      expect(api.listUserAccounts, role).not.toHaveBeenCalled()
      unmount()
      vi.clearAllMocks()
    }
  })

  it('finds a person by name, by any part of their email and by their id, and opens them where the role may', async () => {
    for (const [role, url] of [['Administrator', personUrl(ADA.user_id)], ['Auditor', findEntityUrl(ADA.user_id)]]) {
      for (const text of ['love', 'da@exam', ADA.user_id]) {
        const { onOpen, unmount } = show(role)
        type(text)
        const option = (await screen.findByText('Ada Lovelace')).closest('[role="option"]')
        expect(detailOf(option)).toBe('Person')
        fireEvent.click(option)
        expect(onOpen, `${role} ${text}`).toHaveBeenCalledWith(url)
        unmount()
      }
    }
  })

  it('opens a person whose access was removed among the removed', async () => {
    const { onOpen } = show('Administrator')
    type('bob@')
    fireEvent.click((await screen.findByText('bob@example.test')).closest('[role="option"]'))
    expect(onOpen).toHaveBeenCalledWith(personUrl(BOB.user_id, true))
  })

  it('finds an identity a migration pinned, for the same two roles', async () => {
    const [id, known] = Object.entries(KNOWN_PRINCIPALS)[0]
    for (const [role, finds] of [['Administrator', true], ['Auditor', true], ['Shopfloor_Manager', false]]) {
      const { unmount } = show(role)
      type(id)
      await screen.findByText('View in Entities')
      expect(labels().includes(known.name), role).toBe(finds)
      unmount()
    }
  })

  it('finds the rest where the read of people is refused', async () => {
    api.listPeople.mockRejectedValue(new Error('refused'))
    api.findEntities.mockResolvedValue([DEVICE])
    show('Administrator')
    type('haas')
    expect(await screen.findByText('Haas 10')).toBeInTheDocument()
  })

  it('shows the records and the people together, when both are in', async () => {
    let people
    api.listPeople.mockImplementation(() => new Promise(resolve => { people = resolve }))
    api.findEntities.mockResolvedValue([rec('devices', uuid(50), 'Adapter')])
    show('Administrator')
    type('ada')
    await waitFor(() => expect(api.findEntities).toHaveBeenCalled())
    expect(screen.queryByText('Adapter')).toBeNull()
    people([ADA])
    await screen.findByText('Adapter')
    expect(labels()).toEqual(['Ada Lovelace', 'Adapter'])
  })
})

describe('an id', () => {
  const ID_ROWS = ['View in Entities', 'Find This ID in the Audit Trail']

  it('offers the Entities page and the Audit Trail under the records, in that order', async () => {
    api.findEntities.mockResolvedValue([DEVICE])
    const { onOpen } = show('Shopfloor_Manager')
    type(DEVICE.id)
    await screen.findByText('Haas 10')
    expect(labels()).toEqual(['Haas 10', ...ID_ROWS])
    expect(within(screen.getByRole('group', { name: 'This ID' })).getAllByRole('option').map(labelOf)).toEqual(ID_ROWS)
    fireEvent.click(optionOf(ID_ROWS[0]))
    expect(onOpen).toHaveBeenCalledWith(findEntityUrl(DEVICE.id))
    type(DEVICE.id)
    fireEvent.click(await screen.findByText(ID_ROWS[1]))
    expect(onOpen).toHaveBeenLastCalledWith(trailUrl(DEVICE.id))
  })

  it('offers both where nothing has it, and says what it does not know', async () => {
    const ghost = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    const { onOpen } = show('Auditor')
    type(ghost)
    expect(await screen.findByText('No entity with that ID is visible to you.')).toBeInTheDocument()
    expect(labels()).toEqual(ID_ROWS)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(findEntityUrl(ghost))
  })

  it('offers both for the start of an id, a Sparkplug id and a semantic id that nothing has', async () => {
    for (const text of ['devf9966a4ee9ce4e519e6d5', '3f2504e0', '3f2504e0-4f89-41', 'urn:example:nothing', '0173-1#02-AAO677#002']) {
      const { unmount } = show('Shopfloor_Manager')
      type(text)
      await screen.findByText('View in Entities')
      expect(labels(), text).toEqual(ID_ROWS)
      unmount()
    }
  })

  it('offers neither for a name, nor for a word too short to be the start of an id', async () => {
    api.findEntities.mockResolvedValue([DEVICE])
    for (const text of ['haas 10', 'haas', 'deva000']) {
      const { unmount } = show('Shopfloor_Manager')
      type(text)
      await screen.findByText('Haas 10')
      expect(labels(), text).toEqual(['Haas 10'])
      unmount()
    }
  })

  it('leaves out the Audit Trail for a role that may not open it', async () => {
    api.findEntities.mockResolvedValue([DEVICE])
    show('Operator')
    type(DEVICE.id)
    await screen.findByText('Haas 10')
    expect(labels()).toEqual(['Haas 10', 'View in Entities'])
  })

  it('is known by what it names: a Sparkplug id, the id a device publishes, an automation\'s', async () => {
    for (const text of ['deva00000000000400080000', 'PLC-10', 'deva0000']) {
      api.findEntities.mockResolvedValue([DEVICE])
      const { onOpen, unmount } = show('Shopfloor_Manager')
      type(text)
      await screen.findByText('Haas 10')
      expect(labels(), text).toEqual(['Haas 10', ...ID_ROWS])
      expect(idOf(optionOf('Haas 10')).toLowerCase(), text).toContain(text.toLowerCase())
      // The Entities page is asked for the id as it was typed, which is what that page finds by.
      fireEvent.click(optionOf('View in Entities'))
      expect(onOpen, text).toHaveBeenCalledWith(findEntityUrl(text))
      unmount()
    }
  })

  it('opens the Audit Trail by the record\'s own id for a further id of one record, and by the text otherwise', async () => {
    const second = rec('schemas', uuid(61), 'Street', { second_ids: [SEMANTIC] })
    for (const [rows, text, handed] of [
      [[METRIC], SEMANTIC, METRIC.id],
      // Two records share it: neither's own id is "this ID".
      [[METRIC, second], SEMANTIC, SEMANTIC],
      // The start of an id is what the trail's own search reads.
      [[DEVICE], DEVICE.id.slice(0, 8), DEVICE.id.slice(0, 8)],
    ]) {
      api.findEntities.mockResolvedValue(rows)
      const { onOpen, unmount } = show('Auditor')
      type(text)
      fireEvent.click(await screen.findByText('Find This ID in the Audit Trail'))
      expect(onOpen).toHaveBeenCalledWith(trailUrl(handed))
      unmount()
    }
  })

  it('shows deleted entities in the Audit Trail where the id is a deleted one\'s, which that page hides', async () => {
    api.findEntities.mockResolvedValue([RETIRED])
    for (const text of [RETIRED.id, 'gwyold']) {
      const { onOpen, unmount } = show('Shopfloor_Manager')
      type(text)
      expect(detailOf((await screen.findByText('Scrapped edge')).closest('[role="option"]'))).toBe('Gateway · Retired')
      fireEvent.click(optionOf('Find This ID in the Audit Trail'))
      expect(onOpen, text).toHaveBeenCalledWith(trailUrl(RETIRED.id, '', true))
      unmount()
    }
  })

  it('has its two rows brought into view by the arrow keys, below a list longer than the panel', async () => {
    const seen = []
    Element.prototype.scrollIntoView = function scrollIntoView(how) { seen.push([labelOf(this), how]) }
    try {
      api.findEntities.mockResolvedValue([DEVICE])
      show('Shopfloor_Manager')
      type(DEVICE.id)
      await screen.findByText('Haas 10')
      fireEvent.keyDown(box(), { key: 'ArrowUp' })
      fireEvent.keyDown(box(), { key: 'ArrowUp' })
      expect(seen).toEqual([[ID_ROWS[1], { block: 'nearest' }], [ID_ROWS[0], { block: 'nearest' }]])
      expect(highlighted()).toBe(ID_ROWS[0])
    } finally { delete Element.prototype.scrollIntoView }
  })

  it('too long for its row is cut, and slides once a person highlights the row', async () => {
    api.findEntities.mockResolvedValue([METRIC])
    show('Operator')
    type(SEMANTIC)
    await screen.findByText('Axes/TEMP')
    const line = optionOf('Axes/TEMP').querySelector('.global-search-record-id')
    expect(line).toHaveClass('overflow-text')
    expect(line).toHaveTextContent(SEMANTIC)
    Object.defineProperty(line, 'scrollWidth', { configurable: true, value: 640 })
    Object.defineProperty(line, 'clientWidth', { configurable: true, value: 300 })
    // Highlighted as the list opens, and nothing moves by itself.
    expect(highlighted()).toBe('Axes/TEMP')
    expect(line).not.toHaveClass('overflow-text-sliding')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(line).toHaveClass('overflow-text-sliding')
    expect(line.style.getPropertyValue('--overflow-shift')).toBe('-340px')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(line.style.getPropertyValue('--overflow-shift')).toBe('0px')
  })
})

describe('how many are listed', () => {
  const many = (kind, from, n, name) => Array.from({ length: n }, (_, i) => rec(kind, uuid(from + i), `${name} ${i + 1}`))

  it('is at most ten of a kind, so four hundred devices leave room for three cells', async () => {
    api.findEntities.mockResolvedValue([...many('devices', 1000, 400, 'Bay lathe'), ...many('cells', 2000, 3, 'Bay zone')])
    show('Operator')
    type('bay')
    await screen.findByText('Bay zone 1')
    const kinds = options().map(detailOf)
    expect(kinds.filter(k => k === 'Device')).toHaveLength(RECORD_KIND_LIMIT)
    expect(kinds.filter(k => k === 'Cell')).toHaveLength(3)
  })

  it('puts a whole id first and a whole name next, whatever their kind', async () => {
    const named = rec('metric_catalog', uuid(3000), 'bay lathe')
    const whole = rec('automations', uuid(3001), 'Something else', { second_ids: ['bay lathe'], page_id: 'x' })
    api.findEntities.mockResolvedValue([whole, named, ...many('devices', 1000, 20, 'Bay lathe')])
    show('Operator')
    type('Bay Lathe')
    await screen.findByText('Something else')
    expect(labels().slice(0, 3)).toEqual(['Something else', 'bay lathe', 'Bay lathe 1'])
  })

  it('puts what is in service before what was taken out, so old names take no live one\'s place', async () => {
    const old = many('devices', 1000, 30, 'Bay lathe').map(row => ({ ...row, state: 'retired', page_id: null }))
    api.findEntities.mockResolvedValue([...old, rec('devices', uuid(4000), 'Bay press')])
    show('Operator')
    type('bay')
    await screen.findByText('Bay press')
    expect(labels()[0]).toBe('Bay press')
    expect(labels()).toHaveLength(RECORD_KIND_LIMIT)
  })

  it('puts a device before its capture, which goes by its name', async () => {
    api.findEntities.mockResolvedValue([rec('captures', uuid(5000), 'Haas 10', { variant: 'device', page_id: DEVICE.id }), DEVICE])
    show('Shopfloor_Manager')
    type('haas 10')
    await screen.findAllByText('Haas 10')
    expect(options().map(detailOf)).toEqual(['Device', 'Capture'])
  })

  it('is said to a screen reader once the records are in, and not while they are on their way', async () => {
    const answers = held()
    show('Operator')
    const status = screen.getByRole('status')
    type('haas')
    await waitFor(() => expect(answers).toHaveLength(1))
    expect(status).toBeEmptyDOMElement()
    answers[0].resolve([DEVICE])
    await waitFor(() => expect(status).toHaveTextContent('1 result'))
    expect(status).not.toHaveTextContent('results')
    type('haasx')
    await waitFor(() => expect(answers).toHaveLength(2))
    answers[1].resolve([])
    await waitFor(() => expect(status).toHaveTextContent('No results'))
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(status).toBeEmptyDOMElement()
  })
})

describe('as the records arrive', () => {
  it('nothing above them moves, and the highlighted row stays highlighted', async () => {
    const answers = held()
    show('Operator')
    type('device')
    const before = labels()
    expect(before.length).toBeGreaterThan(1)
    fireEvent.mouseMove(options()[1])
    const was = highlighted()
    await waitFor(() => expect(answers).toHaveLength(1))
    answers[0].resolve([rec('devices', uuid(60), 'Device rig')])
    await screen.findByText('Device rig')
    expect(labels()).toEqual([...before, 'Device rig'])
    expect(highlighted()).toBe(was)
  })

  it('an id\'s two rows come with them, so a record does not push the row under the cursor down', async () => {
    const answers = held()
    show('Shopfloor_Manager')
    type(DEVICE.id)
    expect(await screen.findByText('Looking up that ID…')).toBeInTheDocument()
    expect(options()).toHaveLength(0)
    await waitFor(() => expect(answers).toHaveLength(1))
    answers[0].resolve([DEVICE])
    await screen.findByText('Haas 10')
    expect(screen.queryByText('Looking up that ID…')).toBeNull()
    expect(labels()).toEqual(['Haas 10', 'View in Entities', 'Find This ID in the Audit Trail'])
    // Enter on a pasted id opens the record.
    expect(highlighted()).toBe('Haas 10')
  })

  it('a highlighted record stays through a keystroke that still names it, and Enter opens it', async () => {
    const answers = held()
    const { onOpen } = show('Operator')
    type('haas')
    await waitFor(() => expect(answers).toHaveLength(1))
    answers[0].resolve([DEVICE, rec('devices', uuid(61), 'Haas 11'), rec('devices', uuid(62), 'Haas 2')])
    await screen.findByText('Haas 11')
    expect(labels()).toEqual(['Haas 2', 'Haas 10', 'Haas 11'])
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(highlighted()).toBe('Haas 11')
    type('haas 1')
    // Before the answer: the rows the new text does not name are gone, and the rest are as they were.
    expect(labels()).toEqual(['Haas 10', 'Haas 11'])
    expect(highlighted()).toBe('Haas 11')
    await waitFor(() => expect(answers).toHaveLength(2))
    answers[1].resolve([rec('devices', uuid(63), 'Haas 1'), DEVICE, rec('devices', uuid(61), 'Haas 11')])
    await screen.findByText('Haas 1')
    expect(labels()).toEqual(['Haas 1', 'Haas 10', 'Haas 11'])
    expect(highlighted()).toBe('Haas 11')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(entityUrl('device', uuid(61)))
  })

  it('a text that has nothing to do with the last one shows none of its records', async () => {
    const answers = held()
    show('Operator')
    type('haas')
    await waitFor(() => expect(answers).toHaveLength(1))
    answers[0].resolve([DEVICE])
    await screen.findByText('Haas 10')
    type('press')
    expect(screen.queryByText('Haas 10')).toBeNull()
    expect(screen.queryByText(/Nothing matches/)).toBeNull()
  })

  it('a failed search reads as nothing found', async () => {
    const answers = held()
    show('Operator')
    type('zzzz')
    expect(screen.getByText('Searching…')).toBeInTheDocument()
    await waitFor(() => expect(answers).toHaveLength(1))
    answers[0].reject(new Error('statement timeout'))
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument()
  })
})

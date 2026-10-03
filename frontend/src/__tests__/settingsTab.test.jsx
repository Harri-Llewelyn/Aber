/**
 * The Settings page. Three things are easy to break silently: a non-Administrator's save must not
 * look like a success, since RLS makes their UPDATE affect zero rows without erroring; the page
 * offers no way to add or delete a setting, because the key set is closed in the database; and the
 * value is coerced to its declared type before it is sent.
 */
import React from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsTab, coerceValue, displayValue, fallbackCopy, groupByCategory } from '../components/tabs/SettingsTab'
import { api } from '../api'
import { COLD_STORAGE_DIALOG_KEYS } from '../utils/coldStorage'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), patchSetting: vi.fn() } }
})

const SETTINGS = [
  {
    id: '2', key: 'ui.audit_trail_poll_seconds', value: 60, value_type: 'number',
    category: 'Audit Trail', label: 'Refresh interval (seconds)',
    description: 'How often the Audit Trail re-reads the audit log.',
    fallback_source: 'DEFAULT_POLL_SECONDS (60) in AuditTrailTab.jsx',
    updated_at: '2026-08-22T10:00:00Z', updated_by: null
  },
  {
    id: '3', key: 'alerts.retention_days', value: 7, value_type: 'number',
    category: 'Retention', label: 'Alert history kept for (days)',
    description: 'How long a resolved alert occurrence is kept.',
    fallback_source: 'the p_retain default in prune_platform_alerts()',
    min_value: 1, max_value: 3650,
    updated_at: '2026-08-22T10:00:00Z', updated_by: null
  }
]


describe('value coercion', () => {
  it('turns a numeric field into a number', () => {
    expect(coerceValue('42', 'number')).toBe(42)
  })

  it('refuses a number field that is not a number', () => {
    /* Not parseFloat, which accepts '30abc' as 30. Number() returns NaN and this refuses. */
    expect(() => coerceValue('30abc', 'number')).toThrow(/number/i)
    expect(() => coerceValue('', 'number')).toThrow(/number/i)
  })

  it('refuses a number below its floor or above its ceiling', () => {
    /* Checked here and by a CHECK constraint: the constraint makes the rule true, and this tells
       the operator before the round trip in the setting's own words. */
    const bounds = { min_value: 1, max_value: 3650 }
    expect(() => coerceValue('0', 'number', bounds)).toThrow(/1 or more/)
    expect(() => coerceValue('-5', 'number', bounds)).toThrow(/1 or more/)
    expect(() => coerceValue('36500', 'number', bounds)).toThrow(/3650 or less/)
    expect(coerceValue('7', 'number', bounds)).toBe(7)
    // Inclusive at both ends.
    expect(coerceValue('1', 'number', bounds)).toBe(1)
    expect(coerceValue('3650', 'number', bounds)).toBe(3650)
  })

  it('treats a floor of zero as a floor, not as an absent bound', () => {
    /* `if (min)` would be falsy for 0 and let a negative through; the check is `!= null`. */
    expect(() => coerceValue('-1', 'number', { min_value: 0 })).toThrow(/0 or more/)
    expect(coerceValue('0', 'number', { min_value: 0 })).toBe(0)
  })

  it('accepts any number when the setting declares no bounds', () => {
    expect(coerceValue('-999', 'number', {})).toBe(-999)
    expect(coerceValue('999999', 'number', { min_value: null, max_value: null })).toBe(999999)
  })

  it('parses a json setting and refuses malformed json', () => {
    expect(coerceValue('{"a":1}', 'json')).toEqual({ a: 1 })
    expect(() => coerceValue('{oops', 'json')).toThrow(/JSON/i)
  })

  it('reads a boolean back from the select', () => {
    expect(coerceValue('true', 'boolean')).toBe(true)
    expect(coerceValue('false', 'boolean')).toBe(false)
  })

  it('round-trips a json value through the textarea', () => {
    const original = { endpoint: 'https://s3.example', region: 'eu-west-2' }
    expect(coerceValue(displayValue(original, 'json'), 'json')).toEqual(original)
  })
})


describe('grouping', () => {
  it('keeps the order the API returned rather than re-sorting', () => {
    // The API orders by category then label so two administrators see the same page. Re-sorting
    // here would mean the order depended on which client rendered it.
    const groups = groupByCategory([
      { key: 'a.one', category: 'Zulu' }, { key: 'b.two', category: 'Alpha' },
      { key: 'c.three', category: 'Zulu' }
    ])
    expect(groups.map(g => g.category)).toEqual(['Zulu', 'Alpha'])
    expect(groups[0].settings).toHaveLength(2)
  })
})


describe('the page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(SETTINGS)
    api.patchSetting.mockResolvedValue({ key: 'x', value: 1 })
  })

  /* Rendered inside an async act() so the settings read, the render it causes and that render's
     effects have all run before a test touches the page. The label appears at commit, before
     SettingRow's effect re-seeds the draft from the stored value; an edit made in between is
     overwritten by it, and Save never appears. */
  const show = async () => {
    await act(async () => { render(<SettingsTab showToast={vi.fn()} />) })
    expect(screen.getByText('Refresh interval (seconds)')).toBeInTheDocument()
  }

  /* One category is on screen at a time, so a test about a setting outside the first one has to
     open its tab first -- the same click the operator makes. */
  const showCategory = async (category) => {
    await show()
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${category}`) }))
  }

  it('renders each setting with its label, and its description behind a tip', async () => {
    await show()
    expect(screen.getByText('Refresh interval (seconds)')).toBeInTheDocument()
    // The description is read on demand from the "?" beside the label rather than printed under
    // every row: the page is a list of controls, not a manual.
    const tip = screen.getByRole('button', { name: 'About Refresh interval (seconds)' })
    fireEvent.mouseEnter(tip)
    expect(screen.getByRole('tooltip')).toHaveTextContent(/How often the Audit Trail/)
  })

  it('names what applies when a setting has never been changed', async () => {
    /* An absent row is not an absent value: the fallback is the first thing to check when a setting
       appears to do nothing, so the page names it. */
    await show()
    expect(screen.getByText('DEFAULT_POLL_SECONDS (60) in AuditTrailTab.jsx')).toBeInTheDocument()
  })

  it('copies the key, and leaves a fallback that is prose as plain text', async () => {
    await show()
    expect(screen.getByRole('button', { name: 'Copy setting key ui.audit_trail_poll_seconds' })).toBeInTheDocument()
    const fallback = screen.getByText('DEFAULT_POLL_SECONDS (60) in AuditTrailTab.jsx')
    expect(fallback.closest('button')).toBeNull()
    expect(fallback).not.toHaveClass('mono')
  })

  it('offers no way to add or delete a setting', async () => {
    /* The absence is the feature: a New Setting button could only produce a row no code reads. */
    await show()
    expect(screen.queryByRole('button', { name: /new setting|add setting|delete/i })).toBeNull()
  })

  it('shows Save only once something has changed', async () => {
    // A permanently enabled Save invites the click that does nothing and then reports success.
    await show()
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull()
    // Nothing is reserved for the buttons while there is nothing to save.
    expect(document.querySelector('.setting-actions')).toBeNull()

    fireEvent.change(screen.getByLabelText('Refresh interval (seconds)'), { target: { value: '45' } })

    /* Awaited, like every other post-fireEvent assertion in the file: nothing in the page's
       contract promises the button appears in the same tick, and the guarantee (Save must appear)
       is unchanged. */
    const save = await screen.findByRole('button', { name: /^Save$/ })
    // Beside the field, in the same control row, rather than on a line of its own beneath the row.
    expect(save.closest('.setting-control')).toContainElement(screen.getByLabelText('Refresh interval (seconds)'))
  })

  it('sends the coerced value, not the string from the input', async () => {
    await show()
    fireEvent.change(screen.getByLabelText('Refresh interval (seconds)'), { target: { value: '45' } })
    fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(api.patchSetting).toHaveBeenCalled())
    expect(api.patchSetting).toHaveBeenCalledWith('ui.audit_trail_poll_seconds', 45)
  })

  it('refuses a malformed value locally rather than sending it', async () => {
    await show()
    const input = screen.getByLabelText('Refresh interval (seconds)')
    // The DOM number input would reject this itself in a browser; the page must not depend on that.
    fireEvent.change(input, { target: { value: 'not-a-number' } })
    fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(screen.getByText(/Enter a number/i)).toBeInTheDocument())
    expect(api.patchSetting).not.toHaveBeenCalled()
  })

  it('surfaces the reason a save failed rather than a generic message', async () => {
    /* The case this page most has to get right: api.patchSetting turns zero rows affected into an
       error because RLS does not raise one. */
    api.patchSetting.mockRejectedValue(
      new Error('That setting was not updated. Changing settings requires the Administrator role.')
    )
    await show()
    fireEvent.change(screen.getByLabelText('Refresh interval (seconds)'), { target: { value: '45' } })
    fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }))

    await waitFor(() =>
      expect(screen.getByText(/requires the Administrator role/i)).toBeInTheDocument())
  })

  it('discards an edit back to the stored value', async () => {
    await show()
    const input = screen.getByLabelText('Refresh interval (seconds)')
    fireEvent.change(input, { target: { value: '45' } })
    // Awaited for the reason given above: neither control is promised in the tick that changed
    // the input, and a synchronous lookup here is a pass that depends on how busy the run is.
    fireEvent.click(await screen.findByRole('button', { name: /Discard/i }))

    await waitFor(() => expect(input.value).toBe('60'))
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull()
  })

  it('shows the permitted range rather than hiding it in the input attributes', async () => {
    /* `min`/`max` give a browser its spinner limits and a reader nothing. */
    await showCategory('Retention')
    expect(screen.getByText('Between 1 and 3650')).toBeInTheDocument()
  })

  it('refuses an out-of-range value before sending it', async () => {
    await showCategory('Retention')
    fireEvent.change(screen.getByLabelText('Alert history kept for (days)'), { target: { value: '0' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Save$/ })[0])

    await waitFor(() => expect(screen.getByText(/1 or more/)).toBeInTheDocument())
    expect(api.patchSetting).not.toHaveBeenCalled()
  })

  it('offers each category as its own tab, and shows one at a time', async () => {
    /* Category drives the page's sections, and a retention window is not an Audit Trail control.
       The tab is now the only place a category is named, so these queries are unambiguous. */
    await show()
    expect(screen.getByRole('tab', { name: /^Audit Trail/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Retention/ })).toBeInTheDocument()

    // The first category the API returned is selected, and the other category's rows are absent.
    expect(screen.queryByLabelText('Alert history kept for (days)')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /^Retention/ }))
    expect(screen.getByLabelText('Alert history kept for (days)')).toBeInTheDocument()
    expect(screen.queryByLabelText('Refresh interval (seconds)')).toBeNull()
  })

  it('leaves the rule about secrets to the help page rather than a permanent callout', async () => {
    // help/settings.md says it in full; a warning on every visit stops being read.
    await show()
    expect(screen.queryByText(/Nothing secret is stored here/i)).toBeNull()
    expect(document.querySelector('.callout-warning')).toBeNull()
  })

  it('opens a setting found from the search on its tab, scrolled into view and highlighted', async () => {
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      const onClear = vi.fn()
      await act(async () => {
        render(<SettingsTab showToast={vi.fn()} initialSetting="alerts.retention_days" onClearSetting={onClear} />)
      })
      expect(screen.getByRole('tab', { name: /^Retention/ })).toHaveAttribute('aria-selected', 'true')
      const row = document.querySelector('[data-setting="alerts.retention_days"]')
      expect(row).toHaveClass('setting-row-found')
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
      expect(scrollIntoView.mock.contexts[0]).toBe(row)
      expect(onClear).toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('explains an empty list rather than rendering a blank page', async () => {
    api.get.mockResolvedValue([])
    render(<SettingsTab showToast={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/arrive by migration/i)).toBeInTheDocument())
  })
})

describe('a setting that is fixed at install', () => {
  /* The Sparkplug group (0131). It is displayed because an operator needs to know what their
     topics look like, and not editable because changing it re-addresses every gateway -- the
     database refuses the write, so a control that appeared to work would be a lie. */
  const READ_ONLY = [
    {
      id: '9', key: 'sparkplug.group_id', value: 'Plant-7', value_type: 'string',
      category: 'Site', label: 'Sparkplug group',
      description: 'The group every gateway on this site publishes under.',
      fallback_source: 'values.yaml ingestion.sparkplugGroup',
      read_only: true,
      updated_at: '2026-09-20T10:00:00Z', updated_by: null
    }
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(READ_ONLY)
    api.patchSetting.mockResolvedValue({ key: 'x', value: 1 })
  })

  // Settled inside act() for the reason given in the first describe.
  const show = async () => {
    await act(async () => { render(<SettingsTab showToast={vi.fn()} />) })
    expect(screen.getByText('Sparkplug group')).toBeInTheDocument()
  }

  it('shows the value', async () => {
    await show()
    expect(screen.getByLabelText('Sparkplug group')).toHaveValue('Plant-7')
  })

  it('does not offer an editable control', async () => {
    await show()
    expect(screen.getByLabelText('Sparkplug group')).toBeDisabled()
  })

  it('offers no Save, even after a change is attempted', async () => {
    await show()
    const input = screen.getByLabelText('Sparkplug group')
    fireEvent.change(input, { target: { value: 'Somewhere-Else' } })
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
    expect(api.patchSetting).not.toHaveBeenCalled()
  })

  it('says where the value is set rather than calling it a fallback', async () => {
    /* "falls back to" means "what applies if you never change this", which is wrong here: the
       chart value IS the value, and it is the only place it can be changed. */
    await show()
    expect(screen.getByText(/set by/i)).toBeInTheDocument()
    expect(screen.queryByText(/falls back to/i)).not.toBeInTheDocument()
  })

  it('copies the values.yaml path it is set by, not the words around it', async () => {
    await show()
    expect(screen.getByRole('button', { name: 'Copy values.yaml path ingestion.sparkplugGroup' })).toBeInTheDocument()
  })
})

describe('the Cold Storage rows', () => {
  /* Six archive settings are edited in the Cold Storage destination dialog, so each value has one
     editor. The threshold and the read-only site key stay here. */
  const archive = (key, extra = {}) => ({
    id: key, key, value: '', value_type: 'string', category: 'Cold Storage', label: key,
    description: null, fallback_source: null, updated_at: '2026-09-20T10:00:00Z', updated_by: null, ...extra
  })

  it('lists the threshold and the site key, and none of what the dialog edits', async () => {
    vi.clearAllMocks()
    api.get.mockResolvedValue([
      archive('archive.enabled', { value: false, value_type: 'boolean' }),
      archive('archive.endpoint'), archive('archive.region'), archive('archive.bucket'),
      archive('archive.access_key_id'),
      archive('archive.path_style', { value: false, value_type: 'boolean' }),
      archive('archive.tier_after_days', { value: 14, value_type: 'number' }),
      archive('archive.site_key', { value: 'broughton', read_only: true }),
    ])
    await act(async () => { render(<SettingsTab showToast={vi.fn()} />) })
    const keys = [...document.querySelectorAll('[data-setting]')].map(el => el.dataset.setting)
    expect(keys).toEqual(['archive.tier_after_days', 'archive.site_key'])
    expect(COLD_STORAGE_DIALOG_KEYS).toHaveLength(6)
  })

  it('lists none of the off-site destination the Backups dialog edits', async () => {
    vi.clearAllMocks()
    api.get.mockResolvedValue([
      archive('backup_offsite.endpoint', { category: 'Backups' }), archive('backup_offsite.bucket', { category: 'Backups' }),
      archive('backup_offsite.recipient', { category: 'Backups' }),
      archive('backup_offsite.path_style', { category: 'Backups', value: false, value_type: 'boolean' }),
      archive('archive.tier_after_days', { value: 14, value_type: 'number' }),
    ])
    await act(async () => { render(<SettingsTab showToast={vi.fn()} />) })
    const keys = [...document.querySelectorAll('[data-setting]')].map(el => el.dataset.setting)
    expect(keys).toEqual(['archive.tier_after_days'])
    expect(screen.queryByRole('tab', { name: /Backups/ })).toBeNull()
  })
})

describe('which fallbacks copy', () => {
  it('copies a values.yaml path or one identifier, and nothing that is prose', () => {
    expect(fallbackCopy('values.yaml coldArchive.s3.siteKey')).toMatchObject({ lead: 'values.yaml ', value: 'coldArchive.s3.siteKey' })
    expect(fallbackCopy('prune_platform_alerts()')).toMatchObject({ lead: '', value: 'prune_platform_alerts()' })
    expect(fallbackCopy('the p_retain default in prune_platform_alerts()')).toBeNull()
    expect(fallbackCopy('timescaledb.retention.retainFor (14 days)')).toBeNull()
    expect(fallbackCopy('none: the placement is refused')).toBeNull()
    expect(fallbackCopy(null)).toBeNull()
  })
})

describe('the page frame', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(SETTINGS)
  })

  it('is one card headed Settings, with the category tabs inside it under the heading', async () => {
    await act(async () => { render(<SettingsTab showToast={vi.fn()} />) })
    const heading = screen.getByRole('heading', { name: 'Settings' })
    const tabs = screen.getByRole('tablist', { name: 'Settings category' })
    const card = heading.closest('.card')
    expect(heading.closest('.card-heading')).toBeTruthy()
    expect(tabs.parentElement).toBe(card)
    expect(heading.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The card scrolls, not the page.
    expect(document.querySelector('.page-layout.page-fill')).not.toBeNull()
    expect(card).toHaveClass('card-fill')
    expect(card.querySelector(':scope > .card-fill-scroll')).toContainElement(screen.getByLabelText('Refresh interval (seconds)'))
    expect(document.querySelectorAll('.card')).toHaveLength(1)
  })

  it('puts the tab\'s tip in the toolbar row under the tabs, and counts nothing', async () => {
    await act(async () => { render(<SettingsTab showToast={vi.fn()} />) })
    const bar = document.querySelector('.card > .tab-strip + .filter-bar')
    expect(bar.querySelector('.help-tip')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'About Audit Trail settings' })).toBeInTheDocument()
    expect(document.querySelector('.section-count')).toBeNull()
    for (const tab of screen.getAllByRole('tab')) expect(tab).not.toHaveAttribute('title')

    fireEvent.click(screen.getByRole('tab', { name: /^Retention/ }))
    expect(screen.getByRole('button', { name: 'About Retention settings' })).toBeInTheDocument()
  })

  it('shows a load error as a danger callout inside the card', async () => {
    api.get.mockRejectedValue(new Error('permission denied for table system_settings'))
    await act(async () => { render(<SettingsTab showToast={vi.fn()} />) })
    const callout = screen.getByText(/permission denied/).closest('.callout')
    expect(callout.className).toContain('callout-danger')
    expect(document.querySelector('.settings-load-error')).toBeNull()
  })

  it('says loading inside a card while the read is out, with the heading already there', () => {
    api.get.mockReturnValue(new Promise(() => {}))
    render(<SettingsTab showToast={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByText(/Loading settings/).closest('.card')).toBeTruthy()
  })

  it('says none are declared, in the card, when the list is empty', async () => {
    api.get.mockResolvedValue([])
    await act(async () => { render(<SettingsTab showToast={vi.fn()} />) })
    expect(screen.getByText(/No settings are declared yet/).closest('.card')).toBeTruthy()
  })
})

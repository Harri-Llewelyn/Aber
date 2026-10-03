import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '../../api'
import { IconSettings, IconX, IconAlertTriangle } from '../common/Icons'
import CopyableId from '../common/CopyableId'
import { CardHeading } from '../common/CardHeading'
import { EmptyState } from '../common/EmptyState'
import { HelpTip } from '../common/HelpTip'
import { LoadingState } from '../common/LoadingState'
import { TabStrip } from '../common/TabStrip'
import { COLD_STORAGE_DIALOG_KEYS } from '../../utils/coldStorage'
import { BACKUP_OFFSITE_SETTING_KEYS } from '../../utils/backupOffsite'

// Settings another page's destination dialog edits, so each value has one editor.
const EDITED_ELSEWHERE = new Set([...COLD_STORAGE_DIALOG_KEYS, ...BACKUP_OFFSITE_SETTING_KEYS])

/**
 * The runtime configuration plane as a page. It cannot add or delete a setting: the key set is
 * closed in the database, where RLS grants UPDATE and nothing else, and a row exists because some
 * code reads it. The role gate on the tab is a courtesy; RLS refuses the write, which is why
 * `api.patchSetting` treats zero rows affected as an error.
 */

/**
 * Cast a form field back to the JSON type the row is declared to hold, and check its bounds. The
 * CHECK constraint is what makes the rule true; this tells the operator before the round trip, in
 * the setting's own words.
 */
export function coerceValue(raw, valueType, bounds = {}) {
  if (valueType === 'number') {
    // NOT parseFloat: it stops at the first non-numeric character, so "30abc" becomes 30 and the
    // operator's typo is silently accepted as a different number than they typed.
    const n = Number(raw)
    if (raw === '' || Number.isNaN(n)) throw new Error('Enter a number.')

    // `!= null` catches undefined as well, and deliberately admits 0 as a bound -- `if (min)`
    // would treat a floor of zero as "no floor", which is the one value a floor most needs to say.
    const { min_value: min, max_value: max } = bounds
    if (min != null && n < Number(min)) throw new Error(`Must be ${min} or more.`)
    if (max != null && n > Number(max)) throw new Error(`Must be ${max} or less.`)
    return n
  }
  if (valueType === 'boolean') return raw === true || raw === 'true'
  if (valueType === 'json') {
    try { return JSON.parse(raw) } catch { throw new Error('Enter valid JSON.') }
  }
  return String(raw)
}

/** The value as something an input can hold. */
export function displayValue(value, valueType) {
  if (valueType === 'json') {
    try { return JSON.stringify(value, null, 2) } catch { return String(value) }
  }
  if (value === null || value === undefined) return ''
  return String(value)
}

/** Settings grouped into the sections the page renders, in the order the API returned them. */
export function groupByCategory(settings) {
  const groups = []
  for (const s of settings) {
    let group = groups.find(g => g.category === s.category)
    if (!group) { group = { category: s.category, settings: [] }; groups.push(group) }
    group.settings.push(s)
  }
  return groups
}

/**
 * The part of a fallback worth copying, or null for prose. A `values.yaml <path>` copies the path,
 * and a fallback that is one identifier copies whole; a sentence that mentions one stays text.
 */
export function fallbackCopy(text) {
  const path = /^values\.yaml\s+(\S+)$/.exec(text || '')
  if (path) return { lead: 'values.yaml ', value: path[1], label: 'values.yaml path' }
  if (/^[A-Za-z_][\w.]*(\(\))?$/.test(text || '')) return { lead: '', value: text, label: 'identifier' }
  return null
}

function SettingRow({ setting, onSaved, showToast, highlighted = false }) {
  const [draft, setDraft] = useState(() => displayValue(setting.value, setting.value_type))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const rowRef = useRef(null)

  // The row the search bar asked for is scrolled to the middle of the card's scroller.
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView?.({ block: 'center' })
  }, [highlighted])

  // A refresh replaces every setting object. An unsaved draft survives it; a saved one shows the
  // stored value. Keyed on the stored value so the field re-seeds only when the row changed.
  useEffect(() => {
    setDraft(displayValue(setting.value, setting.value_type))
  }, [setting.value, setting.value_type])

  const stored = displayValue(setting.value, setting.value_type)
  const dirty = draft !== stored

  const save = async () => {
    setError(null)
    let coerced
    try {
      coerced = coerceValue(draft, setting.value_type, setting)
    } catch (e) {
      setError(e.message)
      return
    }
    setSaving(true)
    try {
      await api.patchSetting(setting.key, coerced)
      showToast?.(`${setting.label} saved`, 'success')
      onSaved?.()
    } catch (e) {
      // The database's own message, not a rewrite of it. A CHECK violation names the constraint
      // and an RLS miss names the role requirement; both are more useful than "Save failed".
      setError(e?.message || 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  const reset = () => { setDraft(stored); setError(null) }
  const copy = fallbackCopy(setting.fallback_source)
  // A number or an on/off choice takes the short field; text takes the longer one.
  const short = setting.value_type === 'number' || setting.value_type === 'boolean'

  return (
    <div ref={rowRef} className={`setting-row${highlighted ? ' setting-row-found' : ''}`} data-setting={setting.key}>
      <div className="setting-meta">
        <div className="setting-label-row">
          <label className="setting-label" htmlFor={`setting-${setting.key}`}>{setting.label}</label>
          {setting.description && <HelpTip label={`About ${setting.label}`} text={setting.description} />}
        </div>
        <div className="setting-provenance">
          <CopyableId
            value={setting.key}
            label="setting key"
            title="The key the code reads. It cannot be changed. Click to copy it."
            onNotify={showToast}
          />
          {/* Named, because an absent row is not an absent value: what applies when this has never
              been changed is the env var or constant below, and the first thing to check when a
              setting appears to do nothing. A read-only row's source is not a fallback -- it is
              where the value came from and the only place it can be changed. */}
          {setting.fallback_source && (
            <span
              className="setting-fallback"
              title={setting.read_only
                ? 'Where this value is set. Changing it here is not possible'
                : 'What applies if this setting is never changed'}
            >
              {setting.read_only ? 'set by ' : 'falls back to '}
              {copy ? (
                <>{copy.lead}<CopyableId value={copy.value} label={copy.label} onNotify={showToast} /></>
              ) : (
                <span>{setting.fallback_source}</span>
              )}
            </span>
          )}
        </div>
      </div>

      <div className="setting-control">
        {/* A read-only setting is rendered as such rather than left editable: the database refuses
            the write either way, so an operator is not offered a control that cannot work. Two
            settings are fixed: the Sparkplug group, which re-addresses every gateway if changed,
            and the archive site key. */}
        {setting.read_only ? (
          <input
            id={`setting-${setting.key}`}
            className={`form-control${short ? ' setting-input-short' : ''}`}
            type="text"
            value={stored}
            readOnly
            disabled
          />
        ) : setting.value_type === 'boolean' ? (
          <select
            id={`setting-${setting.key}`}
            className="form-control setting-input-short"
            value={draft === 'true' ? 'true' : 'false'}
            onChange={e => setDraft(e.target.value)}
          >
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        ) : setting.value_type === 'json' ? (
          <textarea
            id={`setting-${setting.key}`}
            className="form-control setting-json"
            rows={4}
            value={draft}
            onChange={e => setDraft(e.target.value)}
          />
        ) : (
          <input
            id={`setting-${setting.key}`}
            className={`form-control${short ? ' setting-input-short' : ''}`}
            type={setting.value_type === 'number' ? 'number' : 'text'}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            {...(setting.value_type === 'number' && setting.min_value != null
              ? { min: setting.min_value } : {})}
            {...(setting.value_type === 'number' && setting.max_value != null
              ? { max: setting.max_value } : {})}
          />
        )}

        {/* The range is shown, not only enforced: `min`/`max` on the input give a browser its
            spinner limits and nothing a reader can see. */}
        {setting.value_type === 'number' && (setting.min_value != null || setting.max_value != null) && (
          <div className="setting-bounds">
            {setting.min_value != null && setting.max_value != null
              ? `Between ${setting.min_value} and ${setting.max_value}`
              : setting.min_value != null
                ? `${setting.min_value} or more`
                : `${setting.max_value} or less`}
          </div>
        )}

        {/* SHOWN ONLY WHEN THERE IS A CHANGE TO SAVE, beside the field, reserving nothing. A
            permanently enabled Save invites the click that does nothing, then a toast saying it worked. */}
        {dirty && (
          <div className="setting-actions">
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={reset} disabled={saving}>
              <IconX size={13} /> Discard
            </button>
          </div>
        )}

        {error && <div className="setting-error">{error}</div>}
      </div>
    </div>
  )
}

export function SettingsTab({ showToast, initialSetting = '', onClearSetting }) {
  const [settings, setSettings] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  /* The category on screen, held by name rather than index: the list is rebuilt on every read, and
     an index would move the operator to a different category when one arrives or empties. Null
     until the first read resolves, then the first category the API returned. */
  const [category, setCategory] = useState(null)

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    api.get('/api/v1/settings')
      // The Cold Storage and Backups destination dialogs are the one editor of their rows, so
      // those rows are not listed here.
      .then(d => { setSettings((d || []).filter(s => !EDITED_ELSEWHERE.has(s.key))); setLoadError(null); setLoading(false) })
      .catch(e => { setLoadError(e?.message || 'Could not read settings.'); setLoading(false) })
  }, [])

  useEffect(() => { load(true) }, [load])

  const groups = useMemo(() => groupByCategory(settings), [settings])

  /* A setting arrived from the search bar. Its category is chosen once, when the read that can
     answer "which category?" lands -- not held, or the operator could never leave the category
     they were sent to. `onClearSetting` drops the key so a later return to the page starts where
     the page always starts. */
  const [foundKey, setFoundKey] = useState('')
  useEffect(() => {
    if (!initialSetting || settings.length === 0) return
    const found = settings.find(s => s.key === initialSetting)
    if (found) { setCategory(found.category); setFoundKey(found.key) }
    onClearSetting?.()
  }, [initialSetting, settings, onClearSetting])

  /* Falls back to the first category whenever the held one is not in the current list -- the first
     read, and a category that disappears. Chosen during render rather than in an effect, so the page
     never paints a tablist with nothing selected. */
  const activeCategory = groups.some(g => g.category === category) ? category : groups[0]?.category
  const activeGroup = groups.find(g => g.category === activeCategory)

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          {/* The page states its own limit, because it is surprising and deliberate: the list
              cannot be added to from here. */}
          <CardHeading
            icon={<IconSettings size={15} />}
            title="Settings"
            description="Values that take effect without a restart and override the environment defaults they name; the list is fixed, not added to by hand."
          />

          {loadError && (
            <div className="card-body">
              <div className="callout callout-danger">
                <IconAlertTriangle size={14} className="callout-icon" />
                <div>{loadError}</div>
              </div>
            </div>
          )}

          {loading ? (
            <LoadingState label="settings" />
          ) : settings.length === 0 && !loadError ? (
            <EmptyState
              icon={<IconSettings size={36} />}
              message="No settings are declared yet. They arrive by migration, alongside the code that reads them."
            />
          ) : groups.length > 0 && (<>
            {/* One category at a time; the card scrolls, the page does not. */}
            <TabStrip
              ariaLabel="Settings category"
              value={activeCategory}
              // Choosing a category by hand ends the search's highlight: it has been seen.
              onChange={category => { setCategory(category); setFoundKey('') }}
              tabs={groups.map(group => ({ id: group.category, label: group.category }))}
            />

            <div className="filter-bar">
              <HelpTip
                label={`About ${activeCategory} settings`}
                text="A change takes effect without a restart. Edit a value and Save, or Discard to go back. The ? beside a setting says what it controls, and the line beneath it names the default it overrides."
              />
            </div>

            {activeGroup && (
              <div className="card-fill-scroll settings-group" key={activeGroup.category}>
                {activeGroup.settings.map(s => (
                  <SettingRow key={s.key} setting={s} onSaved={() => load(false)} showToast={showToast} highlighted={s.key === foundKey} />
                ))}
              </div>
            )}
          </>)}
        </div>
      </div>
    </div>
  )
}

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { IconSettings, IconX, IconAlertTriangle } from '../common/Icons'
import { EmptyState } from '../common/EmptyState'
import { HelpTip } from '../common/HelpTip'
import { LoadingState } from '../common/LoadingState'
import { PageHeading } from '../common/PageHeading'
import { SectionCount } from '../common/SectionCount'
import { TabStrip } from '../common/TabStrip'

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

function SettingRow({ setting, onSaved, showToast, highlighted = false }) {
  const [draft, setDraft] = useState(() => displayValue(setting.value, setting.value_type))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

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

  return (
    <div className={`setting-row${highlighted ? ' setting-row-found' : ''}`} data-setting={setting.key}>
      <div className="setting-meta">
        <div className="setting-label-row">
          <label className="setting-label" htmlFor={`setting-${setting.key}`}>{setting.label}</label>
          {setting.description && <HelpTip label={`About ${setting.label}`} text={setting.description} />}
        </div>
        <div className="setting-provenance">
          <span className="mono setting-key" title="The key the code reads. Immutable.">{setting.key}</span>
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
              <span className="mono">{setting.fallback_source}</span>
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
            className="form-control"
            type="text"
            value={stored}
            readOnly
            disabled
          />
        ) : setting.value_type === 'boolean' ? (
          <select
            id={`setting-${setting.key}`}
            className="form-control"
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
            className="form-control"
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

        <div className="setting-actions">
          {/* SHOWN ONLY WHEN THERE IS A CHANGE TO SAVE. A permanently enabled Save invites the
              click that does nothing, and then the toast that says it worked. */}
          {dirty && (
            <>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={reset} disabled={saving}>
                <IconX size={13} /> Discard
              </button>
            </>
          )}
        </div>

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
      .then(d => { setSettings(d); setLoadError(null); setLoading(false) })
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
    <div className="page-layout">
      <div className="page-main">
        {/* The page states its own limit, because it is surprising and deliberate: the list cannot
            be added to from here. */}
        <PageHeading icon={<IconSettings size={15} />} title="Settings">
          Values that take effect without a restart and override the environment defaults they name;
          the list is fixed, not added to by hand.
        </PageHeading>

        {/* The second thing to say is a warning rather than a description, so it keeps the shape a
            warning has everywhere else instead of being a second paragraph nobody reads. */}
        <div className="callout callout-warning callout-page">
          <IconAlertTriangle size={14} className="callout-icon" />
          <div>
            <strong>Nothing secret is stored here.</strong> Every signed-in user can read this
            page. Credentials — S3 keys, OIDC client secrets — belong in the secret store, not in
            a setting.
          </div>
        </div>

        {loadError && (
          <div className="callout callout-danger callout-page">
            <IconAlertTriangle size={14} className="callout-icon" />
            <div>{loadError}</div>
          </div>
        )}

        {loading ? (
          <div className="card"><LoadingState label="settings" /></div>
        ) : settings.length === 0 && !loadError ? (
          <div className="card">
            <EmptyState
              icon={<IconSettings size={36} />}
              message="No settings are declared yet. They arrive by migration, alongside the code that reads them."
            />
          </div>
        ) : (<>
          {/* One category at a time. The categories were stacked as titled cards, which made a page
              of thirty settings a scroll to find the one being changed. */}
          <TabStrip
            ariaLabel="Settings category"
            value={activeCategory}
            // Choosing a category by hand ends the search's highlight: it has been seen.
            onChange={category => { setCategory(category); setFoundKey('') }}
            tabs={groups.map(group => ({
              id: group.category,
              label: group.category,
              count: group.settings.length,
              title: `${group.settings.length} setting${group.settings.length === 1 ? '' : 's'}`,
            }))}
          />

          {activeGroup && (
            <div className="card settings-group" key={activeGroup.category}>
              <div className="card-header">
                <h3 className="section-title">
                  {activeGroup.category}
                  <HelpTip
                    label={`About ${activeGroup.category} settings`}
                    text="A change takes effect without a restart. Edit a value and Save, or Discard to go back. The ? beside a setting says what it controls, and a note beneath it names the default it overrides."
                  />
                  <SectionCount total={activeGroup.settings.length} />
                </h3>
              </div>
              {activeGroup.settings.map(s => (
                <SettingRow key={s.key} setting={s} onSaved={() => load(false)} showToast={showToast} highlighted={s.key === foundKey} />
              ))}
            </div>
          )}
        </>)}
      </div>
    </div>
  )
}

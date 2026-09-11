import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { IconSettings, IconX } from '../common/Icons'
import { HelpTip } from '../common/HelpTip'

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

function SettingRow({ setting, onSaved, showToast }) {
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
    <div className="setting-row">
      <div className="setting-meta">
        <div className="setting-label-row">
          <label className="setting-label" htmlFor={`setting-${setting.key}`}>{setting.label}</label>
          {setting.description && <HelpTip label={`About ${setting.label}`} text={setting.description} />}
        </div>
        <div className="setting-provenance">
          <span className="mono setting-key" title="The key the code reads. Immutable.">{setting.key}</span>
          {/* Named, because an absent row is not an absent value: what applies when this has never
              been changed is the env var or constant below, and the first thing to check when a
              setting appears to do nothing. */}
          {setting.fallback_source && (
            <span className="setting-fallback" title="What applies if this setting is never changed">
              falls back to <span className="mono">{setting.fallback_source}</span>
            </span>
          )}
        </div>
      </div>

      <div className="setting-control">
        {setting.value_type === 'boolean' ? (
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

export function SettingsTab({ showToast }) {
  const [settings, setSettings] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const load = useCallback((isInitial = false) => {
    if (isInitial) setLoading(true)
    api.get('/api/v1/settings')
      .then(d => { setSettings(d); setLoadError(null); setLoading(false) })
      .catch(e => { setLoadError(e?.message || 'Could not read settings.'); setLoading(false) })
  }, [])

  useEffect(() => { load(true) }, [load])

  const groups = useMemo(() => groupByCategory(settings), [settings])

  if (loading) {
    return (
      <div className="page-layout"><div className="page-main">
        <div className="card" style={{ padding: '12px var(--inset)' }}>
          <div className="loading-wrap"><div className="spinner" /> Loading settings…</div>
        </div>
      </div></div>
    )
  }

  return (
    <div className="page-layout">
      <div className="page-main">
        {/* The page states its own limits, because both are surprising and deliberate: the list
            cannot be added to from here, and nothing secret is stored here. */}
        {/* Header, then body, the shape every other card uses. */}
        <div className="card settings-preamble" style={{ marginBottom: '12px' }}>
          <div className="card-header">
            <h3 className="section-title">
              <IconSettings size={15} style={{ verticalAlign: '-2px', marginRight: '6px' }} />
              Runtime configuration
            </h3>
          </div>
          <div className="card-body">
            <p>
              These take effect without a restart and override the environment defaults they name.
              The list is fixed: a setting appears here because code reads it, so new ones arrive
              with the feature that needs them rather than being added by hand.
            </p>
            <p className="settings-preamble-warning">
              <strong>Nothing secret is stored here.</strong> Every signed-in user can read this
              page. Credentials — S3 keys, OIDC client secrets — belong in the secret store, not in
              a setting.
            </p>
          </div>
        </div>

        {loadError && <div className="card settings-load-error">{loadError}</div>}

        {settings.length === 0 && !loadError ? (
          <div className="card empty-state">
            <div className="empty-icon"><IconSettings size={36} /></div>
            <div className="empty-text">
              No settings are declared yet. They arrive by migration, alongside the code that
              reads them.
            </div>
          </div>
        ) : (
          groups.map(group => (
            <div className="card settings-group" key={group.category}>
              <div className="settings-group-title">{group.category}</div>
              {group.settings.map(s => (
                <SettingRow key={s.key} setting={s} onSaved={() => load(false)} showToast={showToast} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

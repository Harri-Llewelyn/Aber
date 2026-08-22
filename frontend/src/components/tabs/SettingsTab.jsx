import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '../../api'
import { IconSettings, IconX } from '../common/Icons'

/**
 * The runtime configuration plane (migration 0031), as a page.
 *
 * WHAT THIS PAGE DELIBERATELY CANNOT DO: add a setting, or delete one. The key set is closed in
 * the database -- RLS grants UPDATE and nothing else -- so there is no "New setting" button here
 * and its absence is the feature rather than an omission. A settings row exists because some code
 * reads it; one an operator invented would be a control that does nothing, and nothing on the page
 * could say so.
 *
 * THE ROLE GATE ON THE TAB IS A COURTESY, NOT A CONTROL. `App.jsx` hides this tab from anyone who
 * is not an Administrator, and that gate is worth nothing on its own -- the same PATCH can be sent
 * with curl. What actually refuses is the RLS policy, which is why `api.patchSetting` treats "zero
 * rows affected" as an error: a non-Administrator's write does not fail, it silently matches
 * nothing, and a page that only checked for an exception would report success.
 */

/** Cast a form field back to the JSON type the row is declared to hold. */
export function coerceValue(raw, valueType) {
  if (valueType === 'number') {
    // NOT parseFloat: it stops at the first non-numeric character, so "30abc" becomes 30 and the
    // operator's typo is silently accepted as a different number than they typed.
    const n = Number(raw)
    if (raw === '' || Number.isNaN(n)) throw new Error('Enter a number.')
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

  // A refresh replaces every setting object, and a draft the operator has not saved must survive
  // that -- but one they HAVE saved should show the stored value. Keyed on the stored value, so
  // the field re-seeds only when the row actually changed underneath.
  useEffect(() => {
    setDraft(displayValue(setting.value, setting.value_type))
  }, [setting.value, setting.value_type])

  const stored = displayValue(setting.value, setting.value_type)
  const dirty = draft !== stored

  const save = async () => {
    setError(null)
    let coerced
    try {
      coerced = coerceValue(draft, setting.value_type)
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
        <label className="setting-label" htmlFor={`setting-${setting.key}`}>{setting.label}</label>
        {setting.description && <p className="setting-description">{setting.description}</p>}
        <div className="setting-provenance">
          <span className="mono setting-key" title="The key the code reads. Immutable.">{setting.key}</span>
          {/* NAMED, BECAUSE AN ABSENT ROW IS NOT AN ABSENT VALUE. What applies when this has never
              been changed is the env var or constant below, which is what keeps a local boot
              zero-configuration -- and is the first thing to check when a setting appears to do
              nothing. */}
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
          />
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
        <div className="card" style={{ padding: '16px' }}>
          <div className="loading-wrap"><div className="spinner" /> Loading settings…</div>
        </div>
      </div></div>
    )
  }

  return (
    <div className="page-layout">
      <div className="page-main">
        {/* THE PAGE STATES ITS OWN LIMITS, because both are surprising and both are deliberate:
            the list cannot be added to from here, and nothing secret is stored here. Someone
            looking for where to put an S3 key should find the answer on this page rather than
            after putting it somewhere it can be read by every signed-in user. */}
        <div className="settings-preamble card">
          <div className="settings-preamble-title">
            <IconSettings size={15} /> Runtime configuration
          </div>
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

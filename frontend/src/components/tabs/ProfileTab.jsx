import React, { useCallback, useEffect, useRef, useState } from 'react'
import { IconUser, IconLock, IconAlertTriangle, IconX, IconCopy, IconCheck } from '../common/Icons'
import { CardHeading } from '../common/CardHeading'
import { TabStrip } from '../common/TabStrip'
import { copyText } from '../common/CopyableId'
import { useUrlTab } from '../../hooks/useUrlState'
import { PROFILE_TABS } from '../../navigation'
import { SIDEBAR_MODES } from '../../hooks/useSidebarMode'
import { MIN_PASSWORD_LENGTH } from '../../utils/passwords'
import { DISPLAY_NAME_MAX, displayNameProblem, normaliseDisplayName } from '../../utils/displayName'
import { formatClockTime, formatDateTime, NO_VALUE } from '../../utils/format'
import { supabase } from '../../lib/supabaseClient'
import { SUPABASE_GATEWAY_KEY } from '../../config'
import { Tooltip } from '../common/Tooltip'

/** The page's tabs (navigation.jsx). The ids are the page's anchors: the search bar opens one by id. */
export const PROFILE_SECTIONS = PROFILE_TABS

const THEME_OPTIONS = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
]

/** One row of the Settings page's table: the name, what it does, its value, and what can be done. */
/**
 * Save and Discard for a row with an unsaved choice, as the Settings page shows them; nothing
 * otherwise. `disabled` holds both while a save runs, and Save alone while `saveBlocked` says why.
 */
function SaveDiscard({ dirty, onSave, onDiscard, disabled = false, saveBlocked = null }) {
  if (!dirty) return null
  return (
    <div className="setting-actions">
      <Tooltip text={saveBlocked}>
        <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={disabled || !!saveBlocked}>Save</button>
      </Tooltip>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onDiscard} disabled={disabled}>
        <IconX size={13} /> Discard
      </button>
    </div>
  )
}

function ProfileRow({ id, label, description, value, actions }) {
  return (
    <tr className="setting-row" data-profile-setting={id}>
      <td className="setting-cell setting-cell-name">
        {/* A label only where the value is a field: a label for nothing is no label at all. */}
        {typeof value === 'string'
          ? <span className="setting-label">{label}</span>
          : <label className="setting-label" htmlFor={`profile-${id}`}>{label}</label>}
      </td>
      <td className="setting-cell setting-cell-description">
        <p className="setting-description">{description}</p>
      </td>
      <td className="setting-cell setting-cell-value">
        {typeof value === 'string' ? <span className="profile-value">{value}</span> : value}
      </td>
      <td className="setting-cell setting-cell-actions">{actions}</td>
    </tr>
  )
}

const COPIED_MS = 1600
const COPY_BLOCKED = 'The browser would not copy it. Try again.'
const NO_SESSION = 'There is no session to copy. Sign in again.'

/**
 * A Copy button with the help code block's feedback. `read` runs on each press and returns the
 * text, or throws with the sentence to show; the text itself is never rendered.
 */
function CopyAction({ label, read }) {
  const [state, setState] = useState(null) // null | 'copied' | the sentence saying why not
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    let next
    try {
      next = (await copyText(await read())) ? 'copied' : COPY_BLOCKED
    } catch (err) {
      next = err.message || COPY_BLOCKED
    }
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(null), COPIED_MS)
  }

  return (<>
    <div className="setting-actions">
      <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
        {state === 'copied' ? <><IconCheck size={13} /> Copied</> : <><IconCopy size={13} /> {label}</>}
      </button>
    </div>
    {state && state !== 'copied' && <div className="setting-error" role="status">{state}</div>}
  </>)
}

/** The access token supabase-js holds now (renewed first if it had expired), or null. Never the refresh token. */
async function currentAccessToken() {
  const { data } = (await supabase.auth.getSession()) ?? {}
  return data?.session?.access_token ?? null
}

/** A JWT's `exp` in epoch ms, or null. Unverified: it only labels a token the browser already holds. */
function tokenExpiry(token) {
  try {
    const { exp } = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}

/** "Valid until 14:32", with the date when that is not today. */
function validUntil(expiresAt) {
  if (expiresAt === undefined) return 'Loading…'
  if (expiresAt === null) return NO_VALUE
  const today = new Date(expiresAt).toDateString() === new Date().toDateString()
  return `Valid until ${today ? formatClockTime(expiresAt) : formatDateTime(expiresAt)}`
}

/**
 * The person's own access token, for calling the API as themselves. The row shows when it stops
 * working, never the token. Copy reads the session again, so it copies the token supabase-js holds
 * at that moment, and the time shown becomes that token's.
 */
function AccessTokenRow() {
  // undefined while the session is read, null when there is no token with an `exp`.
  const [expiresAt, setExpiresAt] = useState(undefined)

  useEffect(() => {
    let live = true
    currentAccessToken()
      .then(token => { if (live) setExpiresAt(tokenExpiry(token)) })
      .catch(() => { if (live) setExpiresAt(null) })
    return () => { live = false }
  }, [])

  const read = useCallback(async () => {
    const token = await currentAccessToken()
    setExpiresAt(tokenExpiry(token))
    if (!token) throw new Error(NO_SESSION)
    return token
  }, [])

  return (
    <ProfileRow
      id="access-token"
      label="Access token"
      description="Paste it into Swagger UI or i3X Explorer to call the API as yourself. It acts as you, with your role, until it expires, and signing out does not end it sooner. Copy again for the current one."
      value={validUntil(expiresAt)}
      actions={<CopyAction label="Copy Token" read={read} />}
    />
  )
}

/**
 * The person's own display name (0203): shown first wherever they appear, with their email beside it
 * where trust matters. Held as a draft until Save, as the other rows are; an empty name clears it.
 * `displayName` is undefined while it is read. A machine identity has none.
 */
function DisplayNameRow({ displayName, onSave, isPerson }) {
  // null while the row shows what is saved.
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const loading = displayName === undefined
  const shown = draft ?? (displayName || '')
  const problem = displayNameProblem(shown)
  const dirty = draft !== null && normaliseDisplayName(draft) !== (displayName || null)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave?.(normaliseDisplayName(draft))
      setDraft(null)
    } catch (err) {
      setError(err.message || 'Your display name was not saved.')
    } finally {
      setSaving(false)
    }
  }

  if (!isPerson) {
    return (
      <ProfileRow
        id="display-name"
        label="Display name"
        description="The name shown beside a person's email address."
        value="None: a machine identity is named on the Access Control page"
      />
    )
  }
  return (
    <ProfileRow
      id="display-name"
      label="Display name"
      description="Shown first wherever you appear, with your email address beside it on the Audit Trail, Approvals and People. Leave it empty to be shown by your email address alone."
      value={(<>
        <input
          id="profile-display-name"
          className="form-control"
          type="text"
          value={shown}
          onChange={e => { setDraft(e.target.value); setError(null) }}
          placeholder={loading ? 'Loading…' : 'Your name, as colleagues know it'}
          disabled={loading || saving}
          autoComplete="name"
          aria-invalid={problem ? 'true' : undefined}
          aria-describedby="profile-display-name-detail"
        />
        <div id="profile-display-name-detail" className="setting-bounds profile-detail">
          {`Up to ${DISPLAY_NAME_MAX} characters.`}
        </div>
      </>)}
      actions={(<>
        <SaveDiscard dirty={dirty} disabled={saving} saveBlocked={problem}
          onSave={save}
          onDiscard={() => { setDraft(null); setError(null) }} />
        {(problem || error) && <div className="setting-error" role="status">{problem || error}</div>}
      </>)}
    />
  )
}

/** The four columns, with their header row even for a tab of one row. */
function ProfileTable({ children }) {
  return (
    <div className="table-wrap settings-wrap">
      <table className="settings-table">
        <thead>
          <tr>
            <th scope="col" className="setting-col-name">Setting</th>
            <th scope="col">Description</th>
            <th scope="col" className="setting-col-value">Value</th>
            <th scope="col" className="setting-col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

/**
 * The signed-in person's own page: who they are signed in as, the token and key that call the API as
 * them, and how the dashboard looks to them.
 * Reached from the account menu at the foot of the sidebar, not from the page list. Appearance is
 * the person's `user_settings` row (useUserSettings.js), so it follows them to any browser.
 *
 * `singleKeyShortcuts` is whether `?`, `/`, `[` and `]` act (shortcuts.js), on unless turned off.
 * `settingsSource` is that hook's `source`; 'browser' means the row could not be read or written.
 * `passwordBlocked` is why Change Password is unavailable (a machine identity), or null.
 * `userRole` is undefined while it is still being read, and null for an account with no role.
 * `displayName` is the person's own (undefined while read, null for none); `onSaveDisplayName`
 * saves it and rejects with the database's sentence.
 * The tab is the path: `/profile/appearance`.
 */
export function ProfileTab({
  email, userRole, passwordBlocked = null, onChangePassword, displayName, onSaveDisplayName,
  theme, onChangeTheme, sidebarMode, onChangeSidebarMode,
  singleKeyShortcuts = true, onChangeSingleKeyShortcuts, settingsSource = 'account',
}) {
  const [section, setSection, sectionHref] = useUrlTab('profile', PROFILE_SECTIONS.map(s => s.id), PROFILE_SECTIONS[0].id)

  // Appearance holds a choice until Save, as Settings does; null means the row shows what is saved.
  const [themeDraft, setThemeDraft] = useState(null)
  const [modeDraft, setModeDraft] = useState(null)
  const shownTheme = themeDraft ?? theme
  const mode = SIDEBAR_MODES.find(m => m.id === (modeDraft ?? sidebarMode)) || SIDEBAR_MODES[0]
  const themeDirty = themeDraft !== null && themeDraft !== theme
  const modeDirty = modeDraft !== null && modeDraft !== sidebarMode
  const [shortcutsDraft, setShortcutsDraft] = useState(null)
  const shownShortcuts = shortcutsDraft ?? singleKeyShortcuts
  const shortcutsDirty = shortcutsDraft !== null && shortcutsDraft !== singleKeyShortcuts

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          <CardHeading
            icon={<IconUser size={15} />}
            title="Profile"
            description="Your account, and how the dashboard looks to you."
            note="Applies to you, on any browser."
          />

          <TabStrip
            ariaLabel="Profile"
            value={section}
            onChange={setSection}
            hrefFor={sectionHref}
            tabs={PROFILE_SECTIONS}
          />

          {section === 'account' && (
            <ProfileTable>
              <ProfileRow
                id="email"
                label="Email address"
                description="The address you sign in with."
                value={email || 'None: this identity signs in with a token'}
              />
              <DisplayNameRow displayName={displayName} onSave={onSaveDisplayName} isPerson={!!email} />
              <ProfileRow
                id="role"
                label="Role"
                description="What you may see and change across the site. A page your role cannot use is left out of the sidebar."
                value={userRole === undefined ? 'Loading…' : userRole ? userRole.replace(/_/g, ' ') : 'No role'}
                actions={<span className="setting-fixed">Only an Administrator can change this</span>}
              />
              <ProfileRow
                id="password"
                label="Password"
                description={`Give your current password, then the new one twice. It needs at least ${MIN_PASSWORD_LENGTH} characters. Your other sessions are signed out.`}
                value={passwordBlocked ? 'None' : 'Never shown'}
                actions={(
                  <div className="setting-actions">
                    <Tooltip text={passwordBlocked || null}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={onChangePassword}
                        disabled={!!passwordBlocked}
                      >
                        <IconLock size={13} /> Change Password
                      </button>
                    </Tooltip>
                  </div>
                )}
              />
              <AccessTokenRow />
              <ProfileRow
                id="publishable-key"
                label="Publishable key"
                description={<>
                  Swagger UI&apos;s Authorize asks for it as <span className="mono">apiKeyAuth</span>, beside
                  your token. It is public by design: every browser that opens the dashboard is given it.
                </>}
                value={SUPABASE_GATEWAY_KEY}
                actions={<CopyAction label="Copy Key" read={async () => SUPABASE_GATEWAY_KEY} />}
              />
            </ProfileTable>
          )}

          {section === 'appearance' && (<>
            {/* Said only when it is true: a quiet page means the row was read and each change is
                saved to it. */}
            {settingsSource === 'browser' && (
              <div className="card-body profile-source">
                <div className="callout callout-warning" role="status">
                  <IconAlertTriangle size={14} className="callout-icon" />
                  <div>
                    Your choices could not be read from your account, so this browser&apos;s are shown.
                    A change you make now applies in this browser only.
                  </div>
                </div>
              </div>
            )}
            <ProfileTable>
              <ProfileRow
                id="theme"
                label="Theme"
                description="Dark or light colours. The Theme switch in the account menu changes the same setting."
                value={(
                  <select
                    id="profile-theme"
                    className="form-control"
                    value={shownTheme}
                    onChange={e => setThemeDraft(e.target.value)}
                  >
                    {THEME_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                )}
                actions={<SaveDiscard dirty={themeDirty}
                  onSave={() => { onChangeTheme?.(themeDraft); setThemeDraft(null) }}
                  onDiscard={() => setThemeDraft(null)} />}
              />
              <ProfileRow
                id="sidebar"
                label="Sidebar layout"
                description="How the sidebar shows the page names. The Sidebar layout switch in the account menu changes the same setting."
                value={(<>
                  <select
                    id="profile-sidebar"
                    className="form-control"
                    value={mode.id}
                    onChange={e => setModeDraft(e.target.value)}
                    aria-describedby="profile-sidebar-detail"
                  >
                    {SIDEBAR_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                  <div id="profile-sidebar-detail" className="setting-bounds profile-detail">{mode.description}</div>
                </>)}
                actions={<SaveDiscard dirty={modeDirty}
                  onSave={() => { onChangeSidebarMode?.(modeDraft); setModeDraft(null) }}
                  onDiscard={() => setModeDraft(null)} />}
              />
              <ProfileRow
                id="shortcuts"
                label="Single-key shortcuts"
                description={(<>
                  Keys that act on one press: <kbd className="shortcut-key">?</kbd> lists the shortcuts,{' '}
                  <kbd className="shortcut-key">/</kbd> goes to the page&apos;s search box, and{' '}
                  <kbd className="shortcut-key">[</kbd> and <kbd className="shortcut-key">]</kbd> change tab.
                  Speech input can type them by mistake, so they can be turned off. Ctrl K and the arrow keys stay.
                </>)}
                value={(
                  <div className="profile-switch">
                    {/* Named by the Setting cell's label; the word beside it is for the eye. */}
                    <input
                      id="profile-shortcuts"
                      type="checkbox"
                      role="switch"
                      checked={shownShortcuts}
                      onChange={e => setShortcutsDraft(e.target.checked)}
                    />
                    <span aria-hidden="true">{shownShortcuts ? 'On' : 'Off'}</span>
                  </div>
                )}
                actions={<SaveDiscard dirty={shortcutsDirty}
                  onSave={() => { onChangeSingleKeyShortcuts?.(shortcutsDraft); setShortcutsDraft(null) }}
                  onDiscard={() => setShortcutsDraft(null)} />}
              />
            </ProfileTable>
          </>)}
        </div>
      </div>
    </div>
  )
}

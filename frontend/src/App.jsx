import React, { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { supabase } from './lib/supabaseClient'
import { usePermissions } from './hooks/usePermissions'
import { useAppRouting } from './hooks/useAppRouting'
import { navigate, useUrl } from './hooks/useUrlState'
import {
  deviceUrl, gatewayUrl, cellUrl, areaUrl, schemaUrl, devicesForSchemaUrl, siteMapAreaUrl, trailUrl,
  approvalsForUrl, proposalSubjectUrl, settingUrl, unmappedMetricsUrl, tabUrl,
} from './routes'
import { useTheme } from './hooks/useTheme'
import { useToast, clearStoredHistory } from './hooks/useToast'
import { useApiActivity } from './hooks/useApiActivity'
import { useConnectionStatus } from './hooks/useConnectionStatus'
import { CONNECTION_OK } from './lib/connectionState'
import { useQuarantineAlerts } from './hooks/useQuarantineAlerts'
import { askAuthServer, clearInvalidSession } from './utils/sessionError'
import { useSessionRecheck } from './hooks/useSessionRecheck'
import { signOutOfForge, signOutOfStudio } from './utils/studioSignOut'
import { TABS, pageTitleOf, tabIsVisible } from './navigation'
import { PERMISSION_UUIDS } from './constants'
import { AuthShell } from './components/auth/AuthShell'
import { HoldToReveal } from './components/common/HoldToReveal'
import { ResetPasswordScreen } from './pages/ResetPassword'
import { describeResetError } from './utils/authErrors'
import { useClickOutside } from './hooks/useClickOutside'
import { useEscapeKey } from './hooks/useEscapeKey'
import { useUserSettings } from './hooks/useUserSettings'
import { useOwnDisplayName } from './hooks/useDisplayNames'
import { useDocumentTitle } from './hooks/useDocumentTitle'
import { useAlertFavicon } from './hooks/useAlertFavicon'
import { Sidebar } from './components/common/Sidebar'
import { GlobalSearch } from './components/common/GlobalSearch'
import { AberMark } from './components/common/AberMark'
import { ConnectionStrip } from './components/common/ConnectionStrip'
import { focusPageSearch } from './components/common/SearchInput'
import { SingleKeyShortcutsContext, singleKeyShortcutAllowed, stepPageTab } from './shortcuts'

/* There is no sign-up form. Registration is disabled server-side by GOTRUE_DISABLE_SIGNUP, so
   accounts arrive by invitation, admin provisioning or an upstream identity provider; a client-side
   flag is not an access control. */

// Must match GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH on supabase-auth (the chart's auth.yaml). GoTrue appends it
// to GOTRUE_SITE_URL when redirecting an OAuth client's user here to grant consent.
const OAUTH_CONSENT_PATH = '/oauth/consent'
// Where a password-reset email sends the browser. Must be allowed by GOTRUE_URI_ALLOW_LIST.
const RESET_PASSWORD_PATH = '/reset-password'

import {
  IconKeyboard,
  IconHelp,
  IconSun,
  IconMoon,
  IconUser,
  IconBug,
  IconTag,
  IconRefreshCw,
  IconAlertCircle,
  IconDownload,
  IconLogOut,
  IconMousePointer,
  IconPanelLeft,
  IconPanelLeftClose
} from './components/common/Icons'
import { SIDEBAR_MODES } from './hooks/useSidebarMode'

import { APP_VERSION, VERSION_IS_KNOWN, versionTitle } from './version'
import {
  RELEASE_STATES, releaseDrift, releaseDriftLabel, releaseDriftTitle, releaseVersion, availableRelease,
} from './utils/releaseVersion'
import { api } from './api'

import { ToastStack } from './components/common/Toast'
import { AlertPill } from './components/common/AlertPill'
import { NotificationHistory } from './components/common/NotificationHistory'
import { SegmentedControl } from './components/common/SegmentedControl'
import { Tooltip } from './components/common/Tooltip'
import { HelpPanel } from './components/common/HelpPanel'
import { HelpDrawerContext } from './components/common/ContextPanel'
import { useHelpExpanded } from './hooks/useHelpExpanded'
import { usePlatformAlerts } from './hooks/usePlatformAlerts'
import { useNavSignals } from './hooks/useNavSignals'
import { BugReportModal } from './components/modals/BugReportModal'
import { ShortcutsModal } from './components/modals/ShortcutsModal'
import { ChangePasswordModal } from './components/modals/ChangePasswordModal'

// Lazy-load Tab components
const SiteMapTab       = lazy(() => import('./components/tabs/SiteMapTab').then(m => ({ default: m.SiteMapTab })))
const AreasTab         = lazy(() => import('./components/tabs/AreasTab').then(m => ({ default: m.AreasTab })))
const CellsTab         = lazy(() => import('./components/tabs/CellsTab').then(m => ({ default: m.CellsTab })))
const GatewaysTab      = lazy(() => import('./components/tabs/GatewaysTab').then(m => ({ default: m.GatewaysTab })))
const DevicesTab       = lazy(() => import('./components/tabs/DevicesTab').then(m => ({ default: m.DevicesTab })))
const AuditTrailTab = lazy(() => import('./components/tabs/AuditTrailTab').then(m => ({ default: m.AuditTrailTab })))
// Reached only via GoTrue's OAuth redirect, so it is never in the main bundle's critical path.
const OAuthConsent     = lazy(() => import('./pages/OAuthConsent').then(m => ({ default: m.OAuthConsent })))
const SchemasTab       = lazy(() => import('./components/tabs/SchemasTab').then(m => ({ default: m.SchemasTab })))
const MetricsTab       = lazy(() => import('./components/tabs/MetricsTab').then(m => ({ default: m.MetricsTab })))
const VocabularyTab    = lazy(() => import('./components/tabs/VocabularyTab').then(m => ({ default: m.VocabularyTab })))
const DirectoryTab     = lazy(() => import('./components/tabs/DirectoryTab').then(m => ({ default: m.DirectoryTab })))
const ArchivesTab      = lazy(() => import('./components/tabs/ArchivesTab').then(m => ({ default: m.ArchivesTab })))
const CaptureTab       = lazy(() => import('./components/tabs/CaptureTab').then(m => ({ default: m.CaptureTab })))
const ColdStorageTab   = lazy(() => import('./components/tabs/ColdStorageTab').then(m => ({ default: m.ColdStorageTab })))
const SettingsTab      = lazy(() => import('./components/tabs/SettingsTab').then(m => ({ default: m.SettingsTab })))
const AccessControlTab = lazy(() => import('./components/tabs/AccessControlTab').then(m => ({ default: m.AccessControlTab })))
const BackupsTab       = lazy(() => import('./components/tabs/BackupsTab').then(m => ({ default: m.BackupsTab })))
const ApprovalsTab     = lazy(() => import('./components/tabs/ApprovalsTab').then(m => ({ default: m.ApprovalsTab })))
const ProfileTab       = lazy(() => import('./components/tabs/ProfileTab').then(m => ({ default: m.ProfileTab })))

function AuthScreen({ onLoginSuccess, notice }) {
  // Its own theme handle: this renders instead of Dashboard, never beside it.
  const { theme, toggleTheme } = useTheme()
  /* Empty by design: authScreenCredentials.test.jsx asserts both fields render empty, and
     check-docs-drift.mjs refuses the seeded password anywhere under frontend/src. */
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [authError, setAuthError] = useState(null)
  const [loading, setLoading] = useState(false)
  // 'signin' or 'forgot'. `resetSent` holds the address a reset link was requested for.
  const [mode, setMode] = useState('signin')
  const [resetSent, setResetSent] = useState(null)
  const passwordRef = useRef(null)
  useDocumentTitle(mode === 'forgot' ? 'Reset password' : 'Sign in')

  const handleAuth = async (e) => {
    e.preventDefault()
    setAuthError(null)
    setLoading(true)

    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
      if (data.session) onLoginSuccess(data.session)
    } catch (err) {
      setAuthError(err.message || 'Authentication failed')
      // A failed attempt clears the password and puts the cursor back on it.
      setPassword('')
      setRevealed(false)
      passwordRef.current?.focus()
    } finally {
      setLoading(false)
    }
  }

  const handleForgot = async (e) => {
    e.preventDefault()
    setAuthError(null)
    setLoading(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}${RESET_PASSWORD_PATH}`
      })
      if (error) throw error
      setResetSent(email)
    } catch (err) {
      setAuthError(describeResetError(err))
    } finally {
      setLoading(false)
    }
  }

  const switchMode = (next) => {
    setMode(next)
    setAuthError(null)
    setResetSent(null)
    setPassword('')
    setRevealed(false)
  }

  // Colours come from the theme variables in App.css. No fallback literals: a mistyped variable
  // must render obviously wrong rather than pass in one theme and fail in the other.
  return (
    <AuthShell
      theme={theme}
      onToggleTheme={toggleTheme}
      title={mode === 'forgot' ? 'Reset your password' : 'Sign in to Aber'}
      subtitle={mode === 'forgot'
        ? 'Enter your email address and a link to choose a new password will be sent to it'
        : 'Sign in with your platform account'}
    >
      {notice && !authError && (
        <div role="status" style={{ background: 'var(--warning-tint)', border: '1px solid var(--warning)', color: 'var(--warning-text)', padding: '10px 14px', borderRadius: '8px', fontSize: '13px', marginBottom: '18px' }}>
          {notice}
        </div>
      )}

      {authError && (
        <div role="alert" style={{ background: 'var(--danger-tint)', border: '1px solid var(--danger)', color: 'var(--danger-text)', padding: '10px 14px', borderRadius: '8px', fontSize: '13px', marginBottom: '18px' }}>
          {authError}
        </div>
      )}

      {mode === 'signin' ? (
        <form onSubmit={handleAuth}>
          <div className="form-group" style={{ marginBottom: '16px' }}>
            <label className="form-label" htmlFor="auth-email" style={{ marginBottom: '6px' }}>Email Address</label>
            {/* autoComplete is what replaced the prefill: a password manager fills these per user,
                per browser, and never from the bundle. */}
            <input
              id="auth-email"
              type="email"
              className="form-control"
              style={{ borderRadius: '8px' }}
              value={email}
              onChange={e => { setEmail(e.target.value); setAuthError(null) }}
              autoComplete="username"
              autoFocus
              required
            />
          </div>

          <div className="form-group" style={{ marginBottom: '24px' }}>
            <label className="form-label" htmlFor="auth-password" style={{ marginBottom: '6px' }}>Password</label>
            <div className="password-field">
              <input
                ref={passwordRef}
                id="auth-password"
                type={revealed ? 'text' : 'password'}
                className="form-control"
                style={{ borderRadius: '8px' }}
                value={password}
                onChange={e => { setPassword(e.target.value); setAuthError(null) }}
                autoComplete="current-password"
                required
              />
              <HoldToReveal revealed={revealed} onChange={setRevealed} />
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
            style={{ width: '100%', padding: '12px', borderRadius: '8px', fontWeight: 600, fontSize: '14px', border: 'none', cursor: 'pointer' }}
          >
            {loading ? 'Authenticating...' : 'Sign In'}
          </button>
        </form>
      ) : resetSent ? (
        // The same sentence whether or not the address exists, so the form cannot be used to
        // discover which addresses hold accounts.
        <p role="status" style={{ fontSize: '13px', color: 'var(--text-primary)', margin: 0, lineHeight: 1.5 }}>
          If an account exists for <strong>{resetSent}</strong>, a link to choose a new password is on
          its way. It expires after an hour.
        </p>
      ) : (
        <form onSubmit={handleForgot}>
          <div className="form-group" style={{ marginBottom: '24px' }}>
            <label className="form-label" htmlFor="auth-email" style={{ marginBottom: '6px' }}>Email Address</label>
            <input
              id="auth-email"
              type="email"
              className="form-control"
              style={{ borderRadius: '8px' }}
              value={email}
              onChange={e => { setEmail(e.target.value); setAuthError(null) }}
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
            style={{ width: '100%', padding: '12px', borderRadius: '8px', fontWeight: 600, fontSize: '14px', border: 'none', cursor: 'pointer' }}
          >
            {loading ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}

      <p style={{ marginTop: '18px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.7 }}>
        {mode === 'signin' ? (
          <>
            <button type="button" className="auth-link" onClick={() => switchMode('forgot')}>Forgot your password?</button>
            <br />
            Accounts are provisioned by an administrator. Contact your platform owner for access.
          </>
        ) : (
          <button type="button" className="auth-link" onClick={() => switchMode('signin')}>Back to sign in</button>
        )}
      </p>
    </AuthShell>
  )
}

/** The account menu's theme switch, one segment per theme useTheme offers. */
const THEME_SEGMENTS = [
  { id: 'light', label: 'Light', icon: <IconSun size={14} /> },
  { id: 'dark', label: 'Dark', icon: <IconMoon size={14} /> }
]

/**
 * The account menu's Sidebar layout switch, one segment per mode useSidebarMode offers, in its
 * order. The segment's word is short so three fit the menu's width; its tooltip is the mode's
 * description.
 */
const SIDEBAR_SEGMENT_LOOK = {
  hover: { label: 'Hover', icon: <IconMousePointer size={14} /> },
  expanded: { label: 'Expanded', icon: <IconPanelLeft size={14} /> },
  collapsed: { label: 'Collapsed', icon: <IconPanelLeftClose size={14} /> },
}
const SIDEBAR_SEGMENTS = SIDEBAR_MODES.map(m => ({ id: m.id, description: m.description, ...SIDEBAR_SEGMENT_LOOK[m.id] }))

/**
 * The account control at the foot of the rail: the avatar, with the person's display name beside it
 * whenever the rail shows labels, or their address when they have no name. Its menu's head states
 * the name, the address, the role and the version; the Light/Dark theme
 * switch and the Sidebar layout switch each have a section of their own under it; then come
 * Profile, Report Bug and Sign Out. Click, not hover: a hover menu holding Sign Out puts an
 * irreversible action one stray movement away. The menu opens beside the rail (App.css).
 */
function UserMenu({
  persona, displayName, userRole, onSignOut, theme, onChangeTheme, sidebarMode, onChangeSidebarMode, onReportBug, onOpenProfile,
  profileOpen = false,
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useClickOutside(() => setOpen(false), open)
  useEscapeKey(() => setOpen(false), open)
  const layout = SIDEBAR_MODES.find(m => m.id === sidebarMode) || SIDEBAR_MODES[0]

  /* Read from the injected global, which `config.js` set at page load. Comparing it with the baked
     bundle version is how a page cached from before an upgrade, or a pinned frontend.image.tag,
     becomes visible -- utils/releaseVersion.js has both cases. */
  const release = releaseVersion()
  const drift = releaseDrift(APP_VERSION, release)
  const driftLabel = releaseDriftLabel(drift, release)

  /* The opt-in daily release check's last answer, read from the database each time the menu opens.
     No row, a failed check or an unreadable one all show nothing. */
  const [releaseCheck, setReleaseCheck] = useState(null)
  useEffect(() => {
    if (!open) return undefined
    let current = true
    api.get('/api/v1/release-check')
      .then(row => { if (current) setReleaseCheck(row) })
      .catch(() => { if (current) setReleaseCheck(null) })
    return () => { current = false }
  }, [open])
  const update = availableRelease(releaseCheck, release)

  // The name with the address beside it, in the hover and the accessible name; the address alone
  // when there is no name.
  const signedInAs = displayName ? `${displayName} (${persona})` : persona

  return (
    <div className="user-menu" ref={wrapRef}>
      {/* The name or address is a rail label, transparent while the rail is collapsed, so the
          accessible name is stated rather than read from it: it leads with the person and the role. */}
      <Tooltip text={`Signed in as ${signedInAs} (${userRole}) — open account menu`}>
        <button
          type="button"
          className={`user-menu-button${open ? ' user-menu-button-open' : ''}${profileOpen ? ' active' : ''}`}
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`Signed in as ${signedInAs} (${userRole}) — open account menu`}
        >
          <span className="user-avatar" aria-hidden="true"><IconUser size={14} /></span>
          <span className="sidebar-item-label user-menu-email">{displayName ? <bdi>{displayName}</bdi> : persona}</span>
        </button>
      </Tooltip>

      {open && (
        <div className="user-popover" role="menu">
          <div className="user-popover-head">
            {displayName && <div className="user-popover-email"><bdi>{displayName}</bdi></div>}
            <div className={displayName ? 'user-popover-address' : 'user-popover-email'}>{persona}</div>
            <div className="user-popover-role">{userRole}</div>
            {/* The version sits in the head with the other facts about the session, not among the
                actions. Shown to every user so whoever hits a fault can name the build. */}
            <Tooltip text={versionTitle()}>
              <div className={`user-popover-version${VERSION_IS_KNOWN ? '' : ' user-popover-version-unknown'}`}>
                <IconTag size={11} aria-hidden="true" />
                {/* Selectable, because the next thing anybody does with this string is paste it into
                    a bug report -- which is the same reason the Report Bug button is two rows down. */}
                <span className="mono">{APP_VERSION}</span>
              </div>
            </Tooltip>
            {/* Only when the bundle and the release disagree. `unknown` and `in-step` both render
                nothing: a build that cannot name itself is not evidence of drift. */}
            {driftLabel && (
              <Tooltip text={releaseDriftTitle(drift, release)}>
                <div className="user-popover-drift">
                  {drift === RELEASE_STATES.BEHIND
                    ? <IconRefreshCw size={11} aria-hidden="true" />
                    : <IconAlertCircle size={11} aria-hidden="true" />}
                  <span>{driftLabel}</span>
                </div>
              </Tooltip>
            )}
            {/* Only when the daily release check found a newer release; never "up to date". */}
            {update && (
              <Tooltip text="Its release notes on GitHub say how to upgrade.">
                <a className="user-popover-update" href={update.url} target="_blank" rel="noreferrer">
                  <IconDownload size={11} aria-hidden="true" />
                  <span>Aber {update.version} is available</span>
                </a>
              </Tooltip>
            )}
          </div>

          {/* The themes as a switch in a section of its own, the current one checked: the same
              setting as Profile > Appearance. The menu stays open on it, since its result is
              visible behind the menu, and closes on the actions below. */}
          <div className="user-popover-theme">
            <SegmentedControl menu label="Theme" value={theme} onChange={onChangeTheme} options={THEME_SEGMENTS} />
          </div>

          {/* The rail's three behaviours, the same setting as Profile > Appearance, under the theme
              and staying open on a change for the same reason. Each segment's tooltip says what
              its layout does. */}
          <div className="user-popover-sidebar">
            <SegmentedControl
              menu
              label="Sidebar layout"
              value={layout.id}
              onChange={onChangeSidebarMode}
              options={SIDEBAR_SEGMENTS}
            />
          </div>

          {/* The first action: the whole of the person's own page, two clicks from anywhere. */}
          <Tooltip text="Your account, password, theme and sidebar layout">
            <button
              className="user-popover-action"
              role="menuitem"
              onClick={() => { setOpen(false); onOpenProfile() }}
            >
              <IconUser size={14} /> <span>Profile</span>
            </button>
          </Tooltip>

          <button
            className="user-popover-action"
            role="menuitem"
            onClick={() => { setOpen(false); onReportBug() }}
          >
            <IconBug size={14} /> <span>Report Bug</span>
          </button>

          {/* Last, behind a separator, and the only destructive item. */}
          <button
            className="user-popover-action user-popover-action-danger"
            role="menuitem"
            onClick={() => { setOpen(false); onSignOut() }}
          >
            <IconLogOut size={14} /> <span>Sign Out</span>
          </button>
        </div>
      )}
    </div>
  )
}

function Dashboard({ session, onSignOut, onSignInAgain }) {
  // Set by clicking an entry on the Vocabulary page; consumed by MetricsTab, which resolves it
  // against the vocabularies it already holds and opens its Add Metric dialog. State, not the
  // address: it is an act to perform once, not a view to come back to.
  const [pendingVocabularyEntry, setPendingVocabularyEntry] = useState(null)
  const [showBugReport, setShowBugReport] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showChangePassword, setShowChangePassword] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const closeHelp = useCallback(() => setShowHelp(false), [])
  const openHelp = useCallback(() => setShowHelp(true), [])
  const { expanded: helpExpanded, setExpanded: setHelpExpanded } = useHelpExpanded()
  const helpDrawer = useMemo(() => ({ close: closeHelp, expanded: helpExpanded }), [closeHelp, helpExpanded])

  const { tab, setTab, handleNavClick } = useAppRouting()

  /**
   * The cross-page drill-downs, defined once. Each goes to an address (routes.js), and the page at
   * the other end reads its filters and drawer from it, so the destination is linkable and survives
   * a reload. A page that renders the drill-down as a link uses the same address for its href.
   *
   * `purged` is a tombstone's hand-over: the entity is gone from the live tables, so the Audit
   * Trail shows deleted entities rather than hiding every row of it.
   */
  const viewTrailFor = (id, type, purged = false) => navigate(trailUrl(id, type, purged))
  const showDevice  = (id) => navigate(deviceUrl(id))
  const showGateway = (id) => navigate(gatewayUrl(id))
  const showCell    = (id) => navigate(cellUrl(id))
  const showArea    = (id) => navigate(areaUrl(id))
  /** The Site Map on one area: a plan preview on the Areas or Cells page. */
  const showOnSiteMap = (id) => navigate(siteMapAreaUrl(id))
  /** Open ONE schema's drawer on the Schemas page -- a device drawer's Schema chip. */
  const showSchema  = (uuid) => navigate(schemaUrl(uuid))
  /* A setting is reached by its key, not a UUID: the key is what the page, the code and every
     migration call it, and it is what a link to one should carry. */
  const showSetting = (key) => navigate(settingUrl(key))
  /** One tab of a page: a search-bar card, or the rail's quarantine signal. */
  const showSection = (tabId, section) => navigate(tabUrl(tabId, section))
  /** The opposite direction: every device provisioned with a schema. Note the `schema` key. */
  const showDevicesForSchema = (uuid) => navigate(devicesForSchemaUrl(uuid))

  /** What is already waiting on this asset, with the queue filtered to it. */
  const showApprovalsFor = (device) => navigate(approvalsForUrl(device.asset_id))

  /**
   * Opens the asset a proposal is about on the page that owns its form; that page's Propose a
   * Change dialog seeds itself from the proposal it finds. There is no separate edit-proposal
   * dialog.
   */
  const openProposalSubject = (proposal) => navigate(proposalSubjectUrl(proposal))
  // One source for both: the person's user_settings row, cached in this browser. The account menu's
  // two switches and the Profile page all write through it.
  const {
    theme, setTheme, sidebarMode, setSidebarMode, singleKeyShortcuts, setSingleKeyShortcuts, source: settingsSource,
  } = useUserSettings(session?.user?.id)
  const { toasts, showToast, expireToast, dismissToast, history, markRead, clearHistory } = useToast()

  const { userRole, hasPermission, loadingPerms } = usePermissions(session)

  /* Leave a tab this user can no longer see: the route outlives a session, so an Operator can sign
     in on `settings` and get a blank page. Waits for loadingPerms because userRole is null while
     the fetch is in flight, and acting early would bounce an Administrator off Settings on every
     refresh. The Site Map has no gate. */
  useEffect(() => {
    if (loadingPerms) return
    const current = TABS.find(t => t.id === tab)
    // Replaced rather than pushed, so Back does not return to the page that sent it here.
    if (current && !tabIsVisible(current, hasPermission, userRole)) setTab('site-map', {}, { replace: true })
  }, [tab, loadingPerms, userRole, hasPermission, setTab])

  /* `?` opens the shortcuts list, `/` focuses the open page's search box, and `[` and `]` move to
     the open page's previous and next tab. singleKeyShortcutAllowed (shortcuts.js) says when one
     may act: not in a field, not with Ctrl, Cmd or Alt (AltGr passes), not behind a dialog, and not
     while the person has turned single-key shortcuts off. A key with nothing to do (no box, no tab
     bar, the last tab) is left to the browser. */
  useEffect(() => {
    const onKey = (e) => {
      if (!singleKeyShortcutAllowed(e, singleKeyShortcuts)) return
      if (e.key === '?') {
        e.preventDefault()
        setShowShortcuts(true)
      } else if (e.key === '/') {
        // Kept from the field it has just focused, which would otherwise type it.
        if (focusPageSearch()) e.preventDefault()
      } else if (stepPageTab(e.key === '[' ? -1 : 1)) {
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [singleKeyShortcuts])

  useQuarantineAlerts(showToast)

  // Grafana's firing alerts, via platform_alerts. Owned by App rather than a tab so an alert is
  // visible whichever page is open. Each alert's toast links to its rule in Grafana.
  const firingAlerts = usePlatformAlerts(showToast)

  // Whether the page is still refreshing, from every poll and Realtime channel. Read by the strip
  // under the bar and the tab title.
  const connection = useConnectionStatus()

  // The page's rail label with its tab's ("Devices › Quarantine"), so two history entries for one
  // page differ, and the pill's count, so the tab and the bar never disagree. The icon's red dot
  // follows the same count, for a pinned tab that shows no title.
  const url = useUrl()
  useDocumentTitle(pageTitleOf(tab, url), firingAlerts.length, connection.status !== CONNECTION_OK)
  useAlertFavicon(firingAlerts.length)

  // What the rail flags, with a number, to a viewer who can act on it: quarantine, offline gateways,
  // unfiled cells and waiting proposals. Owned here for the same reason the alerts are.
  const navSignals = useNavSignals({ hasPermission, userRole, userId: session?.user?.id })

  // Fed by the counter every call through `api` increments, so it covers a save on a modal and a
  // tab's reconciliation poll alike without either having to report anything.
  const apiBusy = useApiActivity()

  // Data refresh is owned by the tabs through useRealtimeTable, which subscribes only to the tables
  // the visible tab renders. Quarantine arrivals are handled by useQuarantineAlerts above.

  const persona = session?.user?.email || 'Administrator'
  // The person's own display name (0203), shown in the account menu and set on Profile > Account.
  const { displayName, saveDisplayName } = useOwnDisplayName(session?.user?.email ? session.user.id : null)
  // A person signs in with an email address and a password. A machine identity has neither.
  const passwordBlocked = session?.user?.email
    ? null
    : 'Machine identities have no password to change. They use tokens instead.'

  // Drawn at the foot of the rail. `handleNavClick`, so Profile opens on its first tab.
  const accountMenu = (
    <UserMenu
      persona={persona}
      displayName={displayName}
      userRole={userRole}
      onSignOut={onSignOut}
      theme={theme}
      onChangeTheme={setTheme}
      sidebarMode={sidebarMode}
      onChangeSidebarMode={setSidebarMode}
      onReportBug={() => setShowBugReport(true)}
      onOpenProfile={() => handleNavClick('profile')}
      profileOpen={tab === 'profile'}
    />
  )

  // Computed once and used twice: the rail draws it and the search palette indexes it. Filtering
  // in both places would let the search offer a page the rail does not.
  const navTabs = TABS.filter(t => tabIsVisible(t, hasPermission, userRole))
  // The export warning links to Metrics with Unmapped on, only for a reader who has that page.
  const unmappedMetricsTo = navTabs.some(t => t.id === 'metrics') ? unmappedMetricsUrl() : undefined
  // Where each rail entry goes: the bare page, except Devices, which opens the Quarantine tab while
  // the rail flags a waiting device.
  const railHref = (id) => (id === 'devices' && navSignals.devices ? tabUrl('devices', 'quarantine') : tabUrl(id))

  return (
    <div className="app-shell">
      {/* The bar carries the brand, the search box and the session controls; navigation is in the
          rail. */}
      <header className="topbar">
        {/* A button because it navigates home, to the bare path, so no filter a drill-down set
            comes along. */}
        {/* The tooltip names the brand too, because .brand-name truncates: it is the region that
            yields space to the search box and the session controls. */}
        <Tooltip text="Aber, go to the Site Map page">
          <button
            className="topbar-brand"
            onClick={() => handleNavClick('site-map')}
            aria-label="Aber, go to the Site Map page"
          >
            <div className="brand-icon"><AberMark size={28} /></div>
            <div className="brand-text">
              <div className="brand-name">Aber</div>
              <div className="brand-sub">The shopfloor data platform</div>
            </div>
          </button>
        </Tooltip>

        {/* Takes the same `navTabs` the rail does and the same drill-down helpers every other
            surface navigates with, so a pasted device id lands at the address clicking that device
            does. */}
        <GlobalSearch
          tabs={navTabs}
          currentTab={tab}
          onNavigate={handleNavClick}
          onSelectDevice={showDevice}
          onSelectGateway={showGateway}
          onSelectCell={showCell}
          onSelectArea={showArea}
          onSelectSchema={showSchema}
          onSelectSetting={showSetting}
          onSelectSection={showSection}
          /* No type: the search knows the id and not what it belongs to, and the trail's own
             search matches an entity id whatever kind carries it. */
          onSelectTrail={(id) => viewTrailFor(id, '')}
        />

        {/* The right-hand side holds the two controls whose values move, the alert pill and the
            notification bell, plus the two signposts. The account menu is at the rail's foot. */}
        <div className="topbar-right">
          {/* A device alert goes to Devices and a gateway alert to Gateways, chosen by the alert's
              declared scope rather than its id prefix, through the same helpers every other surface
              navigates with. */}
          <AlertPill
            alerts={firingAlerts}
            onSelectDevice={showDevice}
            onSelectGateway={showGateway}
          />

          {/* What the toasts said, beside what is wrong now and separate from it: the pill's count
              is a reason to act, and this list holds resolved and routine messages too. */}
          <NotificationHistory entries={history} onMarkRead={markRead} onClear={clearHistory} />

          {/* A discovery aid rather than a preference, so it stays in the bar, and the way to the
              list while single-key shortcuts are off, when `?` is not named. */}
          <Tooltip text={singleKeyShortcuts ? 'Keyboard shortcuts (?)' : 'Keyboard shortcuts'}>
            <button
              className="topbar-icon-button"
              onClick={() => setShowShortcuts(true)}
              aria-label="Keyboard shortcuts"
              aria-keyshortcuts={singleKeyShortcuts ? '?' : undefined}
            >
              <IconKeyboard size={15} />
            </button>
          </Tooltip>

          {/* The help control is the bar's last. `aria-expanded` because it toggles a drawer that
              stays open, unlike the shortcuts dialog. */}
          <Tooltip text="Help for this page">
            <button
              className={`topbar-icon-button${showHelp ? ' topbar-icon-button-active' : ''}`}
              onClick={() => setShowHelp((v) => !v)}
              aria-label="Help for this page"
              aria-expanded={showHelp}
            >
              <IconHelp size={15} />
            </button>
          </Tooltip>
        </div>

        {/* Rendered only while busy, so there is no inert element to mistake for a stalled bar.
            `role="progressbar"` with no value: the work is indeterminate. */}
        {apiBusy && (
          <div
            className="topbar-progress"
            role="progressbar"
            aria-label="Loading"
          />
        )}
      </header>

      {/* Its own row under the bar, never inside it: the busy line already owns the bar's bottom
          edge. Empty while every refresh is working. */}
      <ConnectionStrip status={connection.status} since={connection.since} onSignInAgain={onSignInAgain} />

      {/* The rail is a permanent gutter. In hover mode its expanded panel paints over the page; in
          expanded mode the row reflows. See Sidebar.jsx. */}
      <div className="app-body">
        {/* Devices' signal is the quarantine queue, so while it shows, the item opens that tab. */}
        <Sidebar tabs={navTabs} currentTab={tab} hrefFor={railHref} mode={sidebarMode} signals={navSignals} account={accountMenu} />

        {/* A page's drawer closes help through this on a narrow screen, or with help expanded
            (ContextPanel.jsx). The help drawer itself sits outside it. */}
        <HelpDrawerContext.Provider value={helpDrawer}>
        {/* What a page's search box reads to say whether `/` reaches it. */}
        <SingleKeyShortcutsContext.Provider value={singleKeyShortcuts}>
        <main className="content">
          <Suspense fallback={<div className="loading-wrap"><div className="spinner" /> Loading view…</div>}>
            {tab === 'site-map'       && <SiteMapTab activeAlerts={firingAlerts} onSelectDevice={showDevice} onSelectGateway={showGateway} onSelectCell={showCell} onSelectArea={showArea} showToast={showToast} onNavigateTab={t => setTab(t)} />}
            {tab === 'areas'          && <AreasTab showToast={showToast} onViewTrail={a => viewTrailFor(a.area_id, 'AREA')} onSelectCell={showCell} onSelectDevice={showDevice} onSelectGateway={showGateway} onShowOnSiteMap={showOnSiteMap} hasPermission={hasPermission} />}
            {tab === 'cells'          && <CellsTab activeAlerts={firingAlerts} showToast={showToast} onViewTrail={c => viewTrailFor(c.cell_id, 'CELL')} onSelectDevice={showDevice} onSelectGateway={showGateway} onSelectArea={showArea} onShowOnSiteMap={showOnSiteMap} hasPermission={hasPermission} />}
            {tab === 'gateways'       && <GatewaysTab userRole={userRole} activeAlerts={firingAlerts} showToast={showToast} onViewTrail={g => viewTrailFor(g.gateway_id, 'GATEWAY')} onSelectCell={showCell} onSelectDevice={showDevice} hasPermission={hasPermission} />}
            {tab === 'devices'        && <DevicesTab showToast={showToast} onSelectGateway={showGateway} onSelectCell={showCell} onSelectArea={showArea} onSelectSchema={showSchema} onViewTrail={a => viewTrailFor(a.asset_id, 'DEVICE')} onViewApprovals={showApprovalsFor} hasPermission={hasPermission} activeAlerts={firingAlerts} unmappedMetricsTo={unmappedMetricsTo} />}
            {/* Re-checked here: `tab` arrives from the URL as well as the nav, so hiding the item
                is not the same as closing the page. */}
            {tab === 'audit-trail' && hasPermission(PERMISSION_UUIDS.AUDIT_TRAIL_READ) && (
              <AuditTrailTab
                userRole={userRole}
                showToast={showToast}
              />
            )}
            {tab === 'schemas'        && <SchemasTab showToast={showToast} hasPermission={hasPermission} onSelectSchema={showDevicesForSchema} onSelectDevice={showDevice} />}
            {tab === 'metrics'        && <MetricsTab showToast={showToast} hasPermission={hasPermission} pendingVocabularyEntry={pendingVocabularyEntry} onConsumeVocabularyEntry={() => setPendingVocabularyEntry(null)} />}
            {tab === 'vocabulary'     && <VocabularyTab hasPermission={hasPermission} onUseEntry={entry => { setPendingVocabularyEntry(entry); setTab('metrics') }} />}
            {tab === 'directory'      && <DirectoryTab showToast={showToast} />}
            {/* `currentUserId` lets the page say "you" and offer Edit and Withdraw on the
                proposer's own rows. The transition guard and RLS re-derive the proposer from
                auth.uid(). */}
            {tab === 'approvals'      && <ApprovalsTab showToast={showToast} userRole={userRole} currentUserId={session?.user?.id}
              onOpenSubject={openProposalSubject}
              /* The proposal's subject, not the proposal: the page names its kind and whether it
                 was deleted, as the Archived Entities page does. */
              onViewTrail={t => viewTrailFor(t.id, t.type, t.purged)} />}
            {/* Re-checked because routing can put `tab` on a value the nav never offered.
                `userRole` is passed on because the page distinguishes read-only Auditor from the
                roles that can record. */}
            {tab === 'capture' && ['Administrator', 'Shopfloor_Manager', 'Auditor'].includes(userRole) &&
              <CaptureTab showToast={showToast} userRole={userRole} onSelectSchema={showSchema} />}
            {tab === 'archives'       && <ArchivesTab showToast={showToast} hasPermission={hasPermission} onViewTrail={t => viewTrailFor(t.id, t.type, t.purged)} unmappedMetricsTo={unmappedMetricsTo} />}
            {/* Re-checked because routing can put `tab` on a value the nav never offered.
                `userRole` lets the page tell "nothing archived" from "not yours to see";
                cold_storage_rows() gates in its body. */}
            {tab === 'cold-storage' && ['Administrator', 'Shopfloor_Manager', 'Auditor'].includes(userRole) &&
              <ColdStorageTab showToast={showToast} userRole={userRole} />}
            {/* The role is re-checked here, not only in the nav: routing can put `tab` on a value
                the nav never offered. Still a courtesy -- RLS is what refuses the write. */}
            {tab === 'access-control' && userRole === 'Administrator' && <AccessControlTab showToast={showToast} userRole={userRole} currentUserId={session?.user?.id} />}
            {tab === 'backups' && userRole === 'Administrator' && <BackupsTab showToast={showToast} />}
            {tab === 'settings' && !loadingPerms && <SettingsTab showToast={showToast} readOnly={userRole !== 'Administrator'} />}
            {/* Every person's own page. Appearance writes through useUserSettings, as the account
                menu's theme and sidebar layout switches do. */}
            {tab === 'profile' && (
              <ProfileTab
                email={session?.user?.email}
                userRole={loadingPerms ? undefined : userRole}
                passwordBlocked={passwordBlocked}
                onChangePassword={() => setShowChangePassword(true)}
                displayName={displayName}
                onSaveDisplayName={saveDisplayName}
                theme={theme}
                onChangeTheme={setTheme}
                sidebarMode={sidebarMode}
                onChangeSidebarMode={setSidebarMode}
                singleKeyShortcuts={singleKeyShortcuts}
                onChangeSingleKeyShortcuts={setSingleKeyShortcuts}
                settingsSource={settingsSource}
                showToast={showToast}
              />
            )}
          </Suspense>
        </main>
        </SingleKeyShortcutsContext.Provider>
        </HelpDrawerContext.Provider>

        {/* Rendered beside the page so it survives tab switches (`tabId` follows `tab`) and is
            available on pages with no drawer of their own. See HelpPanel.jsx. */}
        <HelpPanel open={showHelp} tabId={tab} onClose={closeHelp} onOpen={openHelp} expanded={helpExpanded} onExpandedChange={setHelpExpanded} />
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} onExpire={expireToast} />
      {showBugReport && <BugReportModal onClose={() => setShowBugReport(false)} showToast={showToast} persona={persona} activeTab={tab} />}
      {showShortcuts && <ShortcutsModal singleKeyShortcuts={singleKeyShortcuts} onClose={() => setShowShortcuts(false)} />}
      {showChangePassword && (
        <ChangePasswordModal
          email={session?.user?.email}
          onClose={() => setShowChangePassword(false)}
          showToast={showToast}
        />
      )}
    </div>
  )
}

// How long a reload waits for the auth server before opening on the stored session. Without a bound,
// a connection that never answers holds the spinner until the browser abandons the request.
const AUTH_CHECK_TIMEOUT_MS = 10000

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authNotice, setAuthNotice] = useState(null)
  // True while a password-reset link is being honoured: from the reset URL, or from the
  // PASSWORD_RECOVERY event supabase-js raises after exchanging the link's token for a session.
  const [recovering, setRecovering] = useState(() => window.location.pathname === RESET_PASSWORD_PATH)

  // A session the auth server rejected: a local sign-out, then the sign-in screen with its notice.
  const endRejectedSession = useCallback(async (error) => {
    console.warn('[auth] session rejected by the auth server:', error?.message)
    setAuthNotice(await clearInvalidSession())
    setSession(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    // Only restoreSession ends the first load. supabase-js announces the stored session
    // (INITIAL_SESSION, SIGNED_IN) before the auth server has checked it, and a page rendered on it
    // would read on a token that may be dead.
    let restoring = true
    // The session supabase-js last announced while restoring, for a check that runs out of time.
    let announced

    // Restore and validate the stored session, resolving to the session the page may use.
    // getSession() only reads localStorage, so the stored session may have ended on the server;
    // getUser() asks the auth server.
    const restoreSession = async () => {
      const { data: { session: stored } } = await supabase.auth.getSession()
      if (!stored) return null

      // The page keeps only what supabase-js still holds after the check and never puts `stored`
      // back (see askAuthServer).
      const check = askAuthServer()
      let timer
      const answer = await Promise.race([
        check,
        new Promise(resolve => { timer = setTimeout(resolve, AUTH_CHECK_TIMEOUT_MS, null) }),
      ]).finally(() => clearTimeout(timer))
      if (cancelled) return null

      if (!answer) {
        // Treated as an unreachable server. A refusal that arrives later still ends the session.
        console.warn(`[auth] the auth server did not answer within ${AUTH_CHECK_TIMEOUT_MS / 1000} s; opening on the stored session`)
        check.then(late => { if (late.rejected && !cancelled) endRejectedSession(late.error) }, () => {})
        return announced === undefined ? stored : announced
      }
      if (answer.rejected) {
        await endRejectedSession(answer.error)
        return null
      }
      // No error, or the auth server was unreachable (a network error or a 5xx, through which
      // supabase-js keeps the session): stay signed in rather than sign someone out over a blip.
      if (answer.error) console.warn('[auth] could not validate the stored session:', answer.error.message)
      return answer.current
    }

    restoreSession()
      .catch(err => {
        console.warn('[auth] could not restore the stored session:', err?.message)
        return null
      })
      .then(restored => {
        if (cancelled) return
        restoring = false
        setSession(restored)
        setLoading(false)
      })

    // Listen for Supabase Auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        setRecovering(true)
        setSession(session)
        setLoading(false)
        return
      }
      // Until restoreSession has decided, an event only notes the session supabase-js now holds.
      if (restoring) { announced = session; return }
      if (event === 'INITIAL_SESSION') return
      // Handle SIGNED_OUT events - clear session and show auth screen
      if (event === 'SIGNED_OUT') {
        setSession(null)
        setLoading(false)
        return
      }
      // Handle TOKEN_REFRESHED events - update session silently
      if (event === 'TOKEN_REFRESHED') {
        setSession(session)
        return
      }
      // For other events (SIGNED_IN, USER_UPDATED), update session normally
      setSession(session)
      setLoading(false)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [endRejectedSession])

  /* The notification history is one person's. It goes whenever the tab is left without a session,
     whether by Sign Out, a sign-out from another tab or a rejected stored session, so the next
     person to sign in here starts with an empty list. */
  useEffect(() => {
    if (!loading && !session) clearStoredHistory()
  }, [loading, session])

  // A session that ended while the tab was out of sight ends here too when it is shown again.
  useSessionRecheck(!!session, endRejectedSession)

  // OAuth consent, checked before the loading and auth branches. GoTrue redirects here from
  // /oauth/authorize because it ships no consent UI. The page reads the session itself and must not
  // fall through to AuthScreen, which would lose the authorization_id.
  if (window.location.pathname === OAUTH_CONSENT_PATH) {
    return (
      <Suspense fallback={<div className="loading-wrap"><div className="spinner" /> Loading…</div>}>
        <OAuthConsent />
      </Suspense>
    )
  }

  if (loading) {
    return <div className="loading-wrap"><div className="spinner" /> Connecting to Supabase Auth…</div>
  }

  if (recovering) {
    const finish = () => {
      setRecovering(false)
      window.history.replaceState({}, '', '/site-map')
    }
    if (session) return <ResetPasswordScreen email={session.user?.email} onDone={finish} />
    // The link's token was rejected or already spent: no session arrived with it.
    return (
      <AuthScreen
        notice="That password reset link has expired or was already used. Request a new one below."
        onLoginSuccess={(sess) => { finish(); setSession(sess) }}
      />
    )
  }

  if (!session) {
    return <AuthScreen notice={authNotice} onLoginSuccess={(sess) => { setAuthNotice(null); setSession(sess) }} />
  }

  // Three sessions end here. signOut() ends this browser's dashboard session only (scope 'local');
  // the person's other browsers and services keep theirs. Studio and the forge sit behind sessions
  // the gateway owns, so a beacon clears each cookie alongside it. All start in the same tick so a
  // slow console cannot delay the sign-out, and signOut() is called synchronously on click, which
  // navigationShell.test.jsx asserts.
  return <Dashboard
    session={session}
    onSignOut={() => Promise.all([signOutOfStudio(), signOutOfForge(), supabase.auth.signOut({ scope: 'local' })])}
    /* The rejected-session path above: a local sign-out, then the sign-in screen with its notice.
       setSession too, because signOut() cannot always clear an expired session it fails to refresh. */
    onSignInAgain={async () => { setAuthNotice(await clearInvalidSession()); setSession(null) }}
  />
}

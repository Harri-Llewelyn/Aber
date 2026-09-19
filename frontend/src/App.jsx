import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { supabase } from './lib/supabaseClient'
import { usePermissions } from './hooks/usePermissions'
import { useAppRouting } from './hooks/useAppRouting'
import { useTheme } from './hooks/useTheme'
import { useToast } from './hooks/useToast'
import { useApiActivity } from './hooks/useApiActivity'
import { useQuarantineAlerts } from './hooks/useQuarantineAlerts'
import { clearInvalidSession, isSessionRejected } from './utils/sessionError'
import { signOutOfForge, signOutOfStudio } from './utils/studioSignOut'
import { TABS, tabIsVisible } from './navigation'
import { PERMISSION_UUIDS } from './constants'
import { AuthShell } from './components/auth/AuthShell'
import { HoldToReveal } from './components/common/HoldToReveal'
import { ResetPasswordScreen } from './pages/ResetPassword'
import { describeResetError } from './utils/authErrors'
import { useClickOutside } from './hooks/useClickOutside'
import { useEscapeKey } from './hooks/useEscapeKey'
import { useSidebarMode } from './hooks/useSidebarMode'
import { Sidebar } from './components/common/Sidebar'
import { GlobalSearch } from './components/common/GlobalSearch'

/* There is no sign-up form. Registration is disabled server-side by GOTRUE_DISABLE_SIGNUP, so
   accounts arrive by invitation, admin provisioning or an upstream identity provider; a client-side
   flag is not an access control. */

// Must match GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH on supabase-auth (the chart's auth.yaml). GoTrue appends it
// to GOTRUE_SITE_URL when redirecting an OAuth client's user here to grant consent.
const OAUTH_CONSENT_PATH = '/oauth/consent'
// Where a password-reset email sends the browser. Must be allowed by GOTRUE_URI_ALLOW_LIST.
const RESET_PASSWORD_PATH = '/reset-password'

import {
  IconFactory,
  IconKeyboard,
  IconHelp,
  IconSun,
  IconMoon,
  IconUser,
  IconBug,
  IconTag,
  IconLogOut
} from './components/common/Icons'

import { APP_VERSION, VERSION_IS_KNOWN, versionTitle } from './version'

import { Toast } from './components/common/Toast'
import { AlertPill } from './components/common/AlertPill'
import { HelpPanel } from './components/common/HelpPanel'
import { usePlatformAlerts } from './hooks/usePlatformAlerts'
import { useNavSignals } from './hooks/useNavSignals'
import { BugReportModal } from './components/modals/BugReportModal'
import { ShortcutsModal } from './components/modals/ShortcutsModal'

// Lazy-load Tab components
const SiteMapTab       = lazy(() => import('./components/tabs/SiteMapTab').then(m => ({ default: m.SiteMapTab })))
const AreasTab         = lazy(() => import('./components/tabs/AreasTab').then(m => ({ default: m.AreasTab })))
const CellsTab         = lazy(() => import('./components/tabs/CellsTab').then(m => ({ default: m.CellsTab })))
const GatewaysTab      = lazy(() => import('./components/tabs/GatewaysTab').then(m => ({ default: m.GatewaysTab })))
const DevicesTab       = lazy(() => import('./components/tabs/DevicesTab').then(m => ({ default: m.DevicesTab })))
const DigitalThreadTab = lazy(() => import('./components/tabs/DigitalThreadTab').then(m => ({ default: m.DigitalThreadTab })))
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

/* The page list lives in navigation.jsx and is re-exported here unchanged: the sidebar and the
   search palette read it and cannot import from this file without a cycle, and the tests import
   TABS and tabIsVisible from here. */
export { TABS, tabIsVisible, NAV_GROUPS, groupedNav } from './navigation'

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
      title="ACS-Cymru Supabase Portal"
      subtitle={mode === 'forgot'
        ? 'Enter your email address and a link to choose a new password will be sent to it'
        : 'Sign in with your platform account'}
    >
      {notice && !authError && (
        <div role="status" style={{ background: 'rgba(255,179,0,0.15)', border: '1px solid var(--warning)', color: 'var(--warning-text)', padding: '10px 14px', borderRadius: '8px', fontSize: '13px', marginBottom: '18px' }}>
          {notice}
        </div>
      )}

      {authError && (
        <div role="alert" style={{ background: 'rgba(255,77,109,0.15)', border: '1px solid var(--danger)', color: 'var(--danger-text)', padding: '10px 14px', borderRadius: '8px', fontSize: '13px', marginBottom: '18px' }}>
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

/**
 * The account control: a round icon button whose head states the address, role and version, and
 * whose rows hold the session-level preferences and escape hatches (theme, Report Bug, Sign Out).
 * Click, not hover: a hover menu holding Sign Out puts an irreversible action one stray movement
 * away.
 */
function UserMenu({ persona, userRole, onSignOut, theme, onToggleTheme, onReportBug }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useClickOutside(() => setOpen(false), open)
  useEscapeKey(() => setOpen(false), open)

  const nextTheme = theme === 'dark' ? 'Light' : 'Dark'

  return (
    <div className="user-menu" ref={wrapRef}>
      {/* No visible text, so the accessible name comes from `title`, which leads with the address
          and the role. */}
      <button
        className={`user-avatar${open ? ' user-avatar-open' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`Signed in as ${persona} (${userRole}) — open account menu`}
      >
        <IconUser size={14} />
      </button>

      {open && (
        <div className="user-popover" role="menu">
          <div className="user-popover-head">
            <div className="user-popover-email">{persona}</div>
            <div className="user-popover-role">{userRole}</div>
            {/* The version sits in the head with the other facts about the session, not among the
                actions. Shown to every user so whoever hits a fault can name the build. */}
            <div
              className={`user-popover-version${VERSION_IS_KNOWN ? '' : ' user-popover-version-unknown'}`}
              title={versionTitle()}
            >
              <IconTag size={11} aria-hidden="true" />
              {/* Selectable, because the next thing anybody does with this string is paste it into
                  a bug report -- which is the same reason the Report Bug button is two rows down. */}
              <span className="mono">{APP_VERSION}</span>
            </div>
          </div>

          {/* The label states the current theme; the icon shows the destination. */}
          <button
            className="user-popover-action"
            role="menuitem"
            onClick={onToggleTheme}
            title={`Switch to the ${nextTheme.toLowerCase()} theme`}
          >
            {theme === 'dark' ? <IconSun size={14} /> : <IconMoon size={14} />}
            <span>Theme: <strong>{theme === 'dark' ? 'Dark' : 'Light'}</strong></span>
            <span className="user-popover-hint">{nextTheme}</span>
          </button>

          {/* The menu stays open on the theme toggle, whose result is visible behind it, and closes
              on the other two. */}
          <button
            className="user-popover-action"
            role="menuitem"
            onClick={() => { setOpen(false); onReportBug() }}
            title="Report an application bug"
          >
            <IconBug size={14} /> <span>Report Bug</span>
          </button>

          {/* Last, behind a separator, and the only destructive item. */}
          <button
            className="user-popover-action user-popover-action-danger"
            role="menuitem"
            onClick={() => { setOpen(false); onSignOut() }}
            title="Sign out of the Supabase session"
          >
            <IconLogOut size={14} /> <span>Sign Out</span>
          </button>
        </div>
      )}
    </div>
  )
}

function Dashboard({ session, onSignOut }) {
  /* One-shot, cleared by ApprovalsTab's onClearFocus. Held in state rather than a query parameter
     because it is an intent, not a location, and must not replay on reload. */
  const [proposalFocus, setProposalFocus] = useState(null)
  const [selectedDeviceFilter, setSelectedDeviceFilter] = useState('')
  const [selectedGatewayFilter, setSelectedGatewayFilter] = useState('')
  // Set when a schema's device count is clicked on the Schemas page; consumed by DevicesTab.
  const [selectedSchemaFilter, setSelectedSchemaFilter] = useState('')
  // Separate from the device filter above: set by a device drawer's Schema chip and consumed by
  // SchemasTab, which opens that schema's drawer.
  const [selectedSchemaId, setSelectedSchemaId] = useState('')
  // Set when a cell is opened from the Site Map; consumed by CellsTab.
  const [selectedCellFilter, setSelectedCellFilter] = useState('')
  // Set by a cell drawer's Area chip; consumed by AreasTab, which opens that area's drawer.
  const [selectedAreaFilter, setSelectedAreaFilter] = useState('')
  // Set by the search bar; consumed by SettingsTab, which opens that setting's category on it.
  const [selectedSettingKey, setSelectedSettingKey] = useState('')
  // Set by a "Digital Thread" action on an asset row; consumed by DigitalThreadTab as { id, type }.
  const [selectedThreadEntity, setSelectedThreadEntity] = useState(null)
  // Set by Use on the Vocabulary page; consumed by MetricsTab, which resolves it against the
  // vocabularies it already holds and opens its Add Metric form.
  const [pendingVocabularyEntry, setPendingVocabularyEntry] = useState(null)
  const [showBugReport, setShowBugReport] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  const { tab, setTab, handleNavClick } = useAppRouting(
    setSelectedDeviceFilter, setSelectedGatewayFilter, setSelectedSchemaFilter, setSelectedCellFilter,
    setSelectedThreadEntity, setPendingVocabularyEntry, setSelectedAreaFilter
  )

  /**
   * Drill into one asset's audit trace on the page that owns it, rather than in a dialog. `purged`
   * is a tombstone's handover: the entity is gone from the live tables, so the page shows deleted
   * entities rather than hiding every row of it.
   */
  const viewThreadFor = (id, type, purged = false) => {
    setSelectedThreadEntity({ id, type, purged })
    setTab('digital-thread', { entity: id })
  }

  /**
   * The cross-page hand-overs, defined once. Each sets state and pushes a query parameter: the
   * state reaches a tab that is already mounted, and the query string survives a reload and makes
   * the destination linkable. The target pages read both, URL first.
   */
  const showDevice  = (id) => { setSelectedDeviceFilter(id);  setTab('devices',  { search: id }) }
  const showGateway = (id) => { setSelectedGatewayFilter(id); setTab('gateways', { search: id }) }
  const showCell    = (id) => { setSelectedCellFilter(id);    setTab('cells',    { search: id }) }
  const showArea    = (id) => { setSelectedAreaFilter(id);    setTab('areas',    { search: id }) }
  /** Open ONE schema's drawer on the Schemas page -- a device drawer's Schema chip. */
  const showSchema  = (uuid) => { setSelectedSchemaId(uuid);  setTab('schemas',  { search: uuid }) }
  /* A setting is reached by its key, not a UUID: the key is what the page, the code and every
     migration call it, and it is what a link to one should carry. */
  const showSetting = (key) => { setSelectedSettingKey(key); setTab('settings', { search: key }) }
  /** The opposite direction: every device provisioned with a schema. Note the `schema` key. */
  const showDevicesForSchema = (uuid) => {
    setSelectedSchemaFilter(uuid)
    setTab('devices', { schema: uuid })
  }

  /** What is already waiting on this asset, with the queue filtered to it. */
  const showApprovalsFor = (device) => {
    setProposalFocus({ subject: device.asset_id })
    setTab('approvals')
  }

  /**
   * Opens the asset a proposal is about on the page that owns its form; that page's Propose a
   * Change dialog seeds itself from the proposal it finds. There is no separate edit-proposal
   * dialog.
   */
  const openProposalSubject = (proposal) => {
    // Before the `cell` test, not after: `startsWith` is a prefix match and "areas" shares none of
    // these, but the device fallthrough at the end would take it if it were not named here.
    if (proposal.entity_type.startsWith('area')) return showArea(proposal.entity_id)
    if (proposal.entity_type.startsWith('cell')) return showCell(proposal.entity_id)
    if (proposal.entity_type.startsWith('gateway')) return showGateway(proposal.entity_id)
    return showDevice(proposal.entity_id)
  }
  const { theme, toggleTheme } = useTheme()
  const { toast, showToast, clearToast } = useToast()
  const { mode: sidebarMode, setMode: setSidebarMode } = useSidebarMode()

  const { userRole, hasPermission, loadingPerms } = usePermissions(session)

  /* Leave a tab this user can no longer see: the route outlives a session, so an Operator can sign
     in on `settings` and get a blank page. Waits for loadingPerms because userRole is null while
     the fetch is in flight, and acting early would bounce an Administrator off Settings on every
     refresh. The Site Map has no gate. */
  useEffect(() => {
    if (loadingPerms) return
    const current = TABS.find(t => t.id === tab)
    if (current && !tabIsVisible(current, hasPermission, userRole)) setTab('site-map')
  }, [tab, loadingPerms, userRole, hasPermission, setTab])

  /* `?` opens the shortcuts list. It is a printable character, so the handler stands down for any
     editable target, including contenteditable, and for any keystroke carrying a modifier. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      e.preventDefault()
      setShowShortcuts(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useQuarantineAlerts(showToast)

  // Grafana's firing alerts, via platform_alerts. Owned by App rather than a tab so an alert is
  // visible whichever page is open.
  const firingAlerts = usePlatformAlerts(showToast)

  // What the rail flags in the warning colour: quarantine, offline gateways, unfiled cells. Owned
  // here for the same reason the alerts are.
  const navSignals = useNavSignals()

  // Fed by the counter every call through `api` increments, so it covers a save on a modal and a
  // tab's reconciliation poll alike without either having to report anything.
  const apiBusy = useApiActivity()

  // Data refresh is owned by the tabs through useRealtimeTable, which subscribes only to the tables
  // the visible tab renders. Quarantine arrivals are handled by useQuarantineAlerts below.

  const persona = session?.user?.email || 'Administrator'

  // Computed once and used twice: the rail draws it and the search palette indexes it. Filtering
  // in both places would let the search offer a page the rail does not.
  const navTabs = TABS.filter(t => tabIsVisible(t, hasPermission, userRole))

  return (
    <div className="app-shell">
      {/* The bar carries the brand, the search box and the session controls; navigation is in the
          rail. */}
      <header className="topbar">
        {/* A button because it navigates home. `handleNavClick`, not `setTab`, so the cross-page
            filters a drill-down handed over are cleared. */}
        <button
          className="topbar-brand"
          onClick={() => handleNavClick('site-map')}
          title="ACS Cymru — go to the Site Map page"
          aria-label="ACS Cymru, go to the Site Map page"
        >
          <div className="brand-icon"><IconFactory size={18} /></div>
          <div className="brand-text">
            {/* Titled because .brand-name truncates: it is the region that yields space to the
                search box and the session controls. The short form is hidden from assistive
                technology and `title` carries the full name, so the accessible name never changes
                with the viewport. */}
            <div className="brand-name" title="AMRC Connectivity Stack - Cymru">
              <span className="brand-name-full">AMRC Connectivity Stack - Cymru</span>
              <span className="brand-name-short" aria-hidden="true">ACS Cymru</span>
            </div>
            <div className="brand-sub">Shopfloor to Digital Twin Pipeline</div>
          </div>
        </button>

        {/* Takes the same `navTabs` the rail does and the same hand-over helpers every other
            surface navigates with, so a pasted device id lands where clicking that device lands,
            query parameter and all. */}
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
          /* No type: the search knows the id and not what it belongs to, and the thread's own
             search matches an entity id whatever kind carries it. */
          onSelectThread={(id) => viewThreadFor(id, '')}
        />

        {/* The right-hand side holds the one control whose value moves, the alert pill, plus the
            doors to everything else. Standing preferences live in the account menu. */}
        <div className="topbar-right">
          {/* A device alert goes to Devices and a gateway alert to Gateways, chosen by the alert's
              declared scope rather than its id prefix, through the same helpers every other surface
              navigates with. */}
          <AlertPill
            alerts={firingAlerts}
            onSelectDevice={showDevice}
            onSelectGateway={showGateway}
          />

          {/* A discovery aid rather than a preference, so it stays in the bar. Beside the alert
              glyph because the avatar must stay the last thing in the bar. */}
          <button
            className="topbar-icon-button"
            onClick={() => setShowShortcuts(true)}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            <IconKeyboard size={15} />
          </button>

          {/* The help control sits between the shortcuts key and the account button.
              `aria-expanded` because it toggles a drawer that stays open, unlike the shortcuts
              dialog. */}
          <button
            className={`topbar-icon-button${showHelp ? ' topbar-icon-button-active' : ''}`}
            onClick={() => setShowHelp((v) => !v)}
            aria-label="Help for this page"
            aria-expanded={showHelp}
            title="Help for this page"
          >
            <IconHelp size={15} />
          </button>

          <UserMenu
            persona={persona}
            userRole={userRole}
            onSignOut={onSignOut}
            theme={theme}
            onToggleTheme={toggleTheme}
            onReportBug={() => setShowBugReport(true)}
          />
        </div>

        {/* Rendered only while busy, so there is no inert element to mistake for a stalled bar.
            `role="progressbar"` with no value: the work is indeterminate. */}
        {apiBusy && (
          <div
            className="topbar-progress"
            role="progressbar"
            aria-label="Loading"
            title="Working…"
          />
        )}
      </header>

      {/* The rail is a permanent gutter. In hover mode its expanded panel paints over the page; in
          expanded mode the row reflows. See Sidebar.jsx. */}
      <div className="app-body">
        <Sidebar tabs={navTabs} currentTab={tab} onNavigate={handleNavClick} mode={sidebarMode} onChangeMode={setSidebarMode} signals={navSignals} />

        <main className="content">
          <Suspense fallback={<div className="loading-wrap"><div className="spinner" /> Loading view…</div>}>
            {tab === 'site-map'       && <SiteMapTab activeAlerts={firingAlerts} onSelectDevice={showDevice} onSelectGateway={showGateway} onSelectCell={showCell} onSelectArea={showArea} showToast={showToast} hasPermission={hasPermission} onNavigateTab={t => setTab(t)} />}
            {tab === 'areas'          && <AreasTab showToast={showToast} onViewThread={a => viewThreadFor(a.area_id, 'AREA')} onSelectCell={showCell} onSelectDevice={showDevice} onSelectGateway={showGateway} hasPermission={hasPermission} initialSearchFilter={selectedAreaFilter} onClearFilter={() => setSelectedAreaFilter('')} />}
            {tab === 'cells'          && <CellsTab activeAlerts={firingAlerts} showToast={showToast} onViewThread={c => viewThreadFor(c.cell_id, 'CELL')} onSelectDevice={showDevice} onSelectGateway={showGateway} onSelectArea={showArea} hasPermission={hasPermission} initialSearchFilter={selectedCellFilter} onClearFilter={() => setSelectedCellFilter('')} />}
            {tab === 'gateways'       && <GatewaysTab userRole={userRole} activeAlerts={firingAlerts} showToast={showToast} onViewThread={g => viewThreadFor(g.gateway_id, 'GATEWAY')} onSelectCell={showCell} onSelectDevice={showDevice} hasPermission={hasPermission} initialSearchFilter={selectedGatewayFilter} onClearFilter={() => setSelectedGatewayFilter('')} />}
            {tab === 'devices'        && <DevicesTab showToast={showToast} onSelectDevice={showDevice} onSelectGateway={showGateway} onSelectCell={showCell} onSelectArea={showArea} onSelectSchema={showSchema} onViewThread={a => viewThreadFor(a.asset_id, 'DEVICE')} onViewApprovals={showApprovalsFor} hasPermission={hasPermission} initialSearchFilter={selectedDeviceFilter} onClearFilter={() => setSelectedDeviceFilter('')} initialSchemaFilter={selectedSchemaFilter} onClearSchemaFilter={() => setSelectedSchemaFilter('')} activeAlerts={firingAlerts} />}
            {/* Re-checked here: `tab` arrives from the URL as well as the nav, so hiding the item
                is not the same as closing the page. */}
            {tab === 'digital-thread' && hasPermission(PERMISSION_UUIDS.DIGITAL_THREAD_READ) && (
              <DigitalThreadTab
                userRole={userRole}
                initialEntity={selectedThreadEntity}
                onClearEntity={() => setSelectedThreadEntity(null)}
                showToast={showToast}
              />
            )}
            {tab === 'schemas'        && <SchemasTab showToast={showToast} hasPermission={hasPermission} onSelectSchema={showDevicesForSchema} onSelectDevice={showDevice} initialSchemaId={selectedSchemaId} />}
            {tab === 'metrics'        && <MetricsTab showToast={showToast} hasPermission={hasPermission} pendingVocabularyEntry={pendingVocabularyEntry} onConsumeVocabularyEntry={() => setPendingVocabularyEntry(null)} />}
            {tab === 'vocabulary'     && <VocabularyTab hasPermission={hasPermission} onUseEntry={entry => { setPendingVocabularyEntry(entry); setTab('metrics') }} />}
            {tab === 'directory'      && <DirectoryTab showToast={showToast} />}
            {/* `currentUserId` lets the page say "you" and offer Edit and Withdraw on the
                proposer's own rows. The transition guard and RLS re-derive the proposer from
                auth.uid(). */}
            {tab === 'approvals'      && <ApprovalsTab showToast={showToast} hasPermission={hasPermission} userRole={userRole} currentUserId={session?.user?.id}
              initialSubject={proposalFocus?.subject || ''}
              onClearFocus={() => setProposalFocus(null)}
              onOpenSubject={openProposalSubject}
              /* The proposal's target, not the proposal: the thread shows the machine's or schema's
                 history with the approval in it. device_nameplate rows are keyed by the device id. */
              onViewThread={p => viewThreadFor(p.entity_id, p.entity_type === 'schemas' ? 'SCHEMA' : 'DEVICE')} />}
            {/* Re-checked because routing can put `tab` on a value the nav never offered.
                `userRole` is passed on because the page distinguishes read-only Auditor from the
                roles that can record. */}
            {tab === 'capture' && ['Administrator', 'Shopfloor_Manager', 'Auditor'].includes(userRole) &&
              <CaptureTab showToast={showToast} userRole={userRole} onSelectSchema={showSchema} />}
            {tab === 'archives'       && <ArchivesTab showToast={showToast} hasPermission={hasPermission} onViewThread={t => viewThreadFor(t.id, t.type, t.purged)} />}
            {/* Re-checked because routing can put `tab` on a value the nav never offered.
                `userRole` lets the page tell "nothing archived" from "not yours to see";
                cold_storage_rows() gates in its body. */}
            {tab === 'cold-storage' && ['Administrator', 'Shopfloor_Manager', 'Auditor'].includes(userRole) &&
              <ColdStorageTab showToast={showToast} userRole={userRole} />}
            {/* The role is re-checked here, not only in the nav: routing can put `tab` on a value
                the nav never offered. Still a courtesy -- RLS is what refuses the write. */}
            {tab === 'access-control' && userRole === 'Administrator' && <AccessControlTab showToast={showToast} />}
            {tab === 'backups' && userRole === 'Administrator' && <BackupsTab showToast={showToast} />}
            {tab === 'settings' && userRole === 'Administrator' && <SettingsTab showToast={showToast} initialSetting={selectedSettingKey} onClearSetting={() => setSelectedSettingKey('')} />}
          </Suspense>
        </main>

        {/* Rendered beside the page so it survives tab switches (`tabId` follows `tab`) and is
            available on pages with no drawer of their own. See HelpPanel.jsx. */}
        <HelpPanel open={showHelp} tabId={tab} onClose={() => setShowHelp(false)} />
      </div>

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={clearToast} />}
      {showBugReport && <BugReportModal onClose={() => setShowBugReport(false)} showToast={showToast} persona={persona} activeTab={tab} />}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authNotice, setAuthNotice] = useState(null)
  // True while a password-reset link is being honoured: from the reset URL, or from the
  // PASSWORD_RECOVERY event supabase-js raises after exchanging the link's token for a session.
  const [recovering, setRecovering] = useState(() => window.location.pathname === RESET_PASSWORD_PATH)

  useEffect(() => {
    let cancelled = false

    // Restore and validate the stored session. getSession() only reads localStorage and PostgREST
    // only checks the JWT signature, so a revoked session would still read data; getUser() asks the
    // auth server.
    const restoreSession = async () => {
      const { data: { session: stored } } = await supabase.auth.getSession()

      if (!stored) {
        if (!cancelled) { setSession(null); setLoading(false) }
        return
      }

      const { error } = await supabase.auth.getUser()
      if (cancelled) return

      if (isSessionRejected(error)) {
        console.warn('[auth] stored session rejected by the auth server:', error.message)
        setAuthNotice(await clearInvalidSession())
        setSession(null)
      } else {
        // No error, or the auth server was simply unreachable -- keep the stored
        // session rather than signing someone out over a network blip.
        if (error) console.warn('[auth] could not validate the stored session:', error.message)
        setSession(stored)
      }
      setLoading(false)
    }

    restoreSession()

    // Listen for Supabase Auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
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
      if (event === 'PASSWORD_RECOVERY') {
        setRecovering(true)
        setSession(session)
        setLoading(false)
        return
      }
      // For other events (INITIAL_SESSION, USER_MODIFIED), update session normally
      setSession(session)
      setLoading(false)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

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

  // Two sessions end here: Studio sits behind a session the gateway owns, so the beacon clears its
  // cookie alongside signOut(). Both start in the same tick so a slow console cannot delay the
  // local sign-out, and signOut() is called synchronously on click, which navigationShell.test.jsx
  // asserts.
  return <Dashboard
    session={session}
    onSignOut={() => Promise.all([signOutOfStudio(), signOutOfForge(), supabase.auth.signOut()])}
  />
}

import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { supabase } from './lib/supabaseClient'
import { usePermissions } from './hooks/usePermissions'
import { useAppRouting } from './hooks/useAppRouting'
import { useTheme } from './hooks/useTheme'
import { useToast } from './hooks/useToast'
import { useQuarantineAlerts } from './hooks/useQuarantineAlerts'
import { clearInvalidSession, isSessionRejected } from './utils/sessionError'
import { PERMISSION_UUIDS, REALTIME_ENABLED } from './constants'
import { readFlag } from './config'

const allowSignUp = readFlag('VITE_ALLOW_SIGNUP')

// Must match GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH in docker-compose.yml. GoTrue appends it
// to GOTRUE_SITE_URL when redirecting an OAuth client's user here to grant consent.
const OAUTH_CONSENT_PATH = '/oauth/consent'

import {
  IconFactory,
  IconRadio,
  IconCpu,
  IconLayoutDashboard,
  IconClipboardList,
  IconFileCode,
  IconArchive,
  IconBookOpen,
  IconHistory,
  IconSun,
  IconMoon,
  IconUser,
  IconBug,
  IconLogOut,
  IconChevronDown
} from './components/common/Icons'

import { Toast } from './components/common/Toast'
import { BugReportModal } from './components/modals/BugReportModal'

// Lazy-load Tab components
const OverviewTab      = lazy(() => import('./components/tabs/OverviewTab').then(m => ({ default: m.OverviewTab })))
const CellsTab         = lazy(() => import('./components/tabs/CellsTab').then(m => ({ default: m.CellsTab })))
const GatewaysTab      = lazy(() => import('./components/tabs/GatewaysTab').then(m => ({ default: m.GatewaysTab })))
const DevicesTab       = lazy(() => import('./components/tabs/DevicesTab').then(m => ({ default: m.DevicesTab })))
const DigitalThreadTab = lazy(() => import('./components/tabs/DigitalThreadTab').then(m => ({ default: m.DigitalThreadTab })))
// Reached only via GoTrue's OAuth redirect, so it is never in the main bundle's critical path.
const OAuthConsent     = lazy(() => import('./pages/OAuthConsent').then(m => ({ default: m.OAuthConsent })))
const SchemasTab       = lazy(() => import('./components/tabs/SchemasTab').then(m => ({ default: m.SchemasTab })))
const VocabularyTab    = lazy(() => import('./components/tabs/VocabularyTab').then(m => ({ default: m.VocabularyTab })))
const DirectoryTab     = lazy(() => import('./components/tabs/DirectoryTab').then(m => ({ default: m.DirectoryTab })))
const ArchivesTab      = lazy(() => import('./components/tabs/ArchivesTab').then(m => ({ default: m.ArchivesTab })))

const TABS = [
  { id: 'overview',       label: 'Overview',          icon: <IconLayoutDashboard size={15} /> },
  { id: 'cells',          label: 'Cells',             icon: <IconFactory size={15} /> },
  { id: 'gateways',       label: 'Gateways',          icon: <IconRadio size={15} /> },
  { id: 'devices',        label: 'Devices',           icon: <IconCpu size={15} /> },
  { id: 'digital-thread', label: 'Digital Thread',    icon: <IconHistory size={15} /> },
  { id: 'schemas',        label: 'Schemas',           icon: <IconClipboardList size={15} /> },
  // Split out of Schemas: the registry and catalog are state you edit, the vocabularies are
  // reference you read, and the reference half grows with every standard adopted.
  { id: 'vocabulary',     label: 'Vocabulary',        icon: <IconFileCode size={15} /> },
  { id: 'directory',      label: 'Directory',         icon: <IconBookOpen size={15} /> },
  { id: 'archives',       label: 'Archives',          icon: <IconArchive size={15} />, permission: PERMISSION_UUIDS.ARCHIVE_MANAGE },
]

function tabIsVisible(tabDef, hasPermission) {
  if (!tabDef.permission) return true
  return hasPermission(tabDef.permission)
}

function AuthScreen({ onLoginSuccess, notice }) {
  const [email, setEmail] = useState('admin@acs-cymru.local')
  const [password, setPassword] = useState('factoryplus123')
  const [isSignUp, setIsSignUp] = useState(false)
  const [authError, setAuthError] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleAuth = async (e) => {
    e.preventDefault()
    setAuthError(null)
    setLoading(true)

    try {
      if (allowSignUp && isSignUp) {
        const { data, error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        if (data.session) onLoginSuccess(data.session)
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        if (data.session) onLoginSuccess(data.session)
      }
    } catch (err) {
      setAuthError(err.message || 'Authentication failed')
    } finally {
      setLoading(false)
    }
  }

  // Colours come from the theme variables in App.css (:root / [data-theme="light"]).
  //
  // This card used to read var(--text-main) and var(--bg-main). NEITHER VARIABLE EXISTS --
  // the real names are --text-primary and --bg-base -- so both silently fell through to the
  // hardcoded near-white literals they were given as fallbacks, in BOTH themes. The card
  // background used --bg-card, which does exist and is #ffffff in light mode, so the result
  // was white text on a white card. The inputs were worse: a literal color: '#fff'.
  //
  // Do not reintroduce fallback literals here. A CSS variable fallback is exactly what let a
  // typo'd variable name look correct in dark mode and fail silently in light mode; without
  // one, an unknown variable renders as an obviously-wrong inherited colour instead.
  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', padding: '20px' }}>
      <div className="card" style={{ width: '100%', maxWidth: '420px', padding: '32px', borderRadius: '16px', background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{ display: 'inline-flex', padding: '12px', borderRadius: '12px', background: 'var(--accent-dim)', color: 'var(--accent)', marginBottom: '12px' }}>
            <IconFactory size={36} />
          </div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 6px 0', color: 'var(--text-primary)' }}>ACS-Cymru Supabase Portal</h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>Sign in with your Supabase BaaS credentials</p>
        </div>

        {notice && !authError && (
          <div style={{ background: 'rgba(255,179,0,0.15)', border: '1px solid var(--warning)', color: 'var(--warning-text)', padding: '10px 14px', borderRadius: '8px', fontSize: '13px', marginBottom: '18px' }}>
            {notice}
          </div>
        )}

        {authError && (
          <div style={{ background: 'rgba(255,77,109,0.15)', border: '1px solid var(--danger)', color: 'var(--danger-text)', padding: '10px 14px', borderRadius: '8px', fontSize: '13px', marginBottom: '18px' }}>
            {authError}
          </div>
        )}

        <form onSubmit={handleAuth}>
          <div className="form-group" style={{ marginBottom: '16px' }}>
            <label className="form-label" style={{ marginBottom: '6px' }}>Email Address</label>
            <input
              type="email"
              className="form-control"
              style={{ borderRadius: '8px' }}
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="form-group" style={{ marginBottom: '24px' }}>
            <label className="form-label" style={{ marginBottom: '6px' }}>Password</label>
            <input
              type="password"
              className="form-control"
              style={{ borderRadius: '8px' }}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
            // Fill and ink come from .btn-primary via --accent-strong / --accent-contrast.
            // This used to pin dark ink onto --accent, which in the light theme is the pairing
            // that measures 5.13:1 by WCAG 2 but only APCA Lc 36.6 -- legible on paper, hard
            // to read on screen.
            style={{ width: '100%', padding: '12px', borderRadius: '8px', fontWeight: 600, fontSize: '14px', border: 'none', cursor: 'pointer' }}
          >
            {loading ? 'Authenticating...' : allowSignUp && isSignUp ? 'Create Supabase Account' : 'Sign In'}
          </button>
        </form>

        {allowSignUp && (
        <div style={{ marginTop: '18px', textAlign: 'center' }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: '12px', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setIsSignUp(!isSignUp)}
          >
            {isSignUp ? 'Already have an account? Sign In' : 'Need an account? Sign Up'}
          </button>
        </div>
        )}
      </div>
    </div>
  )
}

/**
 * The session control, collapsed into one pill with a popover behind it.
 *
 * It used to be four things laid out side by side in the bar: an icon, the full email, a role
 * badge and a Sign Out button, together about 330px. That was the widest block on the right-hand
 * side and it was spending it on two pieces of standing text -- the address you are signed in as,
 * and a button you press when you leave -- neither of which is read more than once a session. The
 * pill is ~150px narrower, and the space goes to the nav, which is the thing that runs out first.
 *
 * The email survives in full inside the popover AND on the pill's `title`, so it is still
 * verifiable at a glance. The role badge does NOT collapse into the menu: it is the standing
 * answer to "why is that button disabled", which is a question asked while looking at the button
 * rather than at this control.
 *
 * Click, not hover. A hover-triggered menu holding the sign-out button puts an irreversible action
 * one stray mouse movement from the cursor's resting corner.
 */
function UserMenu({ persona, userRole, onSignOut }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    // `mousedown`, not `click`: closing on click would fire after a button inside the popover had
    // already been pressed, and closing on blur would beat the press entirely.
    const onPointer = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // The local part only. Addresses on one deployment share a domain, so it is the half that
  // identifies anybody -- and the full address is a hover or a click away.
  const shortName = persona.includes('@') ? persona.split('@')[0] : persona

  return (
    <div className="user-menu" ref={wrapRef}>
      <button
        className={`user-pill${open ? ' user-pill-open' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`Signed in as ${persona} (${userRole}) — open account menu`}
      >
        <IconUser size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <span className="user-pill-name">{shortName}</span>
        <span className="badge badge-neutral user-pill-role">{userRole}</span>
        <IconChevronDown size={11} className={open ? 'user-pill-caret user-pill-caret-open' : 'user-pill-caret'} />
      </button>

      {open && (
        <div className="user-popover" role="menu">
          <div className="user-popover-head">
            <div className="user-popover-email">{persona}</div>
            <div className="user-popover-role">{userRole}</div>
          </div>
          <button
            className="user-popover-action"
            role="menuitem"
            onClick={() => { setOpen(false); onSignOut() }}
            title="Sign out of the Supabase session"
          >
            <IconLogOut size={14} /> Sign Out
          </button>
        </div>
      )}
    </div>
  )
}

function Dashboard({ session, onSignOut }) {
  const [selectedDeviceFilter, setSelectedDeviceFilter] = useState('')
  const [selectedGatewayFilter, setSelectedGatewayFilter] = useState('')
  // Set when a schema's device count is clicked on the Schemas page; consumed by DevicesTab.
  const [selectedSchemaFilter, setSelectedSchemaFilter] = useState('')
  // Set when a cell zone is clicked on the Overview shopfloor map; consumed by CellsTab.
  const [selectedCellFilter, setSelectedCellFilter] = useState('')
  // Set by a "Digital Thread" action on an asset row; consumed by DigitalThreadTab as { id, type }.
  // That page replaced a per-asset modal, which was a smaller copy of it with no export, no
  // auto-refresh and no action filter.
  const [selectedThreadEntity, setSelectedThreadEntity] = useState(null)
  // Set by Use on the Vocabulary page; consumed by SchemasTab, which resolves it against the
  // vocabularies it already holds and opens its Add Metric form.
  const [pendingVocabularyEntry, setPendingVocabularyEntry] = useState(null)
  const [showBugReport, setShowBugReport] = useState(false)

  const { tab, setTab, handleNavClick } = useAppRouting(
    setSelectedDeviceFilter, setSelectedGatewayFilter, setSelectedSchemaFilter, setSelectedCellFilter,
    setSelectedThreadEntity, setPendingVocabularyEntry
  )

  /** Drill into one asset's audit trace on the page that owns it, rather than in a dialog. */
  const viewThreadFor = (id, type) => {
    setSelectedThreadEntity({ id, type })
    setTab('digital-thread', { entity: id })
  }
  const { theme, toggleTheme } = useTheme()
  const { toast, showToast, clearToast } = useToast()

  const { userRole, hasPermission } = usePermissions(session)
  useQuarantineAlerts(showToast)

  // The app-wide "something changed" toast that used to live here has been removed.
  //
  // It subscribed to every table in the `public` schema and raised a toast per change. With a
  // realtime service actually deployed that is no longer a debugging aid but a nuisance:
  // ingestion stamps gateways.last_heartbeat on every NBIRTH/NDATA/NDEATH, so it would toast
  // roughly every 30 seconds per gateway, forever.
  //
  // Data refresh is now owned by the tabs themselves through useRealtimeTable, which
  // subscribes only to the tables the visible tab actually renders. Quarantine arrivals --
  // the one change class that genuinely warrants interrupting the operator -- are handled by
  // useQuarantineAlerts below.

  const persona = session?.user?.email || 'Administrator'

  return (
    <div className="app-shell">
      {/*
        ONE bar: brand, navigation and session controls. The tab strip that used to sit under this
        header is now the centre region, which gives every page back 62px of viewport.

        The nav labels collapse to icons below 1400px rather than scrolling -- see the responsive
        block in App.css. Every tab therefore carries a `title` with its full name at all times,
        because below that width the title is the only thing naming the page.
      */}
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-icon" title="ACS Cymru Platform Logo"><IconFactory size={18} /></div>
          <div className="brand-text">
            {/* Titled because .brand-name truncates: it is the region that yields space when the
                nav and the session controls have taken theirs. */}
            <div className="brand-name" title="AMRC Connectivity Stack - Cymru">AMRC Connectivity Stack - Cymru</div>
            <div className="brand-sub">Shopfloor to Digital Twin Pipeline</div>
          </div>
        </div>

        <nav className="topbar-nav" aria-label="Primary">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`nav-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => handleNavClick(t.id)}
              title={`Navigate to ${t.label} page`}
              aria-current={tab === t.id ? 'page' : undefined}
            >
              <span className="tab-icon">{t.icon}</span>
              <span className="nav-tab-label">{t.label}</span>
            </button>
          ))}
        </nav>

        <div className="topbar-right">
          <div
            className="topbar-status"
            title={REALTIME_ENABLED
              ? 'Live: tabs update on Realtime change events, with a 60s reconciliation refresh'
              : 'Polling: tabs refresh every 3s (Realtime disabled)'}
          ><div className="pulse-dot" /> {REALTIME_ENABLED ? 'Live' : 'Polling'}</div>

          <button className="btn btn-ghost btn-sm" onClick={toggleTheme} title="Toggle Light / Dark UI Theme">
            {theme === 'dark' ? <IconSun size={14} /> : <IconMoon size={14} />}
          </button>

          <button className="btn btn-ghost btn-sm" onClick={() => setShowBugReport(true)} title="Report an application bug" style={{ gap: '6px' }}>
            <IconBug size={14} style={{ color: 'var(--danger)' }} /> <span className="btn-label">Report Bug</span>
          </button>

          <UserMenu persona={persona} userRole={userRole} onSignOut={onSignOut} />
        </div>
      </header>

      {/* Main Content */}
      <main className="content">
        <Suspense fallback={<div className="loading-wrap"><div className="spinner" /> Loading view…</div>}>
          {tab === 'overview'       && <OverviewTab onSelectDevice={id => { setSelectedDeviceFilter(id); setTab('devices', { search: id }) }} onSelectGateway={id => { setSelectedGatewayFilter(id); setTab('gateways', { search: id }) }} onSelectCell={id => { setSelectedCellFilter(id); setTab('cells', { search: id }) }} showToast={showToast} hasPermission={hasPermission} onNavigateTab={t => setTab(t)} />}
          {tab === 'cells'          && <CellsTab showToast={showToast} onViewThread={c => viewThreadFor(c.cell_id, 'CELL')} onSelectDevice={id => { setSelectedDeviceFilter(id); setTab('devices', { search: id }) }} onSelectGateway={id => { setSelectedGatewayFilter(id); setTab('gateways', { search: id }) }} hasPermission={hasPermission} initialSearchFilter={selectedCellFilter} onClearFilter={() => setSelectedCellFilter('')} />}
          {tab === 'gateways'       && <GatewaysTab showToast={showToast} onViewThread={g => viewThreadFor(g.gateway_id, 'GATEWAY')} hasPermission={hasPermission} initialSearchFilter={selectedGatewayFilter} onClearFilter={() => setSelectedGatewayFilter('')} />}
          {tab === 'devices'        && <DevicesTab showToast={showToast} onSelectDevice={id => { setSelectedDeviceFilter(id); setTab('devices', { search: id }) }} onViewThread={a => viewThreadFor(a.asset_id, 'DEVICE')} hasPermission={hasPermission} initialSearchFilter={selectedDeviceFilter} onClearFilter={() => setSelectedDeviceFilter('')} initialSchemaFilter={selectedSchemaFilter} onClearSchemaFilter={() => setSelectedSchemaFilter('')} />}
          {tab === 'digital-thread' && (
            <DigitalThreadTab
              initialEntity={selectedThreadEntity}
              onClearEntity={() => setSelectedThreadEntity(null)}
            />
          )}
          {tab === 'schemas'        && <SchemasTab showToast={showToast} hasPermission={hasPermission} onSelectSchema={uuid => { setSelectedSchemaFilter(uuid); setTab('devices', { schema: uuid }) }} pendingVocabularyEntry={pendingVocabularyEntry} onConsumeVocabularyEntry={() => setPendingVocabularyEntry(null)} />}
          {tab === 'vocabulary'     && <VocabularyTab hasPermission={hasPermission} onUseEntry={entry => { setPendingVocabularyEntry(entry); setTab('schemas') }} />}
          {tab === 'directory'      && <DirectoryTab showToast={showToast} hasPermission={hasPermission} />}
          {tab === 'archives'       && <ArchivesTab showToast={showToast} hasPermission={hasPermission} />}
        </Suspense>
      </main>

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={clearToast} />}
      {showBugReport && <BugReportModal onClose={() => setShowBugReport(false)} showToast={showToast} persona={persona} activeTab={tab} />}
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authNotice, setAuthNotice] = useState(null)

  useEffect(() => {
    let cancelled = false

    // Restore and *validate* the stored session.
    //
    // getSession() only reads localStorage, and PostgREST only checks the JWT
    // signature -- so a token whose auth.sessions row no longer exists (database
    // volume recreated, session revoked, secret rotated) still reads data and the app
    // looks signed in, while every Edge Function call fails with an opaque error.
    // getUser() asks the auth server whether the session is actually still there.
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
      // For other events (INITIAL_SESSION, USER_MODIFIED), update session normally
      setSession(session)
      setLoading(false)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  // OAuth consent, checked before the loading and auth branches below.
  //
  // GoTrue sends the browser here from /oauth/authorize (see
  // GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH in docker-compose.yml) because it ships no consent
  // UI of its own. The page reads the session itself and renders its own sign-in prompt when
  // there is none, so it must not fall through to AuthScreen -- doing so would lose the
  // authorization_id and strand the OAuth client with no way back.
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

  if (!session) {
    return <AuthScreen notice={authNotice} onLoginSuccess={(sess) => { setAuthNotice(null); setSession(sess) }} />
  }

  return <Dashboard session={session} onSignOut={() => supabase.auth.signOut()} />
}

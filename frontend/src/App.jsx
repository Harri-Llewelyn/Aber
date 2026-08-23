import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { supabase } from './lib/supabaseClient'
import { usePermissions } from './hooks/usePermissions'
import { useAppRouting } from './hooks/useAppRouting'
import { useTheme } from './hooks/useTheme'
import { useToast } from './hooks/useToast'
import { useApiActivity } from './hooks/useApiActivity'
import { useQuarantineAlerts } from './hooks/useQuarantineAlerts'
import { clearInvalidSession, isSessionRejected } from './utils/sessionError'
import { PERMISSION_UUIDS } from './constants'

/*
 * THERE IS NO SIGN-UP PATH, and its absence is a decision rather than an omission.
 *
 * This screen used to offer one behind a `VITE_ALLOW_SIGNUP` flag that defaulted to false. Hiding
 * the form was all that flag ever did: `POST /auth/v1/signup` stayed open on the gateway, because
 * GoTrue was configured with `GOTRUE_DISABLE_SIGNUP: "false"` regardless. Anyone who could reach
 * Kong could self-register and land on the default `Operator` role that handle_new_user() assigns
 * -- past every RBAC decision in the database, none of which is reached until you hold a session.
 *
 * A client-side flag is not an access control, so it has been replaced by the server-side one:
 * GOTRUE_DISABLE_SIGNUP now defaults to "true" and is the single switch. Accounts arrive by
 * invitation, by admin provisioning, or from an upstream identity provider.
 *
 * The flag is gone rather than left pointing at the new setting, because two settings that must
 * agree is a drift risk, and the one that can be edited in a browser's dev tools is not the one to
 * keep. A stack that genuinely wants open registration sets GOTRUE_DISABLE_SIGNUP=false and
 * provisions through the Auth API.
 */

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
  IconSettings,
  IconBookOpen,
  IconHistory,
  IconSun,
  IconMoon,
  IconUser,
  IconBug,
  IconLogOut
} from './components/common/Icons'

import { Toast } from './components/common/Toast'
import { AlertPill } from './components/common/AlertPill'
import { usePlatformAlerts } from './hooks/usePlatformAlerts'
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
const SettingsTab      = lazy(() => import('./components/tabs/SettingsTab').then(m => ({ default: m.SettingsTab })))

export const TABS = [
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
  // GATED ON THE ROLE, NOT ON A PERMISSION, because the DATABASE gates on the role: 0031's UPDATE
  // policy is `has_role(ARRAY['Administrator'])`. Inventing a SETTINGS_MANAGE permission for the
  // UI would mean two different predicates deciding the same question, and the day they disagree
  // the page is visible and every save fails.
  { id: 'settings',       label: 'Settings',          icon: <IconSettings size={15} />, role: 'Administrator' },
]

/**
 * Whether a tab appears in the nav.
 *
 * THIS FUNCTION EXISTED AND WAS NEVER CALLED. `TABS.map` rendered every tab unconditionally, so
 * `Archives` has been visible to everyone regardless of `ARCHIVE_MANAGE` since it was added -- the
 * declaration read like a gate and gated nothing. Connecting it is what makes the Settings tab's
 * role check mean anything, so it is fixed here rather than left for later.
 *
 * IT IS STILL ONLY A COURTESY. Hiding a tab removes a signpost, not an ability: the same PATCH can
 * be sent with curl, and what refuses it is the RLS policy. Nothing here is a security control,
 * and treating it as one is how a UI gate ends up being the ONLY gate.
 */
export function tabIsVisible(tabDef, hasPermission, userRole) {
  if (tabDef.role && userRole !== tabDef.role) return false
  if (!tabDef.permission) return true
  return hasPermission(tabDef.permission)
}

function AuthScreen({ onLoginSuccess, notice }) {
  /**
   * EMPTY, AND THEY MUST STAY EMPTY.
   *
   * These two fields shipped pre-filled with `admin@acs-cymru.local` / the seeded Administrator
   * password. That was a debugging convenience during development and it is a credential
   * disclosure in a deployed stack: the values are baked into the production JavaScript bundle,
   * which is served to ANYONE who can reach the page -- before authenticating, and regardless of
   * whether they ever sign in. Reading them takes no more than opening the login screen, and the
   * account they unlock is the one that can edit settings, manage devices and read every table
   * the dashboard exposes.
   *
   * It is worth being precise about why this is not merely untidy. The seeded password is public
   * -- it is in `supabase/seed.sql` and in the README, deliberately, because a demo stack needs
   * reproducible accounts. The defect is not that the string exists; it is that the LOGIN FORM
   * offered it, so a stack whose seeded accounts had never been rotated was one click from
   * administrator access by design rather than by oversight. Rotating the seeded password would
   * not have fixed this, and leaving these blank does fix it even when the password has not been
   * rotated.
   *
   * `__tests__/authScreenCredentials.test.jsx` asserts both fields render empty, and
   * scripts/check-docs-drift.mjs refuses the seeded password anywhere under frontend/src --
   * because a comment is not a control.
   */
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState(null)
  const [loading, setLoading] = useState(false)

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
            {/* htmlFor/id, because the label was associated with NOTHING. A screen reader
                announced two unlabelled text boxes, and clicking the word "Password" did not
                focus the field under it. Added here rather than filed separately because the
                empty fields make it matter more: there is now nothing in either box to
                disambiguate them by. */}
            <label className="form-label" htmlFor="auth-email" style={{ marginBottom: '6px' }}>Email Address</label>
            {/* autoComplete and autoFocus are what REPLACE the pre-filled value, rather than
                simply doing without it. The prefill's only legitimate purpose was saving an
                operator from typing the same credential every time; a password manager does that
                properly -- per user, per browser, never in the bundle -- but only if the fields
                are annotated for it. Without these the change is a pure usability regression, and
                a usability regression is what gets reverted. */}
            <input
              id="auth-email"
              type="email"
              className="form-control"
              style={{ borderRadius: '8px' }}
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </div>

          <div className="form-group" style={{ marginBottom: '24px' }}>
            <label className="form-label" htmlFor="auth-password" style={{ marginBottom: '6px' }}>Password</label>
            <input
              id="auth-password"
              type="password"
              className="form-control"
              style={{ borderRadius: '8px' }}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
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
            {loading ? 'Authenticating...' : 'Sign In'}
          </button>
        </form>

        {/* WHERE THE SIGN-UP TOGGLE USED TO BE. A line of text rather than nothing, because an
            operator who expected to register needs to be told the door is shut deliberately --
            otherwise the report that arrives is "the sign-up button is broken". */}
        <p style={{ marginTop: '18px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
          Accounts are provisioned by an administrator. Contact your platform owner for access.
        </p>
      </div>
    </div>
  )
}

/**
 * The account control: a round icon button with everything that is not navigation behind it.
 *
 * IT HAS COLLAPSED TWICE, and the second step is the one worth explaining. It began as four things
 * laid out side by side -- icon, full email, role badge, Sign Out -- about 330px of bar. That became
 * a pill carrying the local part and the role, with the address and Sign Out behind it. It is now a
 * 28px circle, and the theme toggle and Report Bug have moved in with them.
 *
 * WHAT THE SECOND STEP GAVE UP. The role badge was previously kept OUT of the menu on the argument
 * that it is the standing answer to "why is that button disabled" -- a question asked while looking
 * at a disabled button, not while looking at this control. That argument was correct and the trade
 * has been made anyway, because the bar was carrying five separate controls on the right and the
 * role is the least often needed of the things it said. It is the first line inside the menu, one
 * click away, and it is still on the button's `title` alongside the address -- so both survive a
 * hover without opening anything.
 *
 * WHY THESE THREE AND NOT OTHERS. The menu is not a junk drawer: what went in is everything that is
 * a SESSION-LEVEL PREFERENCE OR ESCAPE HATCH rather than a piece of live state. A theme is set once
 * and never again; Report Bug is pressed when something has already gone wrong; Sign Out ends the
 * session. None of the three is read, and none reports anything. The alert counter stayed in the bar
 * for precisely the inverse reason -- it is the one control there whose VALUE changes.
 *
 * Click, not hover. A hover-triggered menu holding the sign-out button puts an irreversible action
 * one stray mouse movement from the cursor's resting corner.
 */
function UserMenu({ persona, userRole, onSignOut, theme, onToggleTheme, onReportBug }) {
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

  const nextTheme = theme === 'dark' ? 'Light' : 'Dark'

  return (
    <div className="user-menu" ref={wrapRef}>
      {/* NO VISIBLE TEXT, so the accessible name comes from `title` -- which is why that string
          leads with the address and the role rather than with "Account". A screen reader announcing
          "open account menu" would have lost the one thing this control used to say for free. */}
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
          </div>

          {/* A TOGGLE STATES WHERE IT IS, NOT WHERE IT GOES. "Theme: Dark" with a sun icon reads as
              "press for Light" once you know the convention and as a broken label until then. The
              current value is the fact; the icon shows the destination. */}
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

          {/* The menu does NOT close on the theme toggle -- and does on the other two. Toggling is
              the one action here whose result is visible behind the menu, and closing would mean
              reopening to change your mind about a two-state choice. */}
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
  const [selectedDeviceFilter, setSelectedDeviceFilter] = useState('')
  const [selectedGatewayFilter, setSelectedGatewayFilter] = useState('')
  // Set when a schema's device count is clicked on the Schemas page; consumed by DevicesTab.
  const [selectedSchemaFilter, setSelectedSchemaFilter] = useState('')
  // The opposite direction, and a SEPARATE state rather than a reuse of the one above. Set by a
  // device drawer's Schema chip and consumed by SchemasTab, which opens that schema's drawer.
  // Sharing one value would mean opening a schema also re-filtered the Devices page behind you --
  // the two hand-overs travel in opposite directions and mean different things.
  const [selectedSchemaId, setSelectedSchemaId] = useState('')
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

  /**
   * The cross-page hand-overs, named once instead of spelled out at every call site.
   *
   * There are five of them and they were inline arrows repeated across seven props -- `showDevice`
   * alone appeared four times, once per page that can point at a device. With the relationship chips
   * added to the gateway, cell and schema drawers that would have become eleven copies of three
   * lines, and the failure mode of a copied hand-over is the quiet one: a page that sets the filter
   * but forgets the tab, or pushes a query key the target does not read.
   *
   * EACH SETS STATE *AND* PUSHES A QUERY PARAMETER, and both halves are load-bearing. The state
   * covers the tab that is already mounted (every tab stays mounted across navigation, so its
   * initial-state reader has long since run); the query string survives a reload and makes the
   * destination linkable. The target pages read both -- URL first.
   */
  const showDevice  = (id) => { setSelectedDeviceFilter(id);  setTab('devices',  { search: id }) }
  const showGateway = (id) => { setSelectedGatewayFilter(id); setTab('gateways', { search: id }) }
  const showCell    = (id) => { setSelectedCellFilter(id);    setTab('cells',    { search: id }) }
  /** Open ONE schema's drawer on the Schemas page -- a device drawer's Schema chip. */
  const showSchema  = (uuid) => { setSelectedSchemaId(uuid);  setTab('schemas',  { search: uuid }) }
  /** The opposite direction: every device provisioned with a schema. Note the `schema` key. */
  const showDevicesForSchema = (uuid) => {
    setSelectedSchemaFilter(uuid)
    setTab('devices', { schema: uuid })
  }
  const { theme, toggleTheme } = useTheme()
  const { toast, showToast, clearToast } = useToast()

  const { userRole, hasPermission, loadingPerms } = usePermissions(session)

  /*
   * LEAVE A TAB THAT IS NO LONGER VISIBLE TO THIS USER.
   *
   * `tab` outlives a session. Sign out from Settings as an Administrator, sign back in as an
   * Operator, and the route is still `settings` -- a tab that is now absent from the nav and whose
   * render is guarded, so the main area renders NOTHING. A blank page with a plausible URL and no
   * message is the worst of the available failures: it reads as the app being broken rather than
   * as a page this account cannot see, and there is no control on screen saying so.
   *
   * WAITS FOR `loadingPerms`, WHICH IS THE WHOLE DIFFICULTY. `userRole` is null while the
   * permission fetch is in flight, so acting on it immediately would bounce an Administrator off
   * Settings on every hard refresh -- a redirect that looks exactly like a permission failure and
   * is a race.
   *
   * Overview, because it is the one tab with no gate at all.
   */
  useEffect(() => {
    if (loadingPerms) return
    const current = TABS.find(t => t.id === tab)
    if (current && !tabIsVisible(current, hasPermission, userRole)) setTab('overview')
  }, [tab, loadingPerms, userRole, hasPermission, setTab])

  useQuarantineAlerts(showToast)

  // Grafana's firing alerts, delivered through platform_alerts. Lifted to App rather than owned by a
  // tab because an excursion on the machining cell must be visible while somebody is reading the
  // Vocabulary page -- an alert scoped to the tab that happens to be open is an alert that arrives
  // only when it is not needed.
  const firingAlerts = usePlatformAlerts(showToast)

  // Fed by the counter every call through `api` increments, so it covers a save on a modal and a
  // tab's reconciliation poll alike without either having to report anything.
  const apiBusy = useApiActivity()

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
          {TABS.filter(t => tabIsVisible(t, hasPermission, userRole)).map(t => (
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

        {/*
          TWO CONTROLS, and that is the whole of the right-hand side now.

          It held five: the alert pill, a Live/Polling chip, a theme toggle, Report Bug and the
          account pill. Four of those five never changed -- the theme is set once a career, Report
          Bug is a door you use when something else has already broken, the account is who you are,
          and the Live chip was read off a BUILD FLAG rather than off the socket, so it was a lit
          green dot that could not go out. A bar of controls that never change teaches the eye to
          stop reading it, which is a problem when one of them is the alarm.

          So the standing state and the standing preferences were separated. What is left in the bar
          is the one thing whose value moves, plus the door to everything else.
        */}
        <div className="topbar-right">
          <AlertPill
            alerts={firingAlerts}
            onSelectDevice={id => { setSelectedDeviceFilter(id); setTab('devices', { search: id }) }}
          />

          <UserMenu
            persona={persona}
            userRole={userRole}
            onSignOut={onSignOut}
            theme={theme}
            onToggleTheme={toggleTheme}
            onReportBug={() => setShowBugReport(true)}
          />
        </div>

        {/* The one piece of chrome that reports work rather than state. Rendered only while busy
            so there is no inert element to mistake for a stalled bar.

            `role="progressbar"` with no value: the work is genuinely indeterminate (see the CSS),
            and publishing a made-up aria-valuenow would be worse than publishing none. */}
        {apiBusy && (
          <div
            className="topbar-progress"
            role="progressbar"
            aria-label="Loading"
            title="Working…"
          />
        )}
      </header>

      {/* Main Content */}
      <main className="content">
        <Suspense fallback={<div className="loading-wrap"><div className="spinner" /> Loading view…</div>}>
          {tab === 'overview'       && <OverviewTab activeAlerts={firingAlerts} onSelectDevice={showDevice} onSelectGateway={showGateway} onSelectCell={showCell} showToast={showToast} hasPermission={hasPermission} onNavigateTab={t => setTab(t)} />}
          {tab === 'cells'          && <CellsTab activeAlerts={firingAlerts} showToast={showToast} onViewThread={c => viewThreadFor(c.cell_id, 'CELL')} onSelectDevice={showDevice} onSelectGateway={showGateway} hasPermission={hasPermission} initialSearchFilter={selectedCellFilter} onClearFilter={() => setSelectedCellFilter('')} />}
          {tab === 'gateways'       && <GatewaysTab activeAlerts={firingAlerts} showToast={showToast} onViewThread={g => viewThreadFor(g.gateway_id, 'GATEWAY')} onSelectCell={showCell} onSelectDevice={showDevice} hasPermission={hasPermission} initialSearchFilter={selectedGatewayFilter} onClearFilter={() => setSelectedGatewayFilter('')} />}
          {tab === 'devices'        && <DevicesTab showToast={showToast} onSelectDevice={showDevice} onSelectGateway={showGateway} onSelectCell={showCell} onSelectSchema={showSchema} onViewThread={a => viewThreadFor(a.asset_id, 'DEVICE')} hasPermission={hasPermission} initialSearchFilter={selectedDeviceFilter} onClearFilter={() => setSelectedDeviceFilter('')} initialSchemaFilter={selectedSchemaFilter} onClearSchemaFilter={() => setSelectedSchemaFilter('')} activeAlerts={firingAlerts} />}
          {tab === 'digital-thread' && (
            <DigitalThreadTab
              initialEntity={selectedThreadEntity}
              onClearEntity={() => setSelectedThreadEntity(null)}
              showToast={showToast}
            />
          )}
          {tab === 'schemas'        && <SchemasTab showToast={showToast} hasPermission={hasPermission} onSelectSchema={showDevicesForSchema} onSelectDevice={showDevice} initialSchemaId={selectedSchemaId} pendingVocabularyEntry={pendingVocabularyEntry} onConsumeVocabularyEntry={() => setPendingVocabularyEntry(null)} />}
          {tab === 'vocabulary'     && <VocabularyTab hasPermission={hasPermission} onUseEntry={entry => { setPendingVocabularyEntry(entry); setTab('schemas') }} />}
          {tab === 'directory'      && <DirectoryTab showToast={showToast} hasPermission={hasPermission} />}
          {tab === 'archives'       && <ArchivesTab showToast={showToast} hasPermission={hasPermission} />}
          {/* The role is re-checked here, not only in the nav: routing can put `tab` on a value
              the nav never offered. Still a courtesy -- RLS is what refuses the write. */}
          {tab === 'settings' && userRole === 'Administrator' && <SettingsTab showToast={showToast} />}
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

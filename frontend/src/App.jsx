import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { supabase } from './lib/supabaseClient'
import { usePermissions } from './hooks/usePermissions'
import { useAppRouting } from './hooks/useAppRouting'
import { useTheme } from './hooks/useTheme'
import { useToast } from './hooks/useToast'
import { useApiActivity } from './hooks/useApiActivity'
import { useQuarantineAlerts } from './hooks/useQuarantineAlerts'
import { clearInvalidSession, isSessionRejected } from './utils/sessionError'
import { signOutOfStudio } from './utils/studioSignOut'
import { TABS, tabIsVisible } from './navigation'
import AmbientPipeline from './components/common/AmbientPipeline'
import { Sidebar } from './components/common/Sidebar'
import { GlobalSearch } from './components/common/GlobalSearch'

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
import { BugReportModal } from './components/modals/BugReportModal'
import { ShortcutsModal } from './components/modals/ShortcutsModal'

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
const CaptureTab       = lazy(() => import('./components/tabs/CaptureTab').then(m => ({ default: m.CaptureTab })))
const ColdStorageTab   = lazy(() => import('./components/tabs/ColdStorageTab').then(m => ({ default: m.ColdStorageTab })))
const SettingsTab      = lazy(() => import('./components/tabs/SettingsTab').then(m => ({ default: m.SettingsTab })))
const AccessControlTab = lazy(() => import('./components/tabs/AccessControlTab').then(m => ({ default: m.AccessControlTab })))
const ApprovalsTab     = lazy(() => import('./components/tabs/ApprovalsTab').then(m => ({ default: m.ApprovalsTab })))

/*
 * THE PAGE LIST MOVED TO `navigation.jsx`, AND IS RE-EXPORTED FROM HERE UNCHANGED.
 *
 * It lived here for as long as this file was the only thing that read it. Three things read it now
 * -- the sidebar draws it, the search palette indexes it, and the effect below still consults it --
 * and a component this file renders cannot import from this file without a cycle.
 *
 * Re-exported rather than moved outright because the tests that grew up around `TABS` and
 * `tabIsVisible` import them from here, and where a list is declared is not what any of them is
 * about.
 *
 * `navDensity()` IS GONE, AND ITS ABSENCE IS THE POINT OF THE CHANGE. It banded the top bar by how
 * many tabs a session could see, because thirteen of them in one horizontal strip had a measured
 * ceiling: at fourteen the wordmark had ~24px left and the ladder had nowhere further to go. A
 * vertical rail spends the axis there is more of, so the ceiling, the bands and the two media
 * queries that implemented them all go with it.
 */
export { TABS, tabIsVisible, NAV_GROUPS, groupedNav } from './navigation'

function AuthScreen({ onLoginSuccess, notice }) {
  // AuthScreen owns a theme handle of its own because it renders INSTEAD of Dashboard, never
  // beside it -- the two hook instances are never mounted at the same time and cannot diverge.
  // Before this the toggle lived only in UserMenu, behind the login: a light-mode operator got
  // the dark default on the one screen they see before authenticating, every single time.
  const { theme, toggleTheme } = useTheme()
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
    <div style={{ position: 'relative', display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', padding: '20px', overflow: 'hidden' }}>
      {/* Decoration, and it is allowed to fail. The canvas paints --bg-base as its own ground, so
          a browser that gives back no 2d context leaves the page looking exactly as it did before
          this was added rather than leaving a hole. It is aria-hidden and pointer-events:none
          throughout, and it renders a single still frame under prefers-reduced-motion. */}
      <AmbientPipeline theme={theme} />

      {/* The theme control, ABOVE the canvas and the only interactive thing outside the card.
          Same convention as the one in UserMenu: the label states where the theme IS and the icon
          shows where the button GOES, which is why the icon and the word disagree on purpose. */}
      <button
        type="button"
        onClick={toggleTheme}
        className="auth-theme-toggle"
        title={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`}
        aria-label={`Theme: ${theme === 'dark' ? 'dark' : 'light'}. Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme.`}
      >
        {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
      </button>

      <div className="card" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: '420px', padding: '32px', borderRadius: '16px', background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)' }}>
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
            {/* THE VERSION SITS IN THE HEAD, NOT AMONG THE THREE ACTIONS BELOW (issue #57), and the
                split is the one this menu already draws: the head states facts about the session,
                the rows below DO things. A version is read and never pressed, so putting it in the
                action list would be the fourth item that does not behave like the other three.

                Shown to every user rather than to administrators alone. The reason to display it
                at all is that whoever hits a fault can say which build they hit it on, and that is
                most often not the person with the admin password. */}
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
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

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

  /*
   * `?` OPENS THE SHORTCUTS LIST, which is the convention and is also the only way this particular
   * dialog is not absurd: a list of keyboard shortcuts reachable solely by mouse asks the reader to
   * do the thing it exists to help them stop doing. The button in the bar is what makes it
   * discoverable; this is what makes it worth having found.
   *
   * IT MUST NOT FIRE WHILE SOMEBODY IS TYPING, and that is the whole difficulty with binding a
   * PRINTABLE character. Every other shortcut in this app carries a modifier or is a key with no
   * text meaning, so none of them has to ask this question -- but `?` is a character a user can
   * legitimately want in a search box, a schema description or a bug report. So the handler stands
   * down for any editable target, including `contenteditable`, and for any keystroke carrying a
   * modifier, which is somebody reaching for a browser shortcut rather than for this one.
   */
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

  // Computed once and used twice: the rail draws it and the search palette indexes it. Filtering
  // in both places would let the search offer a page the rail does not.
  const navTabs = TABS.filter(t => tabIsVisible(t, hasPermission, userRole))

  return (
    <div className="app-shell">
      {/*
        THE BAR NO LONGER NAVIGATES. It carried thirteen tabs between the brand and the session
        controls, which is where the density ladder and its two media queries came from -- and at
        fourteen pages there was no band left to add. Navigation moved to the rail on the left,
        and the centre of the bar is now the search box, which is a better use of a horizontal
        strip than a list: one control whose width is fixed, however many pages exist.
      */}
      <header className="topbar">
        {/* A BUTTON, BECAUSE IT NAVIGATES. Clicking the mark to get home is a convention old enough
            that its absence reads as a broken link rather than as a decision -- people click it,
            nothing happens, and they conclude the header is decorative.

            `handleNavClick`, not `setTab`, and the difference is the same one the rail relies on:
            it clears the cross-page filters a drill-down handed over. Clicking the logo means
            "start again", which is exactly when a stale device filter would be most confusing.

            A real <button> rather than a div with an onClick, so it is reachable by Tab, announces
            itself, and takes Enter and Space without any of that being reimplemented here. */}
        <button
          className="topbar-brand"
          onClick={() => handleNavClick('overview')}
          title="ACS Cymru — go to the Overview page"
          aria-label="ACS Cymru, go to the Overview page"
        >
          <div className="brand-icon"><IconFactory size={18} /></div>
          <div className="brand-text">
            {/* Titled because .brand-name truncates: it is the region that yields space when the
                search box and the session controls have taken theirs.

                TWO SPELLINGS, ONE SHOWN, and the measurement behind that is unobvious. The two
                lines are nearly the same width -- the wordmark ~242px against the strapline
                ~251px -- and this is a stacked block, so the box is as wide as the WIDER of them.
                Hiding the strapline therefore reclaims about nine pixels rather than the two
                hundred it looks like it should. The line that has to give is the wordmark, and it
                gives by getting shorter rather than by disappearing.

                `title` carries the full name at every step, and the short form is hidden from
                assistive technology, so the accessible name never changes with the viewport. */}
            <div className="brand-name" title="AMRC Connectivity Stack - Cymru">
              <span className="brand-name-full">AMRC Connectivity Stack - Cymru</span>
              <span className="brand-name-short" aria-hidden="true">ACS Cymru</span>
            </div>
            <div className="brand-sub">Shopfloor to Digital Twin Pipeline</div>
          </div>
        </button>

        {/* THE CENTRE OF THE BAR, where the thirteen tabs were.

            It takes the SAME `navTabs` the rail does, so the two can never disagree about what
            this session may reach, and the SAME hand-over helpers every other surface navigates
            with -- so pasting a device id here lands exactly where clicking that device from the
            Overview map lands, query parameter and all. */}
        <GlobalSearch
          tabs={navTabs}
          currentTab={tab}
          onNavigate={handleNavClick}
          onSelectDevice={showDevice}
          onSelectGateway={showGateway}
          onSelectCell={showCell}
          onSelectSchema={showSchema}
        />

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
          {/* THE SAME TWO HELPERS EVERY OTHER SURFACE NAVIGATES WITH, rather than the inline copy
              of showDevice this used to carry -- one destination per subject, defined once above.

              A gateway alert goes to the Gateways page, and until it did EVERY alert this stack can
              raise went to Devices: of the ten rules shipped, four are gateway-scoped and five are
              platform-scoped, and none is a device. A stale gateway sent the operator to a Devices
              search for a `gwy...` id no device row can ever match. The two handlers stay separate
              rather than one that switches on the id, because which page a row belongs on is the
              alert's declared scope and not a guess from its prefix. */}
          <AlertPill
            alerts={firingAlerts}
            onSelectDevice={showDevice}
            onSelectGateway={showGateway}
          />

          {/* THE THIRD CONTROL IN THE BAR, AND IT BREAKS THE RULE ABOVE ON PURPOSE. That rule is
              that only things whose VALUE CHANGES stay out here; a shortcuts key is as standing as
              the theme toggle, which was moved into the account menu on exactly that argument.

              What earns it the place is that it is a SIGNPOST rather than a preference. The two
              items behind the account menu are set once and forgotten, so hiding them costs one
              click on a rare day. This is the opposite: its whole value is being seen by somebody
              who does not yet know the keyboard does anything, and a discovery aid nobody discovers
              is just a file. Beside the alert glyph rather than after the avatar, because the
              avatar must stay the last thing in the bar -- it is the fixed corner people aim at. */}
          <button
            className="topbar-icon-button"
            onClick={() => setShowShortcuts(true)}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            <IconKeyboard size={15} />
          </button>

          {/* THE FOURTH CONTROL, AND IT EARNS ITS PLACE ON THE SAME ARGUMENT AS THE THIRD. A help
              control is as standing as the theme toggle, and it is a signpost rather than a
              preference: the reader who needs it is by definition not going to go looking for it
              behind the avatar. It sits between the shortcuts key and the account pill because
              those two are the same kind of thing -- ways to find out what this application can do
              -- and because the avatar must stay the last thing in the bar.

              `aria-expanded` and not just a label: this one TOGGLES a drawer that stays open while
              you read and navigate, unlike the shortcuts key, which opens a dialog. A control whose
              second press closes something has to say so. */}
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

      {/* THE RAIL AND THE PAGE, SIDE BY SIDE.

          A row rather than the page alone, because the rail is a permanent 52px gutter. What it is
          NOT is a two-column layout that resizes: the expanded panel is painted over the page from
          inside that gutter, so nothing here reflows when the pointer enters it. See Sidebar.jsx. */}
      <div className="app-body">
        <Sidebar tabs={navTabs} currentTab={tab} onNavigate={handleNavClick} />

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
            {tab === 'directory'      && <DirectoryTab showToast={showToast} />}
            {/* `currentUserId` is what lets the page say "you" and offer Edit and Withdraw on a
                proposer's own rows. It is a courtesy: the transition guard and the RLS policy
                both re-derive the proposer from `auth.uid()`, so a wrong value here produces a
                refused call rather than somebody else's proposal being editable. */}
            {tab === 'approvals'      && <ApprovalsTab showToast={showToast} hasPermission={hasPermission} userRole={userRole} currentUserId={session?.user?.id}
              /* The proposal's TARGET, not the proposal: what a reader wants after an approval is
                 the machine's or the schema's history, with the approval in it beside everything
                 else that happened to it. `device_nameplate` resolves to its device for the same
                 reason -- those rows are keyed by the device id. */
              onViewThread={p => viewThreadFor(p.entity_id, p.entity_type === 'schemas' ? 'SCHEMA' : 'DEVICE')} />}
            {/* The role is re-checked here for the same reason Access Control's is: routing can put
                `tab` on a value the nav never offered. `userRole` is passed on rather than a boolean,
                because the page distinguishes read-only Auditor from the two roles that can record. */}
            {tab === 'capture' && ['Administrator', 'Shopfloor_Manager', 'Auditor'].includes(userRole) &&
              <CaptureTab showToast={showToast} userRole={userRole} onSelectSchema={showSchema} />}
            {tab === 'archives'       && <ArchivesTab showToast={showToast} hasPermission={hasPermission} />}
            {/* Re-checked here as the others are: routing can put `tab` on a value the nav never
                offered. `userRole` is passed on rather than a boolean because the page uses it to
                tell "nothing archived" apart from "not yours to see" -- cold_storage_rows() gates in
                its body, so both look like an empty list from the browser. */}
            {tab === 'cold-storage' && ['Administrator', 'Shopfloor_Manager', 'Auditor'].includes(userRole) &&
              <ColdStorageTab showToast={showToast} userRole={userRole} />}
            {/* The role is re-checked here, not only in the nav: routing can put `tab` on a value
                the nav never offered. Still a courtesy -- RLS is what refuses the write. */}
            {tab === 'access-control' && userRole === 'Administrator' && <AccessControlTab showToast={showToast} />}
            {tab === 'settings' && userRole === 'Administrator' && <SettingsTab showToast={showToast} />}
          </Suspense>
        </main>

        {/* HELP IS A SIBLING OF THE PAGE, NOT PART OF IT. Rendered here so it survives every tab
            switch -- `tabId` follows `tab`, so the drawer re-reads as you navigate rather than
            closing and having to be reopened -- and so it is available on the pages that have no
            drawer of their own. See HelpPanel.jsx. */}
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

  // TWO SESSIONS END HERE, NOT ONE. Studio sits behind a session the gateway owns and this client
  // knows nothing about, so signOut() alone leaves the database console open on the identity that
  // just left -- which is exactly how an operator once reached it as the previous admin.
  //
  // CONCURRENT, NOT SEQUENTIAL, and that is a correctness point rather than a speed one. The
  // beacon needs no session -- it clears a cookie the gateway owns -- so neither call depends on
  // the other, and awaiting Studio FIRST would make a slow or unreachable console delay the local
  // sign-out that must always happen. Starting both in the same tick also keeps signOut() called
  // synchronously on click, which is the contract navigationShell.test.jsx asserts.
  return <Dashboard
    session={session}
    onSignOut={() => Promise.all([signOutOfStudio(), supabase.auth.signOut()])}
  />
}

import React, { useState, useEffect, lazy, Suspense, useCallback, useMemo } from 'react'
import { supabase } from './lib/supabaseClient'
import { usePermissions } from './hooks/usePermissions'
import { useAppRouting } from './hooks/useAppRouting'
import { useTheme } from './hooks/useTheme'
import { useToast } from './hooks/useToast'
import { useQuarantineAlerts } from './hooks/useQuarantineAlerts'
import { PERMISSION_UUIDS } from './constants'

const allowSignUp = import.meta.env.VITE_ALLOW_SIGNUP === 'true'

import {
  IconCog,
  IconFactory,
  IconRadio,
  IconCpu,
  IconActivity,
  IconLayoutDashboard,
  IconClipboardList,
  IconArchive,
  IconBookOpen,
  IconHistory,
  IconSun,
  IconMoon,
  IconUser,
  IconBug,
  IconLock
} from './components/common/Icons'

import { Toast } from './components/common/Toast'
import { BugReportModal } from './components/modals/BugReportModal'

// Lazy-load Tab components
const OverviewTab      = lazy(() => import('./components/tabs/OverviewTab').then(m => ({ default: m.OverviewTab })))
const CellsTab         = lazy(() => import('./components/tabs/CellsTab').then(m => ({ default: m.CellsTab })))
const GatewaysTab      = lazy(() => import('./components/tabs/GatewaysTab').then(m => ({ default: m.GatewaysTab })))
const DevicesTab       = lazy(() => import('./components/tabs/DevicesTab').then(m => ({ default: m.DevicesTab })))
const DigitalThreadTab = lazy(() => import('./components/tabs/DigitalThreadTab').then(m => ({ default: m.DigitalThreadTab })))
const TelemetryTab     = lazy(() => import('./components/tabs/TelemetryTab').then(m => ({ default: m.TelemetryTab })))
const SchemasTab       = lazy(() => import('./components/tabs/SchemasTab').then(m => ({ default: m.SchemasTab })))
const DirectoryTab     = lazy(() => import('./components/tabs/DirectoryTab').then(m => ({ default: m.DirectoryTab })))
const ArchivesTab      = lazy(() => import('./components/tabs/ArchivesTab').then(m => ({ default: m.ArchivesTab })))

const TABS = [
  { id: 'overview',       label: 'Overview',          icon: <IconLayoutDashboard size={15} /> },
  { id: 'cells',          label: 'Cells',             icon: <IconFactory size={15} /> },
  { id: 'gateways',       label: 'Gateways',          icon: <IconRadio size={15} /> },
  { id: 'devices',        label: 'Devices',           icon: <IconCpu size={15} /> },
  { id: 'digital-thread', label: 'Digital Thread',    icon: <IconHistory size={15} /> },
  { id: 'telemetry',      label: 'Telemetry',         icon: <IconActivity size={15} /> },
  { id: 'schemas',        label: 'Schemas',           icon: <IconClipboardList size={15} /> },
  { id: 'directory',      label: 'Directory',         icon: <IconBookOpen size={15} /> },
  { id: 'archives',       label: 'Archives',          icon: <IconArchive size={15} />, permission: PERMISSION_UUIDS.ARCHIVE_MANAGE },
]

function tabIsVisible(tabDef, hasPermission) {
  if (!tabDef.permission) return true
  return hasPermission(tabDef.permission)
}

function AuthScreen({ onLoginSuccess }) {
  const [email, setEmail] = useState('admin@factoryplus.local')
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

  return (
    <div style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-main, #0f172a)', padding: '20px' }}>
      <div className="card" style={{ width: '100%', maxWidth: '420px', padding: '32px', borderRadius: '16px', background: 'var(--bg-card, #1e293b)', border: '1px solid var(--border, #334155)', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.5)' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{ display: 'inline-flex', padding: '12px', borderRadius: '12px', background: 'rgba(56, 189, 248, 0.1)', color: 'var(--accent, #38bdf8)', marginBottom: '12px' }}>
            <IconCog size={36} />
          </div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 6px 0', color: 'var(--text-main, #f8fafc)' }}>Factory+ Supabase Portal</h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted, #94a3b8)', margin: 0 }}>Sign in with your Supabase BaaS credentials</p>
        </div>

        {authError && (
          <div style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', color: '#ef4444', padding: '10px 14px', borderRadius: '8px', fontSize: '13px', marginBottom: '18px' }}>
            {authError}
          </div>
        )}

        <form onSubmit={handleAuth}>
          <div className="form-group" style={{ marginBottom: '16px' }}>
            <label className="form-label" style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-main, #f8fafc)' }}>Email Address</label>
            <input
              type="email"
              className="form-control"
              style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border, #475569)', background: 'var(--bg-glass, #0f172a)', color: '#fff' }}
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="form-group" style={{ marginBottom: '24px' }}>
            <label className="form-label" style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--text-main, #f8fafc)' }}>Password</label>
            <input
              type="password"
              className="form-control"
              style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border, #475569)', background: 'var(--bg-glass, #0f172a)', color: '#fff' }}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
            style={{ width: '100%', padding: '12px', borderRadius: '8px', fontWeight: 600, fontSize: '14px', background: 'var(--accent, #38bdf8)', color: '#0f172a', border: 'none', cursor: 'pointer' }}
          >
            {loading ? 'Authenticating...' : allowSignUp && isSignUp ? 'Create Supabase Account' : 'Sign In'}
          </button>
        </form>

        {allowSignUp && (
        <div style={{ marginTop: '18px', textAlign: 'center' }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: '12px', color: 'var(--accent, #38bdf8)', background: 'none', border: 'none', cursor: 'pointer' }}
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

function Dashboard({ session, onSignOut }) {
  const [selectedDeviceFilter, setSelectedDeviceFilter] = useState('')
  const [selectedGatewayFilter, setSelectedGatewayFilter] = useState('')
  const [showBugReport, setShowBugReport] = useState(false)

  const { tab, setTab, handleNavClick } = useAppRouting(setSelectedDeviceFilter, setSelectedGatewayFilter)
  const { theme, toggleTheme } = useTheme()
  const { toast, showToast, clearToast } = useToast()

  const { userRole, hasPermission } = usePermissions(session, showToast)
  useQuarantineAlerts(showToast)

  // Real-time Postgres Changes Listener
  useEffect(() => {
    const channel = supabase
      .channel('schema-db-changes')
      .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => {
        showToast(`Real-time update: ${payload.table} ${payload.eventType}`, 'info')
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [showToast])

  const persona = session?.user?.email || 'Administrator'

  return (
    <div className="app-shell">
      {/* Top Bar */}
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-icon" title="Factory+ Platform Logo"><IconCog size={20} /></div>
          <div>
            <div className="brand-name">Factory+ Asset Tracking Platform</div>
            <div className="brand-sub">Supabase BaaS + Standalone TimescaleDB Architecture</div>
          </div>
        </div>

        <div className="topbar-right">
          {/* Supabase User & Role Badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-glass)', padding: '4px 10px', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <IconUser size={13} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: '12px', fontWeight: 600 }}>{persona}</span>
            <span className="badge badge-neutral" style={{ fontSize: '10px' }}>{userRole}</span>
            <button className="btn btn-ghost btn-sm" onClick={onSignOut} style={{ padding: '2px 8px', fontSize: '11px', marginLeft: '6px' }}>
              Sign Out
            </button>
          </div>

          <button className="btn btn-ghost btn-sm" onClick={() => setShowBugReport(true)} title="Report an application bug" style={{ gap: '6px' }}>
            <IconBug size={14} style={{ color: 'var(--danger)' }} /> Report Bug
          </button>

          <button className="btn btn-ghost btn-sm" onClick={toggleTheme} title="Toggle Light / Dark UI Theme">
            {theme === 'dark' ? <IconSun size={14} /> : <IconMoon size={14} />}
          </button>
          <div className="topbar-status" title="Real-time Supabase connection status"><div className="pulse-dot" /> Live</div>
        </div>
      </header>

      {/* Nav */}
      <nav className="nav-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`nav-tab ${tab === t.id ? 'active' : ''}`} onClick={() => handleNavClick(t.id)} title={`Navigate to ${t.label} page`}>
            <span className="tab-icon">{t.icon}</span>{t.label}
          </button>
        ))}
      </nav>

      {/* Main Content */}
      <main className="content">
        <Suspense fallback={<div className="loading-wrap"><div className="spinner" /> Loading view…</div>}>
          {tab === 'overview'       && <OverviewTab onSelectDevice={id => { setSelectedDeviceFilter(id); setTab('devices', { search: id }) }} onSelectGateway={id => { setSelectedGatewayFilter(id); setTab('gateways', { search: id }) }} showToast={showToast} hasPermission={hasPermission} onNavigateTab={t => setTab(t)} />}
          {tab === 'cells'          && <CellsTab showToast={showToast} onSelectDevice={id => { setSelectedDeviceFilter(id); setTab('telemetry', { asset_id: id }) }} hasPermission={hasPermission} />}
          {tab === 'gateways'       && <GatewaysTab showToast={showToast} hasPermission={hasPermission} initialSearchFilter={selectedGatewayFilter} onClearFilter={() => setSelectedGatewayFilter('')} />}
          {tab === 'devices'        && <DevicesTab showToast={showToast} onSelectDevice={id => { setSelectedDeviceFilter(id); setTab('telemetry', { asset_id: id }) }} hasPermission={hasPermission} initialSearchFilter={selectedDeviceFilter} onClearFilter={() => setSelectedDeviceFilter('')} />}
          {tab === 'digital-thread' && <DigitalThreadTab />}
          {tab === 'telemetry'      && <TelemetryTab initialAssetFilter={selectedDeviceFilter} onClearFilter={() => setSelectedDeviceFilter('')} hasPermission={hasPermission} />}
          {tab === 'schemas'        && <SchemasTab showToast={showToast} hasPermission={hasPermission} />}
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

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })

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

    return () => subscription.unsubscribe()
  }, [])

  if (loading) {
    return <div className="loading-wrap"><div className="spinner" /> Connecting to Supabase Auth…</div>
  }

  if (!session) {
    return <AuthScreen onLoginSuccess={(sess) => setSession(sess)} />
  }

  return <Dashboard session={session} onSignOut={() => supabase.auth.signOut()} />
}

import React from 'react'
import AmbientPipeline from '../common/AmbientPipeline'
import { IconSun, IconMoon } from '../common/Icons'
import { AberMark } from '../common/AberMark'

/**
 * The chrome every pre-authentication screen shares: the animated ground, the theme toggle and
 * the centred card with the wordmark. Sign-in and password reset render their forms inside it.
 * Colours come from the theme variables with no fallback literals, so an unknown variable fails
 * visibly rather than looking right in one theme only.
 */
export function AuthShell({ theme, onToggleTheme, title, subtitle, children }) {
  return (
    <div style={{ position: 'relative', display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', padding: '20px', overflow: 'hidden' }}>
      <AmbientPipeline theme={theme} />

      <button
        type="button"
        onClick={onToggleTheme}
        className="auth-theme-toggle"
        title={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`}
        aria-label={`Theme: ${theme === 'dark' ? 'dark' : 'light'}. Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme.`}
      >
        {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
      </button>

      <div className="card" style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: '420px', padding: '32px', borderRadius: '16px', background: 'var(--bg-card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{ display: 'inline-flex', color: 'var(--accent-strong)', marginBottom: '14px' }}>
            <AberMark size={56} />
          </div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, margin: '0 0 6px 0', color: 'var(--text-primary)' }}>{title}</h2>
          {subtitle && <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}

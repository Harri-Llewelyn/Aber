import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() => Promise.resolve({ data: { session: null } })),
      getUser: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
    },
  },
}))

/**
 * Strip comments before scanning: these assertions look for forbidden strings in the source, and a
 * comment naming the old mistake would otherwise be flagged. Only whole-line `//` comments are
 * removed.
 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

const APP_JSX = stripComments(fs.readFileSync(path.resolve(__dirname, '../App.jsx'), 'utf8'))
const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

/** Every custom property the stylesheet actually defines. */
const definedVars = new Set(
  [...APP_CSS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map(m => m[1])
)

/**
 * The sign-in card once referenced var(--text-main) and var(--bg-main), neither of which exists,
 * and the hardcoded fallbacks hid it in dark mode. These guard the class of bug: any CSS variable
 * referenced in App.jsx must be one the stylesheet defines, and the login inputs must not hardcode
 * a colour.
 */
describe('AuthScreen theming', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('data-theme', 'light')
  })

  it('defines the theme variables for both light and dark', () => {
    expect(definedVars.has('--text-primary')).toBe(true)
    expect(definedVars.has('--bg-base')).toBe(true)
    expect(APP_CSS).toMatch(/\[data-theme="light"\]/)
  })

  it('references no CSS variable that the stylesheet does not define', () => {
    const referenced = [...APP_JSX.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(m => m[1])
    const undefinedVars = [...new Set(referenced)].filter(v => !definedVars.has(v))
    expect(undefinedVars).toEqual([])
  })

  it('no longer references the phantom --text-main / --bg-main', () => {
    expect(APP_JSX).not.toMatch(/var\(\s*--text-main/)
    expect(APP_JSX).not.toMatch(/var\(\s*--bg-main/)
  })

  it('does not hardcode a text colour on the sign-in inputs', () => {
    // The inputs used `color: '#fff'`, which is unreadable on the light theme's white card.
    // Colour must come from .form-control so it follows the theme.
    const authScreen = APP_JSX.slice(
      APP_JSX.indexOf('function AuthScreen'),
      APP_JSX.indexOf('function Dashboard')
    )
    expect(authScreen).not.toMatch(/color:\s*'#fff'/i)
    expect(authScreen).not.toMatch(/color:\s*'#ffffff'/i)
  })

  it('renders the card heading, labels and inputs through themed classes', async () => {
    const { default: App } = await import('../App')
    render(<App />)

    const heading = await screen.findByText('ACS-Cymru Supabase Portal')
    expect(heading).toBeTruthy()
    // Reads the real variable rather than a literal, so the theme controls it.
    expect(heading.getAttribute('style')).toContain('var(--text-primary)')

    // Labels and inputs carry the themed classes and no inline colour override.
    const emailLabel = screen.getByText('Email Address')
    expect(emailLabel.className).toContain('form-label')
    expect(emailLabel.getAttribute('style') || '').not.toContain('color')

    const email = document.querySelector('input[type="email"]')
    expect(email.className).toContain('form-control')
    expect(email.getAttribute('style') || '').not.toContain('color')
  })

  it('styles placeholders from the theme rather than the browser default', () => {
    // --text-muted, not --text-dim: the latter measures 2.45:1 against --bg-base in dark
    // mode, which fails WCAG AA. See the rule's comment in App.css.
    expect(APP_CSS).toMatch(/\.form-control::placeholder\s*\{[^}]*color:\s*var\(--text-muted\)/)
  })
})

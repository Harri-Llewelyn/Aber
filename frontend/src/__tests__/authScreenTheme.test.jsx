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

/** Every .js/.jsx file under a directory. */
const sourceFilesUnder = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFilesUnder(full)
    return /\.jsx?$/.test(entry.name) ? [full] : []
  })

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

  it('references no undefined CSS variable in App.css or under components/', () => {
    const src = path.resolve(__dirname, '..')
    const files = [
      { file: 'App.css', text: APP_CSS },
      ...sourceFilesUnder(path.join(src, 'components')).map(f => ({
        file: path.relative(src, f),
        text: fs.readFileSync(f, 'utf8')
      }))
    ]
    // Also declared where a rule or an inline style sets one for its own subtree, as in
    // `.badge-drive { --x: ... }` and `style={{ '--x': value }}`.
    const declared = new Set(files.flatMap(({ text }) =>
      [...text.matchAll(/(--[a-z0-9-]+)['"]?\s*:/gi)].map(m => m[1])))
    const undefinedVars = files.flatMap(({ file, text }) =>
      [...new Set([...text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(m => m[1]))]
        .filter(v => !declared.has(v))
        .map(v => `${file}: ${v}`)
    )
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

    const heading = await screen.findByText('Sign in to Aber')
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

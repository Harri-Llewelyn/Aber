import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'

const mockUseAuth = vi.fn().mockReturnValue({
  isAuthenticated: false,
  user: null,
  error: null,
  events: {
    addSilentRenewError: vi.fn(),
    removeSilentRenewError: vi.fn()
  },
  signinRedirect: vi.fn(),
  removeUser: vi.fn().mockResolvedValue()
})

vi.mock('../api', () => ({
  api: {
    get: vi.fn().mockImplementation((url) => {
      if (url.includes('/authz/me/permissions')) {
        return Promise.resolve({ permissions: [] })
      }
      if (url.includes('/quarantine')) {
        return Promise.resolve([])
      }
      if (url.includes('/stats')) {
        return Promise.resolve({ cells: 1, gateways: 2, devices: 3 })
      }
      return Promise.resolve([])
    })
  },
  setGlobalToken: vi.fn()
}))

vi.mock('react-oidc-context', () => ({
  AuthProvider: ({ children }) => <div>{children}</div>,
  useAuth: () => mockUseAuth()
}))

describe('App Component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.pushState({}, '', '/')
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      user: null,
      error: null,
      events: {
        addSilentRenewError: vi.fn(),
        removeSilentRenewError: vi.fn()
      },
      signinRedirect: vi.fn(),
      removeUser: vi.fn().mockResolvedValue()
    })
  })

  it('renders application topbar and header title correctly', async () => {
    render(<App />)

    expect(screen.getByText('Factory+ Asset Tracking Prototype')).toBeInTheDocument()
    expect(screen.getByText('Industrial Automation & Digital Thread Platform')).toBeInTheDocument()
  })

  it('navigates between navigation tabs when clicked', async () => {
    render(<App />)

    const devicesTabButton = screen.getByTitle('Navigate to Devices page')
    fireEvent.click(devicesTabButton)

    await waitFor(() => {
      expect(window.location.pathname).toBe('/devices')
    })

    const archivesTabButton = screen.getByTitle('Navigate to Archives page')
    fireEvent.click(archivesTabButton)

    await waitFor(() => {
      expect(window.location.pathname).toBe('/archives')
    })
  })

  it('renders OIDC error banner when auth.error is set and triggers signinRedirect on retry click', async () => {
    const mockSigninRedirect = vi.fn()
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      user: null,
      error: new Error('Keycloak provider unreachable'),
      events: {
        addSilentRenewError: vi.fn(),
        removeSilentRenewError: vi.fn()
      },
      signinRedirect: mockSigninRedirect,
      removeUser: vi.fn().mockResolvedValue()
    })

    render(<App />)

    expect(screen.getByTestId('oidc-error-banner')).toBeInTheDocument()
    expect(screen.getByText('Keycloak provider unreachable')).toBeInTheDocument()

    const retryBtn = screen.getByRole('button', { name: /Retry Login/i })
    fireEvent.click(retryBtn)

    expect(mockSigninRedirect).toHaveBeenCalledTimes(1)
  })
})

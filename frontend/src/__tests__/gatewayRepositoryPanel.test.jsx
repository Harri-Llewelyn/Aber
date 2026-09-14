import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../constants', () => ({
  GITEA_URL: 'http://forge.plant.local',
  FORGE_ORGANISATION: 'gateways'
}))

const { GatewayRepositoryPanel, gatewayRepositoryUrl, gatewayCompareUrl } = await import('../components/common/GatewayRepositoryPanel')

const GATEWAY = {
  gateway_id: '2a000000-0000-4000-8000-000000000001',
  gateway_name: 'Cell 4 Press Line',
  sparkplug_id: 'gwy2a0000000000400080000',
  deployment: 'remote'
}

/**
 * The gate is a role, not a permission: GatewaysTab computes it as the two roles the forge's own
 * listener admits, Administrator and Shopfloor_Manager. These take the resulting boolean.
 */
describe('GatewayRepositoryPanel — who sees it', () => {
  it('links a role the forge admits to the gateway repository, under the organisation', () => {
    render(<GatewayRepositoryPanel gateway={GATEWAY} canOpenForge />)
    const link = screen.getByTitle(/Open this gateway's repository/i)
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('http://forge.plant.local/gateways/gateway-gwy2a0000000000400080000')
    // A new tab, and no opener: the forge is another origin with its own session.
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('links the issues and the wiki beside the repository, as three acts rather than one', () => {
    render(<GatewayRepositoryPanel gateway={GATEWAY} canOpenForge />)
    const base = 'http://forge.plant.local/gateways/gateway-gwy2a0000000000400080000'
    expect(screen.getByTitle(/Open this gateway's issues/i).getAttribute('href')).toBe(`${base}/issues`)
    expect(screen.getByTitle(/Open this gateway's wiki/i).getAttribute('href')).toBe(`${base}/wiki`)
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toContain('noopener')
    }
  })

  it('shows a role the forge would refuse nothing at all -- not a disabled link', () => {
    const { container } = render(<GatewayRepositoryPanel gateway={GATEWAY} canOpenForge={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('derives the address from the sparkplug id and nothing stored', () => {
    expect(gatewayRepositoryUrl({ sparkplug_id: 'gwyabc' })).toBe('http://forge.plant.local/gateways/gateway-gwyabc')
  })
})

describe('GatewayRepositoryPanel — what the appliance reports', () => {
  it('offers the compare view only once the appliance has pushed its branch', () => {
    // Before the first push the branch does not exist and the forge would answer 404.
    render(<GatewayRepositoryPanel gateway={GATEWAY} canOpenForge />)
    expect(screen.queryByTitle(/against what was approved/i)).toBeNull()
  })

  it('links the direct diff between main and the appliance branch, two dots not three', () => {
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, forge_appliance_sha: 'b'.repeat(40) }} canOpenForge />)
    const link = screen.getByTitle(/against what was approved/i)
    expect(link.getAttribute('href')).toBe('http://forge.plant.local/gateways/gateway-gwy2a0000000000400080000/compare/main..appliance')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(gatewayCompareUrl({ sparkplug_id: 'gwyabc' })).toBe('http://forge.plant.local/gateways/gateway-gwyabc/compare/main..appliance')
  })
})

describe('GatewayRepositoryPanel — host-run gateways', () => {
  it('explains that there is no repository, and offers no link', () => {
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, deployment: 'host' }} canOpenForge />)
    expect(screen.getByText(/has no repository of its own/i)).toBeInTheDocument()
    expect(screen.queryByTitle(/Open this gateway's repository/i)).toBeNull()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('does not call it a virtual gateway', () => {
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, deployment: 'host' }} canOpenForge />)
    expect(screen.queryByText(/virtual/i)).toBeNull()
  })
})

describe('GatewayRepositoryPanel — what it no longer is', () => {
  it('offers nothing of the retired proposal dropzone', () => {
    const { container } = render(<GatewayRepositoryPanel gateway={GATEWAY} canOpenForge />)
    expect(container.querySelector('input[type="file"]')).toBeNull()
    expect(screen.queryByText(/drop flows\.json/i)).toBeNull()
  })
})

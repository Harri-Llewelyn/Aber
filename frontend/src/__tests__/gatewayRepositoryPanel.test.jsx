import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../constants', () => ({
  GITEA_URL: 'http://forge.plant.local',
  FORGE_ORGANISATION: 'gateways'
}))

const { GatewayRepositoryPanel, gatewayRepositoryUrl } = await import('../components/common/GatewayRepositoryPanel')

const GATEWAY = {
  gateway_id: '2a000000-0000-4000-8000-000000000001',
  gateway_name: 'Cell 4 Press Line',
  sparkplug_id: 'gwy2a0000000000400080000',
  deployment: 'remote'
}

/**
 * THE GATE IS A ROLE, NOT A PERMISSION, and GatewaysTab computes it as the two roles the forge's
 * own listener admits -- Administrator and Shopfloor_Manager. These tests take the resulting
 * boolean, which is the whole of this component's contract.
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

  it('shows a role the forge would refuse nothing at all -- not a disabled link', () => {
    const { container } = render(<GatewayRepositoryPanel gateway={GATEWAY} canOpenForge={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('derives the address from the sparkplug id and nothing stored', () => {
    expect(gatewayRepositoryUrl({ sparkplug_id: 'gwyabc' })).toBe('http://forge.plant.local/gateways/gateway-gwyabc')
  })
})

describe('GatewayRepositoryPanel — host-run gateways', () => {
  it('explains that there is no repository, and offers no link', () => {
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, deployment: 'host' }} canOpenForge />)
    expect(screen.getByText(/has no repository of its own/i)).toBeInTheDocument()
    expect(screen.queryByTitle(/Open this gateway's repository/i)).toBeNull()
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

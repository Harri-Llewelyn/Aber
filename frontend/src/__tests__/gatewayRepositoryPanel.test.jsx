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
  deployment: 'remote',
  // The repository is created when the appliance redeems its bundle, so every test that expects
  // links needs a gateway that has done so -- and one whose enrolment got as far as step 4, which
  // is a second column because step 4 is non-fatal and skipped on a deployment with no forge.
  enrolled_at: '2026-08-01T09:00:00Z',
  forge_repository_at: '2026-08-01T09:00:01Z'
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

describe('GatewayRepositoryPanel — before enrolment', () => {
  it("offers no link for a remote gateway that has never enrolled", () => {
    // enroll-gateway creates the repository from the key the appliance sends; until then every
    // address the panel derives answers 404.
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, enrolled_at: null, status: 'PENDING_ENROLLMENT' }} canOpenForge />)
    expect(screen.getByText(/has not enrolled yet/i)).toBeInTheDocument()
    expect(screen.queryAllByRole("link")).toHaveLength(0)
  })

  it("withholds the compare view too, even where the appliance branch was once reported", () => {
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, enrolled_at: null, forge_appliance_sha: 'b'.repeat(40) }} canOpenForge />)
    expect(screen.queryByTitle(/against what was approved/i)).toBeNull()
  })

  it("shows a role the forge would refuse nothing at all, enrolled or not", () => {
    const { container } = render(
      <GatewayRepositoryPanel gateway={{ ...GATEWAY, enrolled_at: null }} canOpenForge={false} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('GatewayRepositoryPanel — enrolled, with no repository', () => {
  /**
   * enroll-gateway sets `enrolled_at` in step 3 and creates the repository in step 4. Step 4 is
   * skipped on a deployment with no forge, skipped when the appliance sent no usable key, and
   * non-fatal when it fails -- so `enrolled_at` alone would offer four links that answer 404.
   */
  it('offers no link where enrolment never reached the forge', () => {
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, forge_repository_at: null }} canOpenForge />)
    expect(screen.getByText(/enrolled but has no repository/i)).toBeInTheDocument()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('does not tell an enrolled gateway it has never enrolled', () => {
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, forge_repository_at: null }} canOpenForge />)
    expect(screen.queryByText(/has not enrolled yet/i)).toBeNull()
  })

  it('withholds the compare view too, even where the appliance branch was once reported', () => {
    render(
      <GatewayRepositoryPanel
        gateway={{ ...GATEWAY, forge_repository_at: null, forge_appliance_sha: 'b'.repeat(40) }}
        canOpenForge
      />
    )
    expect(screen.queryByTitle(/against what was approved/i)).toBeNull()
  })

  // A gateway read through an embed rather than the gateways query: `undefined`, not `null`. The
  // embed names its columns, so a missing one is a query bug that must not read as a data one.
  it('treats a column the query never selected the same as an absent repository', () => {
    const { forge_repository_at: _omitted, ...withoutTheColumn } = GATEWAY
    render(<GatewayRepositoryPanel gateway={withoutTheColumn} canOpenForge />)
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('shows a role the forge would refuse nothing at all', () => {
    const { container } = render(
      <GatewayRepositoryPanel gateway={{ ...GATEWAY, forge_repository_at: null }} canOpenForge={false} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('GatewayRepositoryPanel — host-run gateways', () => {
  it('explains that there is no repository, and offers no link', () => {
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, deployment: 'host' }} canOpenForge />)
    expect(screen.getByText(/has no repository of its own/i)).toBeInTheDocument()
    expect(screen.queryByTitle(/Open this gateway's repository/i)).toBeNull()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('never calls it virtual', () => {
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, deployment: 'host' }} canOpenForge />)
    expect(screen.queryByText(/virtual/i)).toBeNull()
  })

  // Each type gets its own sentence: a Simulated gateway's readings need not come from Node-RED.
  it('says a simulated gateway is simulated, without claiming Node-RED runs it', () => {
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, deployment: 'host', is_simulated: true }} canOpenForge />)
    expect(screen.getByText(/A simulated gateway has no repository of its own/i)).toBeInTheDocument()
    expect(screen.queryByText(/Its connector runs in this stack's own/i)).toBeNull()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('says playback publishes as a shadow gateway, which is also simulated', () => {
    render(
      <GatewayRepositoryPanel
        gateway={{ ...GATEWAY, deployment: 'host', is_simulated: true, is_shadow: true }}
        canOpenForge
      />
    )
    expect(screen.getByText(/A shadow gateway has no repository of its own/i)).toBeInTheDocument()
    expect(screen.getByText(/Playback publishes as it/i)).toBeInTheDocument()
    expect(screen.queryByText(/simulated gateway/i)).toBeNull()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })
})

describe('GatewayRepositoryPanel — archived in the forge', () => {
  /**
   * Archiving a gateway archives its repository (#197): forge-sweep marks it read-only and writes
   * `forge_archived_at` once the forge has answered. The column is the sweep's answer, not the
   * dashboard's assumption, so an archived gateway on a deployment with no forge says nothing
   * about one.
   */
  const ARCHIVED = { ...GATEWAY, is_archived: true, forge_archived_at: '2026-09-16T10:00:00Z' }

  it('says the repository is read-only and that restoring reverses it', () => {
    render(<GatewayRepositoryPanel gateway={ARCHIVED} canOpenForge />)
    const text = screen.getByText(/read-only/i).textContent
    expect(text).toMatch(/archived/i)
    expect(text).toMatch(/restored/i)
  })

  it('keeps every link, because reading is the point of archiving rather than deleting', () => {
    render(<GatewayRepositoryPanel gateway={ARCHIVED} canOpenForge />)
    expect(screen.getByTitle(/Open this gateway's repository/i)).toBeInTheDocument()
    expect(screen.getByTitle(/issues/i)).toBeInTheDocument()
    expect(screen.getByTitle(/wiki/i)).toBeInTheDocument()
  })

  it('stops inviting a pull request nothing could merge', () => {
    render(<GatewayRepositoryPanel gateway={ARCHIVED} canOpenForge />)
    expect(screen.queryByText(/open a pull request/i)).toBeNull()
  })

  it('says nothing about the archive for a gateway the sweep has not archived', () => {
    // An archived gateway whose repository the sweep has not reached yet -- or a deployment with
    // no forge at all, where it never will. `is_archived` alone must not claim otherwise.
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, is_archived: true }} canOpenForge />)
    expect(screen.getByText(/open a pull request/i)).toBeInTheDocument()
    expect(screen.queryByText(/read-only/i)).toBeNull()
  })
})

describe('GatewayRepositoryPanel — what it no longer is', () => {
  it('offers nothing of the retired proposal dropzone', () => {
    const { container } = render(<GatewayRepositoryPanel gateway={GATEWAY} canOpenForge />)
    expect(container.querySelector('input[type="file"]')).toBeNull()
    expect(screen.queryByText(/drop flows\.json/i)).toBeNull()
  })
})

import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import {
  AUDIT_TRAIL_ENTITY_TYPES,
  AUDIT_TRAIL_SECURITY_ROLES,
  auditTrailEntityTypesFor
} from '../constants'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

// The three audit_domain_for() names, and the two backup kinds (0101) it files there by its
// fail-closed default: an act on the whole database is an Administrator's to perform, so it is an
// Administrator's and an Auditor's to read.
const SECURITY_LABELS = ['Role assignments', 'Machine identities', 'Settings', 'Backup jobs', 'Backups']

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue([])
})

/**
 * The filter offers what the database will answer. `audit_trail_select_security` admits two
 * roles to the security domain; every other role sees the asset domain only, and offering them Role
 * assignments produced a filter that always read "no events".
 */
describe('which entity types a role is offered', () => {
  it('every kind names its audit domain', () => {
    for (const e of AUDIT_TRAIL_ENTITY_TYPES) expect(['asset', 'security']).toContain(e.domain)
  })

  it('the security kinds are exactly the five the policy guards', () => {
    const security = AUDIT_TRAIL_ENTITY_TYPES.filter(e => e.domain === 'security').map(e => e.label)
    expect(security.sort()).toEqual([...SECURITY_LABELS].sort())
  })

  it('mirrors the roles the SELECT policy admits, read from the migration', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/0001_baseline_schema.sql'), 'utf8')
    const policy = sql.match(/CREATE POLICY audit_trail_select_security ON public\.audit_trail[^\n]*has_role\(ARRAY\[([^\]]+)\]/)
    expect(policy, 'the security policy has moved or been renamed').toBeTruthy()
    const roles = [...policy[1].matchAll(/'([A-Za-z_]+)'/g)].map(m => m[1]).sort()
    expect([...AUDIT_TRAIL_SECURITY_ROLES].sort()).toEqual(roles)
  })

  it('withholds the security kinds from a Shopfloor_Manager and an Operator', () => {
    for (const role of ['Shopfloor_Manager', 'Operator']) {
      const labels = auditTrailEntityTypesFor(role).map(e => e.label)
      for (const l of SECURITY_LABELS) expect(labels, role).not.toContain(l)
      expect(labels).toContain('Devices')
    }
  })

  it('offers everything to the two audit roles, and while the role is still unknown', () => {
    for (const role of ['Administrator', 'Auditor', null, undefined]) {
      expect(auditTrailEntityTypesFor(role)).toEqual(AUDIT_TRAIL_ENTITY_TYPES)
    }
  })
})

describe('the filter bar on the page', () => {
  const optionsOffered = async (userRole) => {
    render(<AuditTrailTab userRole={userRole} />)
    const select = await screen.findByTitle('Show only events against one kind of entity')
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    return [...select.options].map(o => o.textContent)
  }

  it('does not list the security lanes for a manager', async () => {
    const offered = await optionsOffered('Shopfloor_Manager')
    for (const l of SECURITY_LABELS) expect(offered).not.toContain(l)
    expect(offered).toContain('Devices')
  })

  it('lists them for an auditor', async () => {
    const offered = await optionsOffered('Auditor')
    for (const l of SECURITY_LABELS) expect(offered).toContain(l)
  })
})

/**
 * A role-assignment row is keyed by `user_roles.user_id`, so the lane is a PERSON -- and nothing
 * served to the browser could turn that id into anybody until `list_user_accounts()` (0116). The
 * lane drew a shortened uuid, which answers two thirds of "who was given what, and when".
 */
describe('naming the person a role assignment is about', () => {
  const USER = 'a0000000-0000-0000-0000-000000000002'
  const roleEvent = {
    event_id: 70, entity_type: 'user_roles', entity_id: USER, event_type: 'ROLE_GRANTED',
    timestamp: '2026-08-02T12:00:00Z', description: 'x', changed_by: null, actor_source: 'user',
    old_data: null, new_data: { role: 'Administrator', role_id: 1 },
  }

  const renderWith = (accounts) => {
    api.get.mockImplementation((p) =>
      Promise.resolve(String(p).startsWith('/api/v1/audit-trail') ? [roleEvent] : []))
    api.listUserAccounts.mockResolvedValue(accounts)
    render(<AuditTrailTab userRole="Administrator" />)
  }

  it('labels the lane with the person, not with the role they were granted', async () => {
    renderWith([{ user_id: USER, email: 'manager@aber.local' }])
    expect(await screen.findByText('manager@aber.local')).toBeInTheDocument()
    // The role is what HAPPENED to them; it is in the drawer, not in the lane's name.
    expect(screen.queryByText(/^Administrator$/)).toBeNull()
  })

  it('does not call the person deleted merely because the lane was named from a lookup', async () => {
    renderWith([{ user_id: USER, email: 'manager@aber.local' }])
    const lane = (await screen.findByText('manager@aber.local')).closest('.trail-lane')
    expect(within(lane).queryByText('deleted')).toBeNull()
  })

  it('falls back to the shortened id when the caller may not list accounts', async () => {
    /* A Shopfloor_Manager or Operator is REFUSED by 0116, and api.js rejects. They cannot see this
       lane either, so the fallback names nothing they were going to be shown -- but the page must
       still render rather than fail on the rejection. */
    api.get.mockImplementation((p) =>
      Promise.resolve(String(p).startsWith('/api/v1/audit-trail') ? [roleEvent] : []))
    api.listUserAccounts.mockRejectedValue(new Error('insufficient privileges'))
    render(<AuditTrailTab userRole="Administrator" />)

    expect(await screen.findByText('a0000000…0002')).toBeInTheDocument()
  })
})

import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { DigitalThreadTab } from '../components/tabs/DigitalThreadTab'
import {
  DIGITAL_THREAD_ENTITY_TYPES,
  DIGITAL_THREAD_SECURITY_ROLES,
  digitalThreadEntityTypesFor
} from '../constants'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const SECURITY_LABELS = ['Role assignments', 'Service identities', 'Settings']

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue([])
})

/**
 * The filter offers what the database will answer. `digital_thread_select_security` admits two
 * roles to the security domain; every other role that can read the thread sees the asset domain
 * only, and offering them Role assignments produced a filter that always read "no events".
 */
describe('which entity types a role is offered', () => {
  it('every kind names its audit domain', () => {
    for (const e of DIGITAL_THREAD_ENTITY_TYPES) expect(['asset', 'security']).toContain(e.domain)
  })

  it('the security kinds are exactly the three the policy guards', () => {
    const security = DIGITAL_THREAD_ENTITY_TYPES.filter(e => e.domain === 'security').map(e => e.label)
    expect(security.sort()).toEqual([...SECURITY_LABELS].sort())
  })

  it('mirrors the roles the SELECT policy admits, read from the migration', () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/0001_baseline_schema.sql'), 'utf8')
    const policy = sql.match(/CREATE POLICY digital_thread_select_security ON public\.digital_thread[^\n]*has_role\(ARRAY\[([^\]]+)\]/)
    expect(policy, 'the security policy has moved or been renamed').toBeTruthy()
    const roles = [...policy[1].matchAll(/'([A-Za-z_]+)'/g)].map(m => m[1]).sort()
    expect([...DIGITAL_THREAD_SECURITY_ROLES].sort()).toEqual(roles)
  })

  it('withholds the security kinds from a Shopfloor_Manager and an Operator', () => {
    for (const role of ['Shopfloor_Manager', 'Operator']) {
      const labels = digitalThreadEntityTypesFor(role).map(e => e.label)
      for (const l of SECURITY_LABELS) expect(labels, role).not.toContain(l)
      expect(labels).toContain('Devices')
    }
  })

  it('offers everything to the two audit roles, and while the role is still unknown', () => {
    for (const role of ['Administrator', 'Auditor', null, undefined]) {
      expect(digitalThreadEntityTypesFor(role)).toEqual(DIGITAL_THREAD_ENTITY_TYPES)
    }
  })
})

describe('the filter bar on the page', () => {
  const optionsOffered = async (userRole) => {
    render(<DigitalThreadTab userRole={userRole} />)
    const select = await screen.findByTitle('Show only events against one kind of asset')
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

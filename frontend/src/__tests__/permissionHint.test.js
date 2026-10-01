import { describe, it, expect } from 'vitest'
import { rolesHolding, requiresRolesTitle } from '../hooks/usePermissions'
import { PERMISSION_UUIDS } from '../constants'

// The hover text on a control the session may not use names the roles that hold its permission,
// from the same seeded grants the fallback map mirrors, rather than a hand-written "Admin".
describe('permission hints', () => {
  it('names every role that holds a permission, in words', () => {
    expect(rolesHolding(PERMISSION_UUIDS.DEVICE_MANAGE)).toEqual(['Administrator', 'Shopfloor Manager'])
  })

  it('reads as one sentence for one, two or more roles', () => {
    expect(requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)).toBe('Requires Administrator')
    expect(requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE)).toBe('Requires Administrator or Shopfloor Manager')
    expect(requiresRolesTitle(PERMISSION_UUIDS.TELEMETRY_READ))
      .toBe('Requires Administrator, Shopfloor Manager or Operator')
  })

  it('does not name a role for a permission nobody holds', () => {
    expect(requiresRolesTitle('not-a-permission')).toBe('Your role cannot do this')
  })
})

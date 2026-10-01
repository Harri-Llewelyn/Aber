/**
 * Whether this session may decide this kind of change, mirroring `may_decide_proposal()`. Every
 * live kind resolves to these two roles for a person; a decided-only schema row is false for
 * everybody. A mirror that is allowed to be wrong: the database decides again on every call.
 */
export function canDecide(entityType, userRole) {
  if (entityType === 'schemas') return false
  return userRole === 'Administrator' || userRole === 'Shopfloor_Manager'
}

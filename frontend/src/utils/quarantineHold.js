import { SCOPE_AREA_WIDE, SCOPE_CELL, SCOPE_GATEWAY, normaliseScope } from './cellResolution'

/*
 * What a hold says of a device in Quarantine: whether it was registered before, where its approval
 * starts, and which edge node it came through.
 */

/** Whether a device in Quarantine was registered before it was held, as the database wrote it (0328). */
export const isHeldAgain = (device) => Boolean(device?.requarantined_at)

/**
 * The location Approve & Onboard starts from: a registered device's own, so that an approval which
 * leaves the picker alone leaves the device where it is. A device nobody registered arrives following
 * its gateway.
 */
export function approvalLocation(item) {
  const scope = isHeldAgain(item) ? normaliseScope(item.location_scope) : SCOPE_GATEWAY
  return {
    location_scope: scope,
    cell_id: scope === SCOPE_CELL ? item.cell_id || '' : '',
    area_id: scope === SCOPE_AREA_WIDE ? item.area_id || '' : '',
  }
}

/**
 * The gateway Approve & Onboard starts from, among those it offers: the one the device is on. A device
 * nobody registered, held with none that is offered, takes the first that accepts a device; a registered
 * one is never moved to a gateway that nobody chose.
 */
export function approvalGatewayId(item, offered, accepts) {
  if (offered.some(g => g.gateway_id === item.gateway_id)) return item.gateway_id
  return isHeldAgain(item) ? '' : offered.find(accepts)?.gateway_id || ''
}

/** The edge node a GATEWAY_MISMATCH names, in each sentence of verify_gateway_binding() (mirror check 172). */
const CAME_THROUGH = /^GATEWAY_MISMATCH: .*(?:was published by|the publishing edge node) '([^']+)'/

/** The edge node the held message was published by, from the reason the daemon wrote, or null. */
export const cameThrough = (reason) => CAME_THROUGH.exec(reason ?? '')?.[1] ?? null

/**
 * Which gateway a device held for a GATEWAY_MISMATCH came through, and what approving it with another
 * does at its next birth, in one line for the gateway picker; null for any other hold, and for one that
 * came through the gateway the device is on now.
 */
export function cameThroughLine(item, gateways) {
  const node = cameThrough(item?.quarantine_reason)
  if (!node) return null
  const gateway = gateways.find(g => g.sparkplug_id === node)
  if (!gateway) return `It came through ${node}, which is not registered. With any gateway, it is held again.`
  if (gateway.is_archived) return `It came through ${gateway.gateway_name}, which is archived. Restore it first, or the device is held again.`
  if (gateway.gateway_id === item.gateway_id) return null
  return `It came through ${gateway.gateway_name}. If the device has moved there, choose it, or it is held again.`
}

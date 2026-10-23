import { SCOPE_AREA_WIDE, SOURCE_AREA_WIDE } from './cellResolution'
import { isShadowDevice } from './fleetCounts'

/**
 * Equipment in service: what every count of a place's devices and gateways counts, on the Cells,
 * Areas and Site Map pages, and what a schema's device count counts. Archived equipment is out of
 * service on purpose, and a replay lane is a recording of a device rather than equipment. A
 * quarantined device is in service: it is on the shopfloor, waiting to be admitted.
 */

/** A device in service: not archived, and not a replay lane. A quarantined device counts. */
export const isDeviceInService = (device) => !!device && !device.is_archived && !isShadowDevice(device)

/** A gateway in service: not archived. */
export const isGatewayInService = (gateway) => !!gateway && !gateway.is_archived

/**
 * The devices in service among `devices`. `replayLanes: true` keeps replay lanes in, for the
 * Gateways page, where they are what the Playback gateway serves; only archived devices leave.
 */
export function inServiceDevices(devices, { replayLanes = false } = {}) {
  return (devices || []).filter(d => (replayLanes ? !!d && !d.is_archived : isDeviceInService(d)))
}

/** The gateways in service among `gateways`. */
export function inServiceGateways(gateways) {
  return (gateways || []).filter(isGatewayInService)
}

/**
 * The equipment in service that belongs to a whole area rather than to a cell in it. A simulated
 * gateway's stored scope is inert, and the Playback gateway is in no area, so neither is here.
 */
export function areaWideInService(areaId, devices, gateways) {
  return {
    devices: inServiceDevices(devices)
      .filter(d => d.location_source === SOURCE_AREA_WIDE && d.effective_area_id === areaId),
    gateways: inServiceGateways(gateways)
      .filter(g => !g.is_simulated && !g.is_shadow && g.location_scope === SCOPE_AREA_WIDE && g.area_id === areaId)
  }
}

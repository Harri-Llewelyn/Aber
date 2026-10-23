/**
 * What keeps an area from being archived, as the database counts it (0199): every device and
 * gateway Area-Wide in the area, archived and quarantined ones included. The nightly purge cannot
 * delete an area one of them names, so the archive is refused rather than left to wait for good.
 * Cells do not count: archiving an area keeps its cells, and what is in them, where they are.
 */
export function areaWideIn(areaId, devices = [], gateways = []) {
  return {
    devices: devices.filter(d => d.area_id === areaId),
    gateways: gateways.filter(g => g.area_id === areaId)
  }
}

/** Why Archive Area is disabled, for its tooltip, or null when nothing is Area-Wide in the area. */
export function archiveRefusal({ devices = [], gateways = [] }) {
  const count = (n, kind) => n > 0 && `${n} Area-Wide ${kind}${n === 1 ? '' : 's'}`
  const held = [count(devices.length, 'device'), count(gateways.length, 'gateway')].filter(Boolean)
  if (held.length === 0) return null
  return `This area still holds ${held.join(' and ')}. Make each one Site-Wide or put it in a ` +
    'cell, or delete it, then archive the area. They are listed under Area-Wide Assets.'
}

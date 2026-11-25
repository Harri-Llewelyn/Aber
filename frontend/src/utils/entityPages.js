import {
  IconClipboardList, IconCpu, IconFactory, IconHardDrive, IconLayoutDashboard, IconLock, IconRadio, IconRecord, IconTag,
  IconUser, IconZap,
} from '../components/common/Icons'
import { entityUrl, findEntityUrl } from '../routes'

/** Each kind's own page, as `entityUrl` names the kind and as the rail names the page. */
export const ENTITY_PAGES = {
  areas: { type: 'area', page: 'Areas' },
  cells: { type: 'cell', page: 'Cells' },
  gateways: { type: 'gateway', page: 'Gateways' },
  devices: { type: 'device', page: 'Devices' },
  schemas: { type: 'schema', page: 'Schemas' },
  metric_catalog: { type: 'metric', page: 'Metrics' },
  automations: { type: 'automation', page: 'Automations' },
  captures: { type: 'capture', page: 'Capture' },
  backups: { type: 'backup', page: 'Backups' },
  service_principals: { type: 'identity', page: 'Access Control' },
  user_roles: { type: 'person', page: 'Access Control' },
}

/** Each kind's glyph, as its own page and the Audit Trail's sections draw it. */
export const KIND_ICONS = {
  areas: IconFactory,
  cells: IconLayoutDashboard,
  gateways: IconRadio,
  devices: IconCpu,
  schemas: IconClipboardList,
  metric_catalog: IconTag,
  automations: IconZap,
  captures: IconRecord,
  backups: IconHardDrive,
  service_principals: IconLock,
  user_roles: IconUser,
}

/**
 * Where the search bar opens a row: its own page where `pages` (visiblePages()) holds that page, else its
 * row on the Entities page, which every role may open. A deleted entity has no page of its own.
 */
export function recordUrl(row, pages) {
  const own = ENTITY_PAGES[row.kind]
  const mayOpen = Boolean(own) && pages.some(page => page.label === own.page)
  return (mayOpen && entityUrl(own.type, row.page_id, row.variant)) || findEntityUrl(row.id)
}

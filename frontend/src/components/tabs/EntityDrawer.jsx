import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { TABS, tabIsVisible } from '../../navigation'
import { areaUrl, automationsForEntityUrl, cellUrl, deviceUrl, entityUrl, gatewayUrl, trailUrl } from '../../routes'
import { entityWarnings, kindLabel, secondIdFields, variantBadge } from '../../utils/entities'
import { ENTITY_PAGES, KIND_ICONS } from '../../utils/entityPages'
import { Badge } from '../common/Badge'
import { ContextPanel } from '../common/ContextPanel'
import { RouteLink } from '../common/RouteLink'
import { IconCpu, IconFactory, IconHistory, IconLayoutDashboard, IconRadio, IconZap } from '../common/Icons'

/** A link to the entity this one is in or of, by name: none while the page holds no row for it. */
function PlaceChip({ to, icon, name, page }) {
  return (
    <RouteLink className="chip chip-link" to={to} title={`Open ${name} on the ${page} page`}>
      {icon}<span className="chip-name">{name}</span>
    </RouteLink>
  )
}

/**
 * One entity in service, on the Entities page: its id, its description, its kind, its name and its
 * further ids, where it is, and the way to its own page and its Audit Trail. It reads nothing about the
 * entity beyond its row, so it is the same for every kind; the entity's own page has the rest.
 *
 * @param {object|null} entity The row (utils/entities.js), or null while the drawer is closed.
 *
 * @param {Function} nameOf (kind, id) => the name of another entity the page holds, or undefined.
 *
 * @param {string} userRole With `hasPermission`, decides which pages this reader may open: the Access
 * Control page is an Administrator's, and an Auditor reads the people and identities on it here.
 */
export function EntityDrawer({ entity, nameOf, onClose, showToast, userRole, hasPermission }) {
  const canReadTrail = hasPermission(PERMISSION_UUIDS.AUDIT_TRAIL_READ)
  const Icon = entity ? KIND_ICONS[entity.kind] : null
  const kind = entity ? kindLabel(entity.kind) : ''
  const badge = variantBadge(entity)

  /* How many automations apply to a device, as its own drawer counts them. A failed read leaves the
     action without its count. Devices are the one kind an automation names (automations_for_entity()). */
  const deviceId = entity?.kind === 'devices' ? entity.id : null
  const [automationCount, setAutomationCount] = useState(null)
  useEffect(() => {
    setAutomationCount(null)
    if (!deviceId) return undefined
    let live = true
    Promise.resolve()
      .then(() => api.automationsForEntity(deviceId))
      .then(rows => { if (live && Array.isArray(rows)) setAutomationCount(new Set(rows.map(r => r.key)).size) }, () => {})
    return () => { live = false }
  }, [deviceId])

  const entityPage = entity ? ENTITY_PAGES[entity.kind] : null
  const pageUrl = entityPage ? entityUrl(entityPage.type, entity.page_id, entity.variant) : null
  const mayOpenPage = useMemo(() => {
    const page = TABS.find(t => t.label === entityPage?.page)
    return Boolean(page) && tabIsVisible(page, hasPermission, userRole)
  }, [entityPage, hasPermission, userRole])

  /** The chip for one place the row names, or nothing where the page does not hold that entity. */
  const place = (label, placeKind, id, url, page, icon) => {
    const name = id ? nameOf(placeKind, id) : undefined
    return name && { label, full: true, value: <PlaceChip to={url(id)} icon={icon} name={name} page={page} /> }
  }

  const isCapture = entity?.kind === 'captures'
  const fields = entity ? [
    { label: 'Kind', value: kind },
    { label: 'Name', value: entity.name },
    ...secondIdFields(entity).map(f => ({ ...f, mono: true, copyable: true, full: true })),
    place('Recorded Device', 'devices', entity.device_id, deviceUrl, 'Devices', <IconCpu size={11} />),
    place(isCapture ? 'Recorded Gateway' : 'Serving Gateway', 'gateways', entity.gateway_id, gatewayUrl, 'Gateways', <IconRadio size={11} />),
    place('Cell', 'cells', entity.cell_id, cellUrl, 'Cells', <IconLayoutDashboard size={11} />),
    place('Area', 'areas', entity.area_id, areaUrl, 'Areas', <IconFactory size={11} />),
  ].filter(Boolean) : []

  return (
    <ContextPanel
      open={Boolean(entity)}
      onClose={onClose}
      type={kind}
      onCopy={showToast}
      title={entity?.name || ''}
      icon={Icon && <Icon size={16} />}
      subtitle={entity && (
        <>
          <Badge size="sm">{kind}</Badge>
          {badge && <Badge size="sm" tone={badge.tone} title={badge.title}>{badge.label}</Badge>}
        </>
      )}
      warnings={entityWarnings(entity)}
      recordId={entity && { label: `${kind} UUID`, value: entity.id }}
      description={entity && entity.kind !== 'user_roles' ? { value: entity.description } : null}
      fields={fields}
      actions={entity ? [
        pageUrl && mayOpenPage && {
          label: `View in ${entityPage.page}`, icon: Icon && <Icon size={13} />,
          primary: true,
          to: entityUrl(entityPage.type, entity.page_id, entity.variant),
          title: `Open ${entity.name} on the ${entityPage.page} page`,
        },
        canReadTrail && {
          label: 'View in Audit Trail', icon: <IconHistory size={13} />,
          to: trailUrl(entity.id, entity.kind),
          title: 'Open the immutable audit trace for this entity',
        },
        /* Every role reads automations, so nothing here is gated, as on the device's own drawer. */
        deviceId && {
          label: automationCount === null ? 'View in Automations' : `View in Automations (${automationCount})`,
          icon: <IconZap size={13} />,
          to: automationsForEntityUrl(deviceId),
          title: 'Open the Automations page on the automations that apply to this device, and why',
        },
      ].filter(Boolean) : []}
    />
  )
}

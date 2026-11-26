import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { TABS, tabIsVisible } from '../../navigation'
import { areaUrl, automationsForEntityUrl, cellUrl, deviceUrl, entityUrl, gatewayUrl, trailUrl } from '../../routes'
import { entityWarnings, kindLabel, purgeWarning, secondIdFields, variantBadge } from '../../utils/entities'
import { ENTITY_PAGES, KIND_ICONS } from '../../utils/entityPages'
import { formatDate, formatDateTime } from '../../utils/format'
import { ArchivedBadge, Badge } from '../common/Badge'
import { ContextPanel } from '../common/ContextPanel'
import { gatewayRepositoryUrl } from '../common/GatewayRepositoryPanel'
import { PersonName } from '../common/PersonName'
import { RouteLink } from '../common/RouteLink'
import { Tooltip } from '../common/Tooltip'
import {
  IconCpu, IconDownload, IconExternalLink, IconFactory, IconGitBranch, IconHistory, IconLayoutDashboard, IconRadio, IconRefreshCw, IconTrash,
  IconZap,
} from '../common/Icons'

/** A link to the entity this one is in or of, by name: none while the page holds no row for it. */
function PlaceChip({ to, icon, name, page }) {
  return (
    <RouteLink className="chip chip-link" to={to} title={`Open ${name} on the ${page} page`}>
      {icon}<span className="chip-name">{name}</span>
    </RouteLink>
  )
}

/**
 * What survives a retired entity, as links: its Audit Trail for who may read it, a gateway's repository in
 * the forge, and each bundle taken while it was alive. Read from the tombstone's row and its exports.
 */
function WhatSurvives({ entity, canReadTrail, onDownload }) {
  const hasRepository = entity.kind === 'gateways' && entity.old_data?.forge_repository_at && entity.sparkplug_id
  const bundles = entity.exports || []
  if (!canReadTrail && !hasRepository && bundles.length === 0) return null
  return (
    <div>
      <div className="context-panel-section-label">What Survives</div>
      <div className="context-buttons">
        {canReadTrail && (
          <RouteLink
            className="btn btn-ghost btn-sm context-action"
            to={trailUrl(entity.id, entity.kind, true)}
            title="Open this entity's audit trace on the Audit Trail page, deleted entities shown"
          >
            <IconHistory size={13} /> View in Audit Trail
          </RouteLink>
        )}
        {hasRepository && (
          <Tooltip text="Its repository in the forge: archived, read-only, every branch and wiki page kept">
            <a
              className="btn btn-ghost btn-sm context-action"
              href={gatewayRepositoryUrl({ sparkplug_id: entity.sparkplug_id })}
              target="_blank"
              rel="noopener noreferrer"
            >
              <IconGitBranch size={13} /> Forge Repository <IconExternalLink size={10} />
            </a>
          </Tooltip>
        )}
        {bundles.map(x => (
          <Tooltip key={x.id} text={`The bundle taken ${formatDateTime(x.taken_at)}${x.taken_by_email ? ` by ${x.taken_by_email}` : ''}: shell, audit trail, live telemetry and the cold-object manifest`}>
            <button type="button" className="btn btn-ghost btn-sm context-action" onClick={() => onDownload(x)}>
              <IconDownload size={13} /> Bundle {formatDate(x.taken_at)}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

/** Who deleted a retired entity: a person, a machine identity by its id, or nobody. */
function retiredBy(entity) {
  if (entity.retired_by_email) return { value: <PersonName name={entity.retired_by_name} email={entity.retired_by_email} stacked /> }
  if (entity.retired_by) return { value: entity.retired_by, mono: true, copyable: true }
  return { value: 'Retention timer' }
}

/**
 * One entity, on the Entities page: its id, its description, its kind, its name and its further ids, where
 * it is, and the way to its own page and its Audit Trail. It reads nothing about the entity beyond its
 * row, so it is the same for every kind; the entity's own page has the rest.
 *
 * Its state decides the rest. One in service offers its own page first. An archived one says when its
 * auto-purge is, offers Restore first and Permanent Delete last, and opens its page with the lifecycle
 * filter on Archived. A retired one has no page and no acts: it says when it went, and links to what survives it.
 *
 * @param {object|null} entity The row (utils/entities.js), or null while the drawer is closed.
 *
 * @param {Function} nameOf (kind, id) => the name of another entity the page holds, or undefined.
 *
 * @param {object|null} lastExport The newest bundle of an archived device, or null.
 *
 * @param {Function} onRestore, onExport, onPurge Open an archived entity's dialogs, with its row.
 *
 * @param {Function} onDownload Downloads one of a retired entity's bundles.
 *
 * @param {string} userRole With `hasPermission`, decides which pages this reader may open: the Access
 * Control page is an Administrator's, and an Auditor reads the people and identities on it here.
 */
export function EntityDrawer({ entity, nameOf, lastExport = null, onRestore, onExport, onPurge, onDownload, onClose, showToast, userRole, hasPermission }) {
  const canReadTrail = hasPermission(PERMISSION_UUIDS.AUDIT_TRAIL_READ)
  const canArchive = hasPermission(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  const deniedTitle = requiresRolesTitle(PERMISSION_UUIDS.ARCHIVE_MANAGE)
  const Icon = entity ? KIND_ICONS[entity.kind] : null
  const kind = entity ? kindLabel(entity.kind) : ''
  const badge = variantBadge(entity)
  const archived = entity?.state === 'archived'
  const retired = entity?.state === 'retired'

  /* How many automations apply to a device in service, as its own drawer counts them. A failed read leaves
     the action without its count. Devices are the one kind an automation names (automations_for_entity()). */
  const deviceId = entity?.kind === 'devices' && entity.state === 'active' ? entity.id : null
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
  const pageUrl = entityPage ? entityUrl(entityPage.type, entity.page_id, entity.variant, entity.state) : null
  const mayOpenPage = useMemo(() => {
    const page = TABS.find(t => t.label === entityPage?.page)
    return Boolean(page) && tabIsVisible(page, hasPermission, userRole)
  }, [entityPage, hasPermission, userRole])

  /** The chip for one place the row names, or nothing where the page does not hold that entity. */
  const place = (label, placeKind, id, url, page, icon) => {
    const name = id ? nameOf(placeKind, id) : undefined
    return name && { label, full: true, value: <PlaceChip to={url(id)} icon={icon} name={name} page={page} /> }
  }

  /** A further id. The historian still keys a retired entity's readings by its Sparkplug id. */
  const furtherId = (field) => ({
    ...field,
    mono: true,
    copyable: true,
    full: true,
    ...(retired && field.value === entity.sparkplug_id
      && { help: 'The Historian ID in the table: its readings are still stored under it, until retention or cold storage takes them.' }),
  })

  const isCapture = entity?.kind === 'captures'
  const fields = entity ? [
    { label: 'Kind', value: kind },
    { label: 'Name', value: entity.name },
    ...secondIdFields(entity).map(furtherId),
    place('Recorded Device', 'devices', entity.device_id, deviceUrl, 'Devices', <IconCpu size={11} />),
    place(isCapture ? 'Recorded Gateway' : 'Serving Gateway', 'gateways', entity.gateway_id, gatewayUrl, 'Gateways', <IconRadio size={11} />),
    place('Cell', 'cells', entity.cell_id, cellUrl, 'Cells', <IconLayoutDashboard size={11} />),
    place('Area', 'areas', entity.area_id, areaUrl, 'Areas', <IconFactory size={11} />),
    (archived || retired) && { label: 'Archived At', value: entity.archived_at && formatDateTime(entity.archived_at) },
    // Held, or due within a week, it is one of the warnings.
    archived && !purgeWarning(entity)
      && { label: 'Auto-Purge', value: entity.auto_delete_at ? formatDate(entity.auto_delete_at) : 'Never auto-purged' },
    archived && lastExport && { label: 'Last Bundle', value: formatDateTime(lastExport.taken_at) },
    retired && { label: 'Retired At', value: formatDateTime(entity.retired_at) },
    retired && { label: 'Retired By', full: true, ...retiredBy(entity) },
  ].filter(Boolean) : []

  return (
    <ContextPanel
      open={Boolean(entity)}
      onClose={onClose}
      type={kind}
      onCopy={showToast}
      title={entity ? entity.name || entity.id : ''}
      icon={Icon && <Icon size={16} />}
      subtitle={entity && (
        <>
          <Badge size="sm">{kind}</Badge>
          {archived && <ArchivedBadge size="sm" title="Archived: out of service. Restore it below." />}
          {retired && <Badge size="sm" icon={<IconTrash size={11} />} title="Retired: deleted, and this record of it is what is left">Retired</Badge>}
          {badge && <Badge size="sm" tone={badge.tone} title={badge.title}>{badge.label}</Badge>}
        </>
      )}
      warnings={entityWarnings(entity)}
      recordId={entity && { label: `${kind} UUID`, value: entity.id }}
      description={entity && entity.kind !== 'user_roles' ? { value: entity.description } : null}
      fields={fields}
      beforeActions={retired ? <WhatSurvives entity={entity} canReadTrail={canReadTrail} onDownload={onDownload} /> : null}
      actions={entity && !retired ? [
        archived && {
          label: 'Restore', icon: <IconRefreshCw size={13} />,
          primary: true,
          onClick: () => onRestore(entity),
          disabled: !canArchive,
          title: canArchive ? `Restore this ${kind.toLowerCase()} to active service` : deniedTitle,
        },
        pageUrl && mayOpenPage && {
          label: `View in ${entityPage.page}`, icon: Icon && <Icon size={13} />,
          primary: !archived,
          to: entityUrl(entityPage.type, entity.page_id, entity.variant, entity.state),
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
        // What to do before the delete, where a device's record and readings are to leave with it.
        archived && entity.kind === 'devices' && {
          label: 'Export Bundle…', icon: <IconDownload size={13} />,
          onClick: () => onExport(entity),
          disabled: !canArchive,
          title: canArchive ? 'An AASX bundle of its shell, audit trail and live telemetry, with a copy kept beside the cold tier' : deniedTitle,
        },
        archived && {
          label: 'Permanent Delete', icon: <IconTrash size={13} />,
          danger: true,
          onClick: () => onPurge(entity),
          disabled: !canArchive,
          title: canArchive ? 'Delete the record for good. It asks for the name first' : deniedTitle,
        },
      ].filter(Boolean) : []}
    />
  )
}

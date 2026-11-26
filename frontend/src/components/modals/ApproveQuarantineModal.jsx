import React, { useState } from 'react'
import { Callout } from '../common/Callout'
import CopyableId from '../common/CopyableId'
import { ActionButton } from '../common/ActionButton'
import { FieldError } from '../common/FieldError'
import { LocationPicker, locationIncomplete } from '../common/LocationPicker'
import { IconShieldAlert, IconAlertTriangle } from '../common/Icons'
import { Modal } from '../common/Modal'
import { ConfirmModal } from './ConfirmModal'
import { useFormCheck } from '../../hooks/useFormCheck'
import { usePendingAction } from '../../hooks/usePendingAction'
import { gatewayAcceptsDevices } from '../../utils/gatewayType'
import { HELD_AGAIN_APPROVAL, approvalGatewayId, approvalLocation, cameThroughLine, isHeldAgain } from '../../utils/quarantineHold'
import {
  SCOPE_GATEWAY, SCOPE_CELL, SCOPE_AREA_WIDE, SCOPE_SITE_WIDE, SOURCE_UNASSIGNED, followedPlaceFix, followedPlaceLine, resolveDeviceLocation
} from '../../utils/cellResolution'

export function ApproveQuarantineModal({ item, cells, gateways, areas = [], suggestion, onApprove, onMerge, onCancel }) {
  const [busy, runBusy] = usePendingAction()
  // A refusal from approve-quarantine, as it worded it. The dialog stays open on one. A refused
  // merge is shown in Accept match's own question.
  const [error, setError] = useState(null)
  // The device Accept Match asks about. Nothing is merged until the question is answered, and it goes
  // if that device is no longer the one suggested, as when it has sent its own first birth since.
  const [acceptingId, setAcceptingId] = useState(null)
  const accepting = !!suggestion && suggestion.candidateId === acceptingId

  const isGateway = item.entity_type === 'GATEWAY'
  const [assetName, setAssetName] = useState(item.asset_name)
  // The gateway it is on, which for a device nobody registered is the one it arrived through. An
  // archived gateway is never the default: the picker leaves it out, and the database refuses it.
  const offered = gateways.filter(g => !g.is_archived)
  const [gatewayId, setGatewayId] = useState(() => approvalGatewayId(item, offered, gatewayAcceptsDevices))
  // The picker stays on the gateway the device is bound to, whichever it came through: a message for it
  // through another is also what a forged one looks like, so moving it is the operator's to choose.
  const throughLine = cameThroughLine(item, gateways)

  // The location is chosen here because the operator is already looking at the device. The same
  // picker as the Devices form: a device nobody registered follows its gateway unless told otherwise,
  // and one held again starts from its own place.
  const [location, setLocation] = useState(() => approvalLocation(item))
  const scope = location.location_scope
  const cellId = scope === SCOPE_CELL ? location.cell_id : ''

  const selectedGateway = gateways.find(g => g.gateway_id === gatewayId)
  const chosenAreaName = areas.find(a => a.area_id === location.area_id)?.area_name

  // Where Follow Gateway puts the device once approved, in the Devices form's words. A gateway with
  // no location, or none at all, leaves the device Unassigned, which the operator is told now.
  const followedLine = followedPlaceLine(selectedGateway, { cells, areas })
  const willBeUnassigned = scope === SCOPE_GATEWAY &&
    resolveDeviceLocation({ location_scope: SCOPE_GATEWAY }, selectedGateway).location_source === SOURCE_UNASSIGNED

  // Area-Wide with no area named and In a cell with no cell would be refused by the database.
  const check = useFormCheck({
    location: {
      id: scope === SCOPE_AREA_WIDE ? 'approve-area' : 'approve-cell',
      missing: !isGateway && locationIncomplete(location, { cellRequired: true })
        && (scope === SCOPE_AREA_WIDE ? 'Choose which area the device serves' : 'Choose which cell the device is in'),
    },
  })

  const handleSave = () => runBusy(async () => {
    setError(null)
    try {
      await onApprove(item.asset_id, {
        asset_name: assetName,
        active_gateway_id: gatewayId,
        cell_id: cellId,
        area_id: scope === SCOPE_AREA_WIDE ? location.area_id : '',
        location_scope: scope
      })
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title="Approve & Onboard"
      subject={item.asset_name}
      icon={<IconShieldAlert size={18} />}
      size="md"
      busy={busy}
      onClose={onCancel}
      lead={isGateway
        ? 'Admits a gateway nobody has registered, under the name and in the place chosen here.'
        : isHeldAgain(item)
          ? 'Admits again a registered device that Quarantine held, under the name and in the place chosen here.'
          : 'Admits a device nobody has registered, under the name and in the place chosen here.'}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={
        <ActionButton pending={busy} pendingLabel="Approving…" onClick={() => check.press(handleSave)}>
          Approve &amp; Onboard
        </ActionButton>
      }
    >
      {/* What the device put on the wire, and why it was held. For a malformed identifier this is
          the whole diagnosis. */}
      <div className="form-group">
        <label className="form-label">Published Sparkplug ID</label>
        <CopyableId value={item.reported_identity} label="published device id" />
        <FieldError error={item.quarantine_reason} />
      </div>

      {!isGateway && suggestion && (
        <Callout tone="warning" title={<>This looks like it might be <span className="mono">{suggestion.candidateName}</span></>}>
          <div className="form-hint">
            A provisioned device awaiting its first birth ({suggestion.evidence}). If this is the
            same machine publishing under another ID, accepting the match keeps that device's
            existing configuration and deletes this quarantined duplicate, rather than approving it
            as a brand new device. It asks first.
          </div>
          <ActionButton
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => setAcceptingId(suggestion.candidateId)}
            title="Merge this quarantined device into the suggested provisioned device"
          >
            Accept Match
          </ActionButton>
        </Callout>
      )}

      {/* Inside this dialog, so it opens over it and Escape closes it first. What it says carries over
          is what approve_quarantined_device() writes on the device that is kept (drift check 573). */}
      {accepting && (
        <ConfirmModal
          title="Accept Match"
          subject={item.asset_name}
          icon={<IconShieldAlert size={18} />}
          message={
            `Merge the quarantined device '${item.asset_name}'` +
            (item.reported_identity ? ` (published as ${item.reported_identity})` : '') +
            ` into '${suggestion.candidateName}'? '${suggestion.candidateName}' is kept, and the quarantined device is deleted.`
          }
          confirmLabel="Accept Match"
          pendingLabel="Merging…"
          onConfirm={() => onMerge(item.asset_id, suggestion.candidateId)}
          onCancel={() => setAcceptingId(null)}
        >
          <p className="form-hint">
            <strong>Carried over:</strong> the ID it publishes under, its status, the time of its first
            birth, and the values its birth announced. {`Its messages then arrive as '${suggestion.candidateName}'.`}
          </p>
          <p className="form-hint">
            <strong>Not carried over:</strong> its name, gateway, location and schemas, and anything else
            set on it, such as a nameplate, links or captures. These are deleted with it. Readings already
            recorded for it do not move.
          </p>
          <p className="form-hint">
            {`'${suggestion.candidateName}' keeps its own gateway. If the device publishes through another, it is held in Quarantine again.`}
          </p>
        </ConfirmModal>
      )}

      {/* A registered device held again: approving is its way out, as its row says. */}
      {!isGateway && isHeldAgain(item) && <p className="form-hint">{HELD_AGAIN_APPROVAL}</p>}

      <div className="form-group">
        <label className="form-label" htmlFor="approve-name">{isGateway ? 'Gateway Name' : 'Device Name'}</label>
        <input id="approve-name" className="form-control" value={assetName} onChange={e => setAssetName(e.target.value)} />
      </div>

      {/* A gateway needs nothing further here. A device still needs its serving gateway and its
          location. */}
      {!isGateway && (
        <>
          <div className="form-group">
            <label className="form-label" htmlFor="approve-gateway">Serving Gateway</label>
            <select id="approve-gateway" className="form-control" value={gatewayId} onChange={e => setGatewayId(e.target.value)} aria-describedby={throughLine ? 'approve-gateway-hint' : undefined}>
              <option value="">— Unassigned Gateway —</option>
              {/* Disabled rather than absent, as at the Devices form's picker: a replay lane is
                  minted by a playback, never approved onto. */}
              {offered.map(g => (
                <option key={g.gateway_id} value={g.gateway_id} disabled={!gatewayAcceptsDevices(g)}>
                  {g.gateway_name} — {g.status}
                  {gatewayAcceptsDevices(g) ? '' : ' — replay lane, not assignable'}
                </option>
              ))}
            </select>
            {throughLine && (
              <div id="approve-gateway-hint" className="form-hint hint-warning">
                <IconAlertTriangle size={12} /> {throughLine}
              </div>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">Location</label>
            <LocationPicker
              idPrefix="approve"
              form={location}
              onChange={fields => setLocation(l => ({ ...l, ...fields }))}
              cells={cells}
              areas={areas}
              followGateway
              cellEmptyLabel="— Choose a cell —"
              error={check.errors.location}
            />

            {willBeUnassigned ? (
              <div className="form-hint hint-warning">
                <IconAlertTriangle size={12} /> {followedLine}. {followedPlaceFix(selectedGateway)}
              </div>
            ) : (
              <div className="form-hint">
                {scope === SCOPE_GATEWAY
                  ? `${followedLine}. It moves when the gateway does.`
                  : scope === SCOPE_SITE_WIDE
                    ? 'Reported as Site-Wide rather than under any cell.'
                    : scope === SCOPE_AREA_WIDE
                      ? `Reported as Area-Wide in ${chosenAreaName || 'the chosen area'} rather than under any cell in it.`
                      : cellId
                        ? 'Set on this device — it stays put even if the gateway is reassigned.'
                        : 'Choose the cell this device is in, or use Follow Gateway to take its gateway’s place.'}
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

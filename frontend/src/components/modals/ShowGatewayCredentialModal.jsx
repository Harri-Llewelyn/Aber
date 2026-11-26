import React, { useCallback, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Callout } from '../common/Callout'
import { CopyField } from '../common/CopyField'
import { Modal } from '../common/Modal'
import { IconEye } from '../common/Icons'
import { NodeRedCredentialSteps } from './GatewayCredentialModal'
import { EdgeNodeSettings } from './EdgeNodeSettings'
import { gatewayUrl } from '../../routes'

/**
 * Show a Host, Simulated or Third-party gateway's broker credential again, for an Administrator who
 * has lost it (0164). A Third-party gateway's comes with every setting its edge node needs. Nothing is fetched until they ask, because each showing is a CREDENTIAL_SHOWN row in the
 * Audit Trail. The password lives in this component's state until the modal closes.
 */
export function ShowGatewayCredentialModal({ gateway, onClose, showToast }) {
  const [credential, setCredential] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const show = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setCredential(await api.showGatewayCredential(gateway.gateway_id))
      showToast?.(`Broker credential shown for '${gateway.gateway_name}'`, 'success', { to: gatewayUrl(gateway.gateway_id) })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [gateway, showToast])

  return (
    <Modal
      title={<>Broker Credential for “{gateway.gateway_name}”</>}
      size="lg"
      busy={busy}
      onClose={onClose}
      error={error}
      dismiss={credential ? 'Done' : 'Cancel'}
      footer={credential ? null : (
        <ActionButton pending={busy} pendingLabel="Showing…" className="btn btn-primary" onClick={show}>
          <IconEye size={14} /> Show Credential
        </ActionButton>
      )}
    >
      {!credential ? (
        <Callout tone="info" title="Show this gateway’s broker password?">
          It is the password last issued to this gateway. Showing it is recorded in the Audit
          Trail under your name. Nothing about the gateway changes.
        </Callout>
      ) : gateway.deployment === 'third_party' ? (
        <EdgeNodeSettings gateway={gateway} credential={credential} />
      ) : (
        <>
          <CopyField id="gateway-username" label="MQTT Username" value={credential.mqtt_username} copyLabel="username" />
          <CopyField id="gateway-password" label="Password" value={credential.password} />

          <NodeRedCredentialSteps />
        </>
      )}
    </Modal>
  )
}

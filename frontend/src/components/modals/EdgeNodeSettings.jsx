import React, { useEffect, useState } from 'react'
import { api } from '../../api'
import { CopyField } from '../common/CopyField'
import { IconDownload, IconExternalLink } from '../common/Icons'
import { Tooltip } from '../common/Tooltip'
import {
  BRING_YOUR_OWN_EDGE_NODE, ROOT_CERTIFICATE_PATH, brokerAddress, brokerRow, helpSourceUrl,
  primaryHostId,
} from '../../utils/edgeNodeSettings'

/**
 * The broker as its `directory_services` row publishes it, read when shown: undefined while it is
 * read, null when the read failed, otherwise `brokerAddress()`'s answer. A failed read is said,
 * not guessed.
 */
export function useDirectoryBroker() {
  const [broker, setBroker] = useState(undefined)
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => api.get('/api/v1/directory'))
      .then(rows => { if (!cancelled) setBroker(brokerAddress(brokerRow(rows)?.endpoint_url)) })
      .catch(() => { if (!cancelled) setBroker(null) })
    return () => { cancelled = true }
  }, [])
  return broker
}

/**
 * Everything a Third-party gateway's edge node is configured with, in the order a node's own
 * settings ask for it. Shared by the issue and show-again dialogs, so both say the same thing.
 */
export function EdgeNodeSettings({ gateway, credential }) {
  const broker = useDirectoryBroker()
  const sparkplugId = credential?.mqtt_username || gateway.sparkplug_id
  const hostId = primaryHostId()
  const rootUrl = `${window.location.origin}${ROOT_CERTIFICATE_PATH}`

  return (
    <>
      <div className="gateway-settings">
        <CopyField
          id="edge-broker-host"
          label="Broker Address"
          value={broker?.host}
          copyLabel="broker address"
          warning={broker === null
            ? 'The broker address could not be read, so it is not shown. The System page lists it.'
            : broker?.problem}
        />
        <CopyField
          id="edge-broker-port"
          label={broker && !broker.tls ? 'Port' : 'TLS Port'}
          value={broker?.port}
          copyLabel="port"
          hint={broker && !broker.tls
            ? 'This broker is published without TLS, so the node connects in plain MQTT.'
            : 'MQTT over TLS.'}
        />
        <CopyField
          id="edge-username"
          label="Username"
          value={credential.mqtt_username}
          copyLabel="username"
        />
        <CopyField
          id="edge-password"
          label="Password"
          value={credential.password}
          copyLabel="password"
        />
        <CopyField
          id="edge-node-id"
          label="Edge Node ID"
          value={sparkplugId}
          copyLabel="edge node ID"
          hint="The same as the username. The broker drops anything published under another edge node ID."
        />
        <CopyField
          id="edge-group"
          label="Sparkplug Group"
          value={gateway.sparkplug_group}
          copyLabel="Sparkplug group"
          warning={gateway.sparkplug_group ? null : 'Not known here: the gateway’s drawer shows it in its topic path.'}
        />
        <CopyField
          id="edge-primary-host"
          label="Primary Host ID"
          value={hostId}
          copyLabel="primary host ID"
          hint={hostId
            ? <>The node watches <span className="mono">spBv1.0/STATE/{hostId}</span>, and sends its birth only while Aber says it is online.</>
            : null}
          warning={hostId
            ? null
            : <>Not supplied to this dashboard. It is <span className="mono">ingestion.primaryHostId</span> in Aber’s Helm values.</>}
        />
        <CopyField
          id="edge-root"
          label="Root Certificate"
          value={rootUrl}
          copyLabel="the root certificate’s address"
          hint={<>
            The node trusts this root to check the broker’s certificate. It is public. It is the
            same file as step 8 of the install guide.
          </>}
        >
          <Tooltip text="Download the root certificate">
            <a
              className="btn btn-ghost btn-icon"
              href={ROOT_CERTIFICATE_PATH}
              download="aber-root-ca.pem"
              aria-label="Download the root certificate"
            >
              <IconDownload size={13} />
            </a>
          </Tooltip>
        </CopyField>
      </div>
      <p className="form-hint gateway-settings-help">
        What the node must do is on the help page{' '}
        <a
          data-help={BRING_YOUR_OWN_EDGE_NODE}
          href={helpSourceUrl(BRING_YOUR_OWN_EDGE_NODE)}
          target="_blank"
          rel="noreferrer"
        >
          Bringing your own edge node <IconExternalLink size={10} />
        </a>. Meeting it is the engineer’s responsibility: Aber does not test or certify the node.
      </p>
    </>
  )
}

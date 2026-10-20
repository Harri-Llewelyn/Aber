import React, { useEffect, useState } from 'react'
import { api } from '../../api'
import { IconCheck, IconCopy, IconDownload, IconExternalLink } from '../common/Icons'
import {
  BRING_YOUR_OWN_EDGE_NODE, ROOT_CERTIFICATE_PATH, brokerAddress, brokerRow, helpSourceUrl,
  primaryHostId,
} from '../../utils/edgeNodeSettings'

/** One value the engineer types into the node, with its copy button. */
function Setting({ id, label, value, copyLabel, copy, copied, hint, warning }) {
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>{label}</label>
      <div className="gateway-copy-row">
        <input id={id} className="form-control mono" readOnly value={value || ''} />
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => copy(id, value)}
          disabled={!value}
          title={`Copy ${copyLabel}`}
          aria-label={`Copy ${copyLabel}`}
        >
          {copied === id ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </button>
      </div>
      {warning && <div className="form-hint hint-warning">{warning}</div>}
      {hint && <div className="form-hint">{hint}</div>}
    </div>
  )
}

/**
 * Everything a Third-party gateway's edge node is configured with, in the order a node's own
 * settings ask for it. Shared by the issue and show-again dialogs, so both say the same thing.
 * `copy(id, value)` and `copied` are the dialog's, so a refused copy is reported in one place.
 */
export function EdgeNodeSettings({ gateway, credential, copy, copied }) {
  const [broker, setBroker] = useState(undefined)

  // The Directory's broker row. Read when shown; an unreadable Directory is said, not guessed.
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => api.get('/api/v1/directory'))
      .then(rows => { if (!cancelled) setBroker(brokerAddress(brokerRow(rows)?.endpoint_url)) })
      .catch(() => { if (!cancelled) setBroker(null) })
    return () => { cancelled = true }
  }, [])

  const sparkplugId = credential?.mqtt_username || gateway.sparkplug_id
  const hostId = primaryHostId()
  const rootUrl = `${window.location.origin}${ROOT_CERTIFICATE_PATH}`

  return (
    <>
      <div className="gateway-settings">
        <Setting
          id="edge-broker-host"
          label="Broker address"
          value={broker?.host}
          copyLabel="broker address"
          copy={copy}
          copied={copied}
          warning={broker === null
            ? 'The Directory could not be read, so the broker address is not shown. The Directory page lists it.'
            : broker?.problem}
        />
        <Setting
          id="edge-broker-port"
          label={broker && !broker.tls ? 'Port' : 'TLS port'}
          value={broker?.port}
          copyLabel="port"
          copy={copy}
          copied={copied}
          hint={broker && !broker.tls
            ? 'This broker is published without TLS, so the node connects in plain MQTT.'
            : 'MQTT over TLS.'}
        />
        <Setting
          id="edge-username"
          label="Username"
          value={credential.mqtt_username}
          copyLabel="username"
          copy={copy}
          copied={copied}
        />
        <Setting
          id="edge-password"
          label="Password"
          value={credential.password}
          copyLabel="password"
          copy={copy}
          copied={copied}
        />
        <Setting
          id="edge-node-id"
          label="Edge node ID"
          value={sparkplugId}
          copyLabel="edge node ID"
          copy={copy}
          copied={copied}
          hint="The same as the username. The broker drops anything published under another edge node ID."
        />
        <Setting
          id="edge-group"
          label="Sparkplug group"
          value={gateway.sparkplug_group}
          copyLabel="Sparkplug group"
          copy={copy}
          copied={copied}
          warning={gateway.sparkplug_group ? null : 'Not known here: the gateway’s drawer shows it in its topic path.'}
        />
        <Setting
          id="edge-primary-host"
          label="Primary host ID"
          value={hostId}
          copyLabel="primary host ID"
          copy={copy}
          copied={copied}
          hint={hostId
            ? <>The node watches <span className="mono">spBv1.0/STATE/{hostId}</span>, and sends its birth only while Aber says it is online.</>
            : null}
          warning={hostId
            ? null
            : <>Not supplied to this dashboard. It is <span className="mono">ingestion.primaryHostId</span> in Aber’s Helm values.</>}
        />
        <div className="form-group">
          <label className="form-label" htmlFor="edge-root">Root certificate</label>
          <div className="gateway-copy-row">
            <input id="edge-root" className="form-control mono" readOnly value={rootUrl} />
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => copy('edge-root', rootUrl)}
              title="Copy the root certificate’s address"
              aria-label="Copy the root certificate’s address"
            >
              {copied === 'edge-root' ? <IconCheck size={13} /> : <IconCopy size={13} />}
            </button>
            <a
              className="btn btn-ghost btn-icon"
              href={ROOT_CERTIFICATE_PATH}
              download="aber-root-ca.pem"
              title="Download the root certificate"
              aria-label="Download the root certificate"
            >
              <IconDownload size={13} />
            </a>
          </div>
          <div className="form-hint">
            The node trusts this root to check the broker’s certificate. It is public. It is the
            same file as step 8 of the install guide.
          </div>
        </div>
      </div>
      <p className="form-hint">
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

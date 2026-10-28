/**
 * What the engineer of a Third-party gateway configures on its edge node, from where the dashboard
 * already learns each value: the broker from its `directory_services` row (db-init writes it from
 * the chart's public broker address, the one an appliance is handed), the primary host id from the
 * runtime config, and the root certificate from the path the dashboard's own host serves it at.
 */
import { readSetting } from '../config'
import { GITHUB_REPO_URL } from '../constants'
import { APP_VERSION } from '../version'

/** The broker's `directory_services` row (0002). db-init keeps it to the published broker. */
export const BROKER_DIRECTORY_ID = 'f1111111-0000-0000-0000-000000000004'

/** The names publicAddresses.ts refuses for MQTT_PUBLIC_HOST: they resolve only inside Aber. */
const IN_STACK_HOSTS = new Set(['mosquitto', 'localhost', '127.0.0.1', '::1', '[::1]', 'supabase-envoy'])

/**
 * The broker's row out of a `/api/v1/directory` listing: by its id, else the only
 * MQTT_BROKER row. Null when neither is there.
 */
export function brokerRow(services) {
  const rows = services || []
  const byId = rows.find(s => s.service_uuid === BROKER_DIRECTORY_ID)
  if (byId) return byId
  const brokers = rows.filter(s => s.service_type === 'MQTT_BROKER')
  return brokers.length === 1 ? brokers[0] : null
}

/**
 * The broker as an edge node dials it, from its row's URL such as `mqtts://mqtt.plant:8883`:
 * `{ host, port, tls, problem }`, with `problem` a sentence when the node could not use it. Null
 * when there is no URL.
 */
export function brokerAddress(endpointUrl) {
  if (!endpointUrl) return null
  let url
  try {
    url = new URL(endpointUrl)
  } catch {
    return { host: '', port: '', tls: false, problem: `The System page lists the broker as '${endpointUrl}', which is not an address.` }
  }
  const tls = url.protocol === 'mqtts:'
  const host = url.hostname
  const port = url.port || (tls ? '8883' : '1883')
  const problem = IN_STACK_HOSTS.has(host)
    ? `'${host}' resolves only inside Aber, so this site's broker is not published to the plant network yet.`
    : null
  return { host, port, tls, problem }
}

/** `ingestion.primaryHostId`, through the runtime config; null where none was supplied. */
export function primaryHostId() {
  return readSetting('VITE_PRIMARY_HOST_ID') ?? null
}

/** Where the dashboard's own host serves Aber's root certificate (nginx.conf), with ingress TLS on. */
export const ROOT_CERTIFICATE_PATH = '/.well-known/aber/ca.pem'

/** The release tag this bundle was built from, or `main` for a development build. */
export function sourceRef(version = APP_VERSION) {
  const release = /^v?(\d+\.\d+\.\d+)$/.exec(String(version ?? '').trim())
  return release ? `v${release[1]}` : 'main'
}

/** The help page for an engineer bringing their own edge node, as the help panel names it. */
export const BRING_YOUR_OWN_EDGE_NODE = 'site/bring-your-own-edge-node'

/** A help page on GitHub, at the release this bundle came from. */
export function helpSourceUrl(page, version = APP_VERSION) {
  return `${GITHUB_REPO_URL}/blob/${sourceRef(version)}/help/${page}.md`
}

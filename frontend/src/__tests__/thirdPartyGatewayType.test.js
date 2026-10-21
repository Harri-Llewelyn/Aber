import { describe, it, expect, afterEach } from 'vitest'
import {
  GATEWAY_TYPES, SELECTABLE_TYPES, LISTED_TYPES, gatewayType, gatewayTypeLabel,
  gatewayTypeDescription, gatewayTypeFields, credentialIssuedHere,
} from '../utils/gatewayType'
import {
  CREDENTIAL_STATES, credentialAction, credentialState, credentialStateExplanation,
} from '../utils/credentialState'
import {
  gatewayAcceptsCell, resolveDeviceLocation, unassignedReason, UNASSIGNED_GATEWAY_HAS_NO_CELL,
  UNASSIGNED_GATEWAY_SITE_WIDE, SOURCE_INHERITED,
} from '../utils/cellResolution'
import {
  BROKER_DIRECTORY_ID, brokerAddress, brokerRow, helpSourceUrl, primaryHostId, sourceRef,
} from '../utils/edgeNodeSettings'

/**
 * A Third-party gateway: an edge node on its own machine, running software Aber does not manage.
 * It is issued its credential in the dashboard like a Host gateway, and placed on the plant like a
 * Remote one. The settings its engineer configures come from where the dashboard already learns
 * each value.
 */

const THIRD_PARTY = { deployment: 'third_party', is_simulated: false, is_shadow: false }

describe('the Third-party type', () => {
  it('is read off deployment, and labelled Third-party', () => {
    expect(gatewayType(THIRD_PARTY)).toBe(GATEWAY_TYPES.THIRD_PARTY)
    expect(gatewayTypeLabel(GATEWAY_TYPES.THIRD_PARTY)).toBe('Third-party')
    expect(gatewayTypeDescription(GATEWAY_TYPES.THIRD_PARTY)).toMatch(/software Aber does not manage/)
  })

  it('is offered beside Remote and Host, and listed by the Type filter', () => {
    expect(SELECTABLE_TYPES).toEqual(['remote', 'third_party', 'host', 'simulated'])
    expect(LISTED_TYPES).toContain('third_party')
  })

  it('writes the two columns the table holds', () => {
    expect(gatewayTypeFields(GATEWAY_TYPES.THIRD_PARTY)).toEqual({ deployment: 'third_party', is_simulated: false })
  })

  it('is issued its credential here, as Host is and Remote is not', () => {
    expect(credentialIssuedHere(THIRD_PARTY)).toBe(true)
    expect(credentialIssuedHere({ deployment: 'host' })).toBe(true)
    expect(credentialIssuedHere({ deployment: 'remote' })).toBe(false)
    expect(credentialIssuedHere(null)).toBe(false)
  })
})

describe("a Third-party gateway's credential", () => {
  it('is minted on the Access Control page, not set up with a bundle', () => {
    expect(credentialAction(THIRD_PARTY)).toBe('mint')
    expect(credentialAction({ deployment: 'remote' })).toBe('bundle')
    expect(credentialAction({ ...THIRD_PARTY, is_archived: true })).toBeNull()
  })

  it('reads Issued through the dashboard once a CREDENTIAL_ISSUED row exists', () => {
    const state = credentialState(THIRD_PARTY, '2026-10-20T10:00:00Z')
    expect(state).toBe(CREDENTIAL_STATES.ISSUED)
    expect(credentialStateExplanation(state, THIRD_PARTY)).toMatch(/^Issued through the dashboard/)
  })

  it('is never Setup outstanding, which only an appliance can be', () => {
    expect(credentialState({ ...THIRD_PARTY, status: 'PENDING_ENROLLMENT' })).toBe(CREDENTIAL_STATES.UNRECORDED)
  })
})

describe('where a Third-party gateway is', () => {
  it('can be placed in a cell, and its devices inherit it, as a Remote gateway does', () => {
    const gateway = { ...THIRD_PARTY, cell_id: 'cell-1', location_scope: 'cell' }
    expect(gatewayAcceptsCell(gateway)).toBe(true)
    const resolved = resolveDeviceLocation({ cell_id: null }, gateway)
    expect(resolved.effective_cell_id).toBe('cell-1')
    expect(resolved.location_source).toBe(SOURCE_INHERITED)
  })

  it('is fixed once on the Gateways page when it has no cell, unlike a host-level proxy', () => {
    expect(unassignedReason({}, { ...THIRD_PARTY, cell_id: null, location_scope: 'cell' }))
      .toBe(UNASSIGNED_GATEWAY_HAS_NO_CELL)
    expect(unassignedReason({}, { deployment: 'host', cell_id: null, location_scope: 'cell' }))
      .toBe(UNASSIGNED_GATEWAY_SITE_WIDE)
  })
})

describe('the settings its edge node is configured with', () => {
  afterEach(() => { delete globalThis.__ABER_CONFIG__ })

  it("take the broker from the Directory's broker row, by its id", () => {
    const rows = [
      { service_uuid: 'other', service_type: 'MQTT_BROKER', endpoint_url: 'mqtt://elsewhere:1883' },
      { service_uuid: BROKER_DIRECTORY_ID, service_type: 'MQTT_BROKER', endpoint_url: 'mqtts://mqtt.plant:8883' },
    ]
    expect(brokerRow(rows).endpoint_url).toBe('mqtts://mqtt.plant:8883')
    expect(brokerRow([rows[0]]).endpoint_url).toBe('mqtt://elsewhere:1883')
    expect(brokerRow([])).toBeNull()
  })

  it('split the address into the host and TLS port a node asks for', () => {
    expect(brokerAddress('mqtts://mqtt.plant:8883')).toEqual({ host: 'mqtt.plant', port: '8883', tls: true, problem: null })
    expect(brokerAddress('mqtts://10.0.0.5')).toMatchObject({ host: '10.0.0.5', port: '8883', tls: true })
    expect(brokerAddress('mqtt://plant-pc:1883')).toMatchObject({ port: '1883', tls: false })
    expect(brokerAddress(null)).toBeNull()
  })

  it('say when the Directory still names an address only Aber can resolve', () => {
    expect(brokerAddress('mqtt://mosquitto:1883').problem).toMatch(/resolves only inside Aber/)
    expect(brokerAddress('mqtt://localhost:1883').problem).toMatch(/resolves only inside Aber/)
  })

  it('read the primary host id from the runtime config', () => {
    expect(primaryHostId()).toBeNull()
    globalThis.__ABER_CONFIG__ = { VITE_PRIMARY_HOST_ID: 'plant1' }
    expect(primaryHostId()).toBe('plant1')
  })

  it("link the help page at the running release's tag, and main for a development build", () => {
    expect(sourceRef('1.6.0')).toBe('v1.6.0')
    expect(sourceRef('v1.6.0')).toBe('v1.6.0')
    expect(sourceRef('v1.5.0-12-g83bbd01-dirty')).toBe('main')
    expect(sourceRef('unknown')).toBe('main')
    expect(helpSourceUrl('site/bring-your-own-edge-node', '1.6.0'))
      .toBe('https://github.com/Harri-Llewelyn/Aber/blob/v1.6.0/help/site/bring-your-own-edge-node.md')
  })
})

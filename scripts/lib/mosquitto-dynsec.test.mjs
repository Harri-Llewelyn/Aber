/**
 * Unit tests for the Dynamic Security policy functions.
 *
 *     node --test scripts/lib/mosquitto-dynsec.test.mjs
 *
 * The reconcile is the part whose failure is silent: a boot that dropped a gateway client produces
 * a valid document and a fleet that falls off the broker one reconnect at a time. It is tested
 * here without a broker, as the password-file merge it replaces was.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CredentialError } from './mosquitto-credentials.mjs';
import {
  ADMIN_ROLE,
  GATEWAY_SHARED_ROLE,
  clientFromPasswordEntry,
  controlArgv,
  controlPayload,
  gatewayRole,
  gatewayRoleName,
  gatewayRoleNames,
  importPasswordFile,
  isGatewayRoleName,
  issueCommands,
  parseControlResponse,
  primaryHostStateTopic,
  reconcile,
  rolesFor,
  summariseInventory,
  withPrimaryHostGrant,
} from './mosquitto-dynsec.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const POLICY = JSON.parse(readFileSync(join(REPO, 'mosquitto', 'dynsec-roles.json'), 'utf8'));

const GW_A = 'gwy120000000000400080000';
const GW_B = 'gwy130000000000400080000';
const entry = (user, salt = 'c2FsdHNhbHRzYWx0') =>
  `${user}:$7$101$${salt}$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA==`;

describe('the shipped policy', () => {
  test('denies by default and declares the two roles the reconcile requires', () => {
    assert.deepEqual(POLICY.defaultACLAccess, {
      publishClientSend: false, publishClientReceive: false, subscribe: false, unsubscribe: true,
    });
    const names = POLICY.roles.map((r) => r.rolename);
    assert.ok(names.includes(GATEWAY_SHARED_ROLE));
    assert.ok(names.includes(ADMIN_ROLE));
  });

  test('carries no %u, which the plugin does not substitute on 2.0.x', () => {
    for (const role of POLICY.roles) {
      for (const acl of role.acls) {
        assert.ok(!acl.topic.includes('%'), `${role.rolename} has a pattern topic: ${acl.topic}`);
      }
    }
  });

  test('the admin role reaches the plugin and nothing else', () => {
    const admin = POLICY.roles.find((r) => r.rolename === ADMIN_ROLE);
    for (const acl of admin.acls) assert.equal(acl.topic, '$CONTROL/dynamic-security/#');
  });

  test('no role lets a gateway read the Directory or the UNS', () => {
    const gateway = POLICY.roles.find((r) => r.rolename === GATEWAY_SHARED_ROLE);
    for (const acl of gateway.acls) {
      assert.ok(acl.topic.startsWith('spBv1.0/'), `gateway reaches ${acl.topic}`);
    }
  });
});

describe('gateway roles', () => {
  test('one literal role per gateway, publish and receive beneath its own edge node only', () => {
    const role = gatewayRole(GW_A);
    assert.equal(role.rolename, `gateway-${GW_A}`);
    assert.deepEqual(role.acls.map((a) => a.acltype).sort(), ['publishClientReceive', 'publishClientSend']);
    for (const a of role.acls) assert.equal(a.topic, `spBv1.0/+/+/${GW_A}/#`);
  });

  test('a client holds the shared role and its own', () => {
    assert.deepEqual(gatewayRoleNames(GW_A), [GATEWAY_SHARED_ROLE, `gateway-${GW_A}`]);
  });

  test('refuses an id the broker could not confine', () => {
    assert.throws(() => gatewayRoleName('val_gateway_01'), CredentialError);
  });

  test('recognises its own role names and nothing near them', () => {
    assert.ok(isGatewayRoleName(gatewayRoleName(GW_A)));
    assert.ok(!isGatewayRoleName('gateway'));
    assert.ok(!isGatewayRoleName('gateway-notanid'));
  });
});

describe('clientFromPasswordEntry', () => {
  test('transplants the three hash fields and assigns roles', () => {
    const c = clientFromPasswordEntry(entry(GW_A), gatewayRoleNames(GW_A));
    assert.equal(c.username, GW_A);
    assert.equal(c.iterations, 101);
    assert.equal(c.salt, 'c2FsdHNhbHRzYWx0');
    assert.match(c.password, /^[A-Za-z0-9+/=]+$/);
    assert.deepEqual(c.roles, [{ rolename: 'gateway' }, { rolename: `gateway-${GW_A}` }]);
  });

  test('refuses an unhashed entry', () => {
    assert.throws(() => clientFromPasswordEntry(`${GW_A}:hunter2`), CredentialError);
  });
});

describe('importPasswordFile', () => {
  test('assigns roles by username and reports what it could not place', () => {
    const text = [
      entry('factoryplus_ingestion'), entry(GW_A), entry('probe'), '', 'garbage-line', entry('gwy110000000000400080000'),
    ].join('\n');
    const platform = new Map([['factoryplus_ingestion', 'ingestion'], ['gwy110000000000400080000', null]]);
    const { clients, unassigned, malformed } = importPasswordFile(text, platform);
    const byName = Object.fromEntries(clients.map((c) => [c.username, c]));
    assert.deepEqual(byName.factoryplus_ingestion.roles, [{ rolename: 'ingestion' }]);
    assert.deepEqual(byName[GW_A].roles.map((r) => r.rolename), gatewayRoleNames(GW_A));
    assert.deepEqual(byName.gwy110000000000400080000.roles.map((r) => r.rolename), gatewayRoleNames('gwy110000000000400080000'));
    assert.deepEqual(byName.probe.roles, []);
    assert.deepEqual(unassigned, ['probe']);
    assert.deepEqual(malformed, ['garbage-line']);
  });
});

describe('reconcile', () => {
  const managed = [
    clientFromPasswordEntry(entry('admin'), [ADMIN_ROLE]),
    clientFromPasswordEntry(entry('factoryplus_ingestion'), ['ingestion']),
    clientFromPasswordEntry(entry('factoryplus_monitor'), ['monitor']),
  ];

  test('starts from nothing', () => {
    const { config, report } = reconcile(null, POLICY, managed);
    assert.deepEqual(config.clients.map((c) => c.username), ['admin', 'factoryplus_ingestion', 'factoryplus_monitor']);
    assert.deepEqual(config.roles.map((r) => r.rolename), POLICY.roles.map((r) => r.rolename));
    assert.deepEqual(config.defaultACLAccess, POLICY.defaultACLAccess);
    assert.deepEqual(report.kept, []);
  });

  test('keeps every gateway client verbatim and regenerates its role', () => {
    const stored = {
      clients: [
        clientFromPasswordEntry(entry(GW_A, 'b2xkc2FsdHNhbHQ='), gatewayRoleNames(GW_A)),
        // A gateway whose stored role list is incomplete, as an import by hand might leave it.
        clientFromPasswordEntry(entry(GW_B), []),
        { ...clientFromPasswordEntry(entry('factoryplus_ingestion', 'b2xkc2FsdHNhbHQ='), ['ingestion']) },
      ],
      roles: [{ rolename: `gateway-${GW_A}`, acls: [{ acltype: 'publishClientSend', topic: '#', allow: true }] }],
      groups: [{ groupname: 'hand-made', roles: [] }],
    };
    const { config, report } = reconcile(stored, POLICY, managed);
    const byName = Object.fromEntries(config.clients.map((c) => [c.username, c]));

    assert.equal(byName[GW_A].salt, 'b2xkc2FsdHNhbHQ=', 'the gateway hash was replaced');
    assert.deepEqual(byName[GW_B].roles.map((r) => r.rolename), gatewayRoleNames(GW_B), 'roles were not ensured');
    assert.equal(byName.factoryplus_ingestion.salt, 'c2FsdHNhbHRzYWx0', 'the managed principal was not replaced');

    const roleA = config.roles.find((r) => r.rolename === `gateway-${GW_A}`);
    assert.deepEqual(roleA, gatewayRole(GW_A), 'a widened stored role survived the boot');
    assert.ok(config.roles.some((r) => r.rolename === `gateway-${GW_B}`));
    assert.deepEqual(config.groups, stored.groups);
    assert.deepEqual(report.gateways.sort(), [GW_A, GW_B].sort());
  });

  test('keeps a client it does not manage, untouched and reported', () => {
    const bi = { username: 'bi_reader', password: 'x', salt: 'y', iterations: 101, roles: [{ rolename: 'bi' }] };
    const stored = { clients: [bi], roles: [{ rolename: 'bi', acls: [{ acltype: 'subscribePattern', topic: 'uns/#', allow: true }] }] };
    const { config, report } = reconcile(stored, POLICY, managed);
    assert.deepEqual(config.clients.find((c) => c.username === 'bi_reader'), bi);
    assert.ok(config.roles.some((r) => r.rolename === 'bi'));
    assert.deepEqual(report.unmanaged, ['bi_reader']);
  });

  test('replaces a policy role the stored document had widened', () => {
    const stored = {
      clients: [],
      roles: [{ rolename: 'i3x', acls: [{ acltype: 'publishClientSend', topic: 'spBv1.0/#', allow: true }] }],
    };
    const { config } = reconcile(stored, POLICY, managed);
    const i3x = config.roles.find((r) => r.rolename === 'i3x');
    assert.deepEqual(i3x, POLICY.roles.find((r) => r.rolename === 'i3x'));
  });

  test('regenerates an orphaned gateway role rather than deleting it', () => {
    // A role in use cannot be deleted safely (mosquitto/README.md), and a role for a client that
    // is gone must still confine if that client is ever re-created by hand.
    const stored = { clients: [], roles: [{ rolename: `gateway-${GW_A}`, acls: [] }] };
    const { config } = reconcile(stored, POLICY, managed);
    assert.deepEqual(config.roles.find((r) => r.rolename === `gateway-${GW_A}`), gatewayRole(GW_A));
  });

  test('scales to a fleet without losing anyone', () => {
    const fleet = Array.from({ length: 250 }, (_, i) => {
      const id = `gwy${i.toString(16).padStart(21, '0')}`;
      return clientFromPasswordEntry(entry(id), gatewayRoleNames(id));
    });
    const { config } = reconcile({ clients: fleet, roles: [] }, POLICY, managed);
    assert.equal(config.clients.length, 253);
    assert.equal(config.roles.length, POLICY.roles.length + 250);
  });

  test('refuses a document with duplicate usernames', () => {
    const stored = { clients: [clientFromPasswordEntry(entry(GW_A)), clientFromPasswordEntry(entry(GW_A))], roles: [] };
    assert.throws(() => reconcile(stored, POLICY, managed), (e) => e.code === 'duplicate_accounts');
  });

  test('refuses a managed client declared twice', () => {
    assert.throws(() => reconcile(null, POLICY, [...managed, managed[0]]), (e) => e.code === 'invalid_policy');
  });

  test('refuses a policy missing the roles it depends on', () => {
    assert.throws(() => reconcile(null, { defaultACLAccess: {}, roles: [{ rolename: 'x', acls: [] }] }, managed), CredentialError);
    assert.throws(() => reconcile(null, { roles: POLICY.roles }, managed), CredentialError);
  });
});

describe('the control API', () => {
  test('issue is the role then the client holding both roles', () => {
    const [role, client] = issueCommands(GW_A, 'password-0000000000000000');
    assert.equal(role.command, 'createRole');
    assert.equal(role.rolename, `gateway-${GW_A}`);
    assert.equal(client.command, 'createClient');
    assert.equal(client.username, GW_A);
    assert.deepEqual(client.roles.map((r) => r.rolename), gatewayRoleNames(GW_A));
  });

  test('parses a reply and distinguishes a refusal from silence', () => {
    const responses = parseControlResponse('{"responses":[{"command":"createClient","error":"Client already exists"}]}');
    assert.equal(responses[0].error, 'Client already exists');
    assert.throws(() => parseControlResponse(''), (e) => e.code === 'backend_unavailable');
    assert.throws(() => parseControlResponse('Connection Refused'), (e) => e.code === 'backend_unavailable');
  });

  test('the payload rides on argv with -m, because -s and -f are broken on 2.0.22', () => {
    // Measured: mosquitto_rr's stdin and file modes deliver a payload the plugin rejects as not
    // JSON. scripts/check-broker-config.mjs drives the real binary, so a fix upstream that made
    // -s usable would be noticed there, not here.
    const payload = controlPayload([{ command: 'listClients' }]);
    const argv = controlArgv({ host: 'mosquitto', port: 1883, username: 'admin', password: 'pw' }, payload);
    assert.equal(argv[argv.indexOf('-m') + 1], payload);
    assert.ok(!argv.includes('-s') && !argv.includes('-f'));
    assert.equal(argv[argv.indexOf('-t') + 1], '$CONTROL/dynamic-security/v1');
    assert.equal(argv[argv.indexOf('-e') + 1], '$CONTROL/dynamic-security/v1/response');
  });

  test('the inventory summary carries no hash material', () => {
    const clients = { data: { clients: [
      { username: GW_A, roles: [{ rolename: 'gateway' }], groups: [], password: 'x', salt: 'y' },
      { username: GW_B, disabled: true, roles: [], groups: [] },
    ] } };
    const roles = { data: { roles: [{ rolename: 'gateway', acls: [{ acltype: 'subscribePattern', topic: 'spBv1.0/#', priority: 0, allow: true }] }] } };
    const summary = summariseInventory(clients, roles);
    assert.deepEqual(summary.clients, [
      { username: GW_A, roles: ['gateway'], disabled: false },
      { username: GW_B, roles: [], disabled: true },
    ]);
    assert.deepEqual(summary.roles, [{ rolename: 'gateway', acls: [{ acltype: 'subscribePattern', topic: 'spBv1.0/#', allow: true }] }]);
    assert.ok(!JSON.stringify(summary).includes('salt'));
  });

  test('rolesFor names the role or the gateway pair', () => {
    assert.deepEqual(rolesFor('ingestion', 'factoryplus_ingestion'), [{ rolename: 'ingestion' }]);
    assert.deepEqual(rolesFor(null, GW_A).map((r) => r.rolename), gatewayRoleNames(GW_A));
  });
});

describe('the primary host STATE grant', () => {
  // The write half of a promise the shipped policy has always made on its read half: every gateway
  // is granted `spBv1.0/STATE/#` so it can learn whether its consumer is there, and until this
  // grant existed nothing was allowed to write it (issue #149).
  test('the shipped policy grants every gateway READ of the STATE subtree and no write', () => {
    const gateway = POLICY.roles.find((r) => r.rolename === GATEWAY_SHARED_ROLE);
    assert.ok(gateway.acls.some(
      (a) => a.acltype === 'publishClientReceive' && a.topic === 'spBv1.0/STATE/#' && a.allow,
    ));
    assert.ok(!gateway.acls.some((a) => a.acltype === 'publishClientSend'));
  });

  test('the grant is ONE literal topic, not the subtree', () => {
    // A wildcard grant would let this principal announce the death of a host id belonging to
    // somebody else, which is the thing the policy's own comment rules out.
    const granted = withPrimaryHostGrant(POLICY, 'Site-One');
    const ingestion = granted.roles.find((r) => r.rolename === 'ingestion');
    const writes = ingestion.acls.filter((a) => a.acltype === 'publishClientSend').map((a) => a.topic);
    assert.ok(writes.includes('spBv1.0/STATE/Site-One'));
    assert.ok(!writes.includes('spBv1.0/STATE/#'));
    assert.ok(!writes.includes('spBv1.0/STATE/+'));
  });

  test('no other role gains a write on the subtree', () => {
    const granted = withPrimaryHostGrant(POLICY, 'Site-One');
    for (const role of granted.roles) {
      if (role.rolename === 'ingestion') continue;
      assert.ok(
        !(role.acls || []).some((a) => a.acltype === 'publishClientSend' && a.topic.startsWith('spBv1.0/STATE/')),
        `role ${role.rolename} may write the STATE subtree`,
      );
    }
  });

  test('the argument is not mutated, so the document still matches the repository file', () => {
    const before = JSON.stringify(POLICY);
    withPrimaryHostGrant(POLICY, 'Site-One');
    assert.equal(JSON.stringify(POLICY), before);
  });

  test('applying it twice is a no-op, which is what makes the boot reconcile idempotent', () => {
    const once = withPrimaryHostGrant(POLICY, 'Site-One');
    const twice = withPrimaryHostGrant(once, 'Site-One');
    assert.deepEqual(twice, once);
  });

  test('a host id that is not one topic level is refused', () => {
    for (const bad of ['a/b', 'a+', 'a#', 'a b', '', null]) {
      assert.throws(() => primaryHostStateTopic(bad), (e) => e.code === 'invalid_primary_host_id', `${bad}`);
    }
  });

  test('a policy with no ingestion role is refused rather than silently ungranted', () => {
    const stripped = { ...POLICY, roles: POLICY.roles.filter((r) => r.rolename !== 'ingestion') };
    assert.throws(() => withPrimaryHostGrant(stripped, 'Site-One'), (e) => e.code === 'invalid_policy');
  });

  test('reconcile carries the grant through to the written document', () => {
    const managed = [clientFromPasswordEntry(entry('factoryplus_ingestion'), rolesFor('ingestion', 'factoryplus_ingestion'))];
    const { config } = reconcile(null, withPrimaryHostGrant(POLICY, 'Site-One'), managed);
    const ingestion = config.roles.find((r) => r.rolename === 'ingestion');
    assert.ok(ingestion.acls.some((a) => a.acltype === 'publishClientSend' && a.topic === 'spBv1.0/STATE/Site-One'));
  });
});

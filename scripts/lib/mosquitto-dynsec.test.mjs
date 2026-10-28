/**
 * Unit tests for the Dynamic Security policy functions.
 *
 *     node --test scripts/lib/mosquitto-dynsec.test.mjs
 *
 * The reconcile is the part whose failure is silent: a boot that dropped a gateway client produces
 * a valid document and a fleet that falls off the broker one reconnect at a time. It is tested
 * here without a broker.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CredentialError } from './mosquitto-credentials.mjs';
import {
  ADMIN_ROLE,
  CONTROL_SCRIPT,
  GATEWAY_SHARED_ROLE,
  clientFromPasswordEntry,
  controlArgv,
  controlInput,
  controlPayload,
  isRetiredGatewayRoleName,
  issueCommand,
  issueWithControl,
  parseControlResponse,
  pluginRole,
  primaryHostStateTopic,
  reconcile,
  rolesFor,
  summariseInventory,
  withPrimaryHostGrant,
  withDirectoryGrant,
  directoryTopicFilter,
  unsTopicFilter,
  withUnsGrant,
  withUnsReadGrant,
  UNS_READER_ROLE,
  SUBSCRIBER_ROLE,
  createSubscriberCommand,
  createSubscriberWithControl,
  deleteSubscriberCommand,
  deleteSubscriberWithControl,
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

  test('%u appears only in the gateway role, and only where the plugin substitutes it', () => {
    // 2.1 substitutes %u in every ACL type but subscribeLiteral and unsubscribeLiteral, where it
    // would be a literal that matches nothing.
    for (const role of POLICY.roles) {
      for (const acl of role.acls) {
        if (!acl.topic.includes('%')) continue;
        assert.equal(role.rolename, GATEWAY_SHARED_ROLE, `${role.rolename} has a pattern topic: ${acl.topic}`);
        assert.ok(!/%[^u]/.test(acl.topic), `${acl.topic} uses a pattern other than %u`);
        assert.ok(!/Literal$/.test(acl.acltype), `%u in ${acl.acltype} is not substituted`);
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

describe('the gateway role', () => {
  const gateway = POLICY.roles.find((r) => r.rolename === GATEWAY_SHARED_ROLE);

  test('publishes and receives beneath the edge node its username names, and nowhere else', () => {
    // What the per-gateway roles granted, with the id as %u: the username is the sparkplug_id.
    const own = gateway.acls.filter((a) => a.topic === 'spBv1.0/+/+/%u/#');
    assert.deepEqual(own.map((a) => a.acltype).sort(), ['publishClientReceive', 'publishClientSend']);
    const sends = gateway.acls.filter((a) => a.acltype === 'publishClientSend');
    assert.deepEqual(sends.map((a) => a.topic), ['spBv1.0/+/+/%u/#']);
  });

  test('recognises a retired per-gateway role name and nothing near it', () => {
    assert.ok(isRetiredGatewayRoleName(`gateway-${GW_A}`));
    assert.ok(!isRetiredGatewayRoleName('gateway'));
    assert.ok(!isRetiredGatewayRoleName('gateway-notanid'));
    assert.ok(!isRetiredGatewayRoleName(`gateway-${GW_A}x`));
  });
});

describe('clientFromPasswordEntry', () => {
  test('transplants the three hash fields and assigns roles', () => {
    const c = clientFromPasswordEntry(entry(GW_A), [GATEWAY_SHARED_ROLE]);
    assert.equal(c.username, GW_A);
    assert.equal(c.iterations, 101);
    assert.equal(c.salt, 'c2FsdHNhbHRzYWx0');
    assert.match(c.password, /^[A-Za-z0-9+/=]+$/);
    assert.deepEqual(c.roles, [{ rolename: 'gateway' }]);
  });

  test('refuses an unhashed entry', () => {
    assert.throws(() => clientFromPasswordEntry(`${GW_A}:hunter2`), CredentialError);
  });
});

describe('reconcile', () => {
  const managed = [
    clientFromPasswordEntry(entry('admin'), [ADMIN_ROLE]),
    clientFromPasswordEntry(entry('aber_ingestion'), ['ingestion']),
    clientFromPasswordEntry(entry('aber_monitor'), ['monitor']),
  ];

  test('starts from nothing', () => {
    const { config, report } = reconcile(null, POLICY, managed);
    assert.deepEqual(config.clients.map((c) => c.username), ['admin', 'aber_ingestion', 'aber_monitor']);
    assert.deepEqual(config.roles.map((r) => r.rolename), POLICY.roles.map((r) => r.rolename));
    assert.deepEqual(config.defaultACLAccess, POLICY.defaultACLAccess);
    assert.deepEqual(report.kept, []);
  });

  test('keeps every gateway client verbatim, holding the gateway role and nothing retired', () => {
    // GW_A is a 1.3.0 site's gateway: the shared role and its own generated one, with the role
    // stored widened. GW_B's stored role list is incomplete, as an import by hand might leave it.
    const stored = {
      clients: [
        clientFromPasswordEntry(entry(GW_A, 'b2xkc2FsdHNhbHQ='), [GATEWAY_SHARED_ROLE, `gateway-${GW_A}`]),
        clientFromPasswordEntry(entry(GW_B), []),
        { ...clientFromPasswordEntry(entry('aber_ingestion', 'b2xkc2FsdHNhbHQ='), ['ingestion']) },
      ],
      roles: [{ rolename: `gateway-${GW_A}`, acls: [{ acltype: 'publishClientSend', topic: '#', allow: true }] }],
      groups: [{ groupname: 'hand-made', roles: [] }],
    };
    const { config, report } = reconcile(stored, POLICY, managed);
    const byName = Object.fromEntries(config.clients.map((c) => [c.username, c]));

    assert.equal(byName[GW_A].salt, 'b2xkc2FsdHNhbHQ=', 'the gateway hash was replaced');
    assert.deepEqual(byName[GW_A].roles, [{ rolename: GATEWAY_SHARED_ROLE }], 'the retired role is still held');
    assert.deepEqual(byName[GW_B].roles, [{ rolename: GATEWAY_SHARED_ROLE }], 'the gateway role was not ensured');
    assert.equal(byName.aber_ingestion.salt, 'c2FsdHNhbHRzYWx0', 'the managed principal was not replaced');

    assert.ok(!config.roles.some((r) => isRetiredGatewayRoleName(r.rolename)), 'a per-gateway role survived the boot');
    assert.deepEqual(config.groups, stored.groups);
    assert.deepEqual(report.gateways.sort(), [GW_A, GW_B].sort());
    assert.deepEqual(report.retiredRoles, [`gateway-${GW_A}`]);
    assert.equal(report.retiredMemberships, 1);
  });

  test('a second boot retires nothing more and changes nothing', () => {
    const stored = {
      clients: [clientFromPasswordEntry(entry(GW_A), [GATEWAY_SHARED_ROLE, `gateway-${GW_A}`])],
      roles: [{ rolename: `gateway-${GW_A}`, acls: [] }],
    };
    const first = reconcile(stored, POLICY, managed).config;
    const { config, report } = reconcile(first, POLICY, managed);
    assert.deepEqual(config, first);
    assert.deepEqual(report.retiredRoles, []);
    assert.equal(report.retiredMemberships, 0);
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
    assert.deepEqual(i3x, pluginRole(POLICY.roles.find((r) => r.rolename === 'i3x')));
  });

  test('drops an orphaned per-gateway role, and keeps a role that only looks like one', () => {
    // The broker is down while the reconcile runs, so no connected client holds what it drops.
    const stored = {
      clients: [],
      roles: [{ rolename: `gateway-${GW_A}`, acls: [] }, { rolename: 'gateway-readers', acls: [] }],
    };
    const { config } = reconcile(stored, POLICY, managed);
    assert.ok(!config.roles.some((r) => r.rolename === `gateway-${GW_A}`));
    assert.ok(config.roles.some((r) => r.rolename === 'gateway-readers'));
  });

  test('scales to a fleet without losing anyone, and with one role for all of it', () => {
    const fleet = Array.from({ length: 250 }, (_, i) => {
      const id = `gwy${i.toString(16).padStart(21, '0')}`;
      return clientFromPasswordEntry(entry(id), [GATEWAY_SHARED_ROLE, `gateway-${id}`]);
    });
    const roles = fleet.map((c) => ({ rolename: `gateway-${c.username}`, acls: [] }));
    const { config, report } = reconcile({ clients: fleet, roles }, POLICY, managed);
    assert.equal(config.clients.length, 253);
    assert.equal(config.roles.length, POLICY.roles.length);
    assert.equal(report.retiredRoles.length, 250);
  });

  test('gives the plugin each ACL with the plugin\'s keys only', () => {
    // The roles file carries a `why` per ACL for people; the plugin is given none of it.
    const policy = JSON.parse(JSON.stringify(POLICY));
    policy.roles[0].acls[0].why = 'a note for people';
    const { config } = reconcile(null, policy, managed);
    for (const role of config.roles) {
      for (const acl of role.acls) {
        assert.deepEqual(Object.keys(acl).filter((k) => !['acltype', 'topic', 'priority', 'allow'].includes(k)), []);
      }
    }
    assert.equal(policy.roles[0].acls[0].why, 'a note for people', 'the policy argument was mutated');
    assert.deepEqual(pluginRole({ rolename: 'r', acls: [{ acltype: 'subscribePattern', topic: 't', priority: 2, allow: true, why: 'x' }] }),
      { rolename: 'r', acls: [{ acltype: 'subscribePattern', topic: 't', priority: 2, allow: true }] });
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
  test('issue is one client holding the gateway role, and no role of its own', () => {
    const client = issueCommand(GW_A, 'password-0000000000000000');
    assert.equal(client.command, 'createClient');
    assert.equal(client.username, GW_A);
    assert.deepEqual(client.roles, [{ rolename: GATEWAY_SHARED_ROLE }]);
  });

  test('issue refuses an id the broker could not confine', () => {
    assert.throws(() => issueCommand('val_gateway_01', 'password-0000000000000000'), (e) => e.code === 'invalid_sparkplug_id');
  });

  test('a re-issue sets the password, enables, and adds the gateway role only when it is missing', () => {
    const run = (held) => {
      const sent = [];
      const send = (command) => {
        sent.push(command.command);
        if (command.command === 'createClient') return { command: 'createClient', error: 'Client already exists' };
        if (command.command === 'getClient') return { data: { client: { roles: held.map((rolename) => ({ rolename })) } } };
        return {};
      };
      return { result: issueWithControl(send, GW_A, 'password-0000000000000000'), sent };
    };
    const missing = run([]);
    assert.deepEqual(missing.result, { replaced: true });
    assert.deepEqual(missing.sent, ['createClient', 'setClientPassword', 'enableClient', 'getClient', 'addClientRole']);
    assert.deepEqual(run([GATEWAY_SHARED_ROLE]).sent, ['createClient', 'setClientPassword', 'enableClient', 'getClient']);
    assert.ok(!missing.sent.includes('createRole') && !missing.sent.includes('deleteRole'));
  });

  test('parses a reply and distinguishes a refusal from silence', () => {
    const responses = parseControlResponse('{"responses":[{"command":"createClient","error":"Client already exists"}]}');
    assert.equal(responses[0].error, 'Client already exists');
    assert.throws(() => parseControlResponse(''), (e) => e.code === 'backend_unavailable');
    assert.throws(() => parseControlResponse('Connection Refused'), (e) => e.code === 'backend_unavailable');
  });

  test('neither the password nor the payload is on argv; both go on stdin', () => {
    // scripts/check-broker-config.mjs drives this command against the real binary.
    const connection = { host: 'mosquitto', port: 1883, username: 'admin', password: 'admin-secret-0001' };
    const payload = controlPayload([issueCommand(GW_A, 'gateway-secret-0001')]);
    const argv = controlArgv(connection);
    for (const secret of [connection.password, 'gateway-secret-0001', payload]) {
      assert.ok(!argv.some((arg) => arg.includes(secret)), `${secret} is on argv`);
    }
    assert.deepEqual(argv.slice(0, 2), ['sh', '-c']);
    assert.equal(argv[argv.length - 1], '-s');
    assert.ok(!argv.includes('-m') && !argv.includes('-P'));
    assert.equal(argv[argv.indexOf('-t') + 1], '$CONTROL/dynamic-security/v1');
    assert.equal(argv[argv.indexOf('-e') + 1], '$CONTROL/dynamic-security/v1/response');
    assert.equal(controlInput(connection, payload), `admin-secret-0001\n${payload}`);
  });

  test('the script hands the password to mosquitto_rr as an options file on a pipe, never a file', () => {
    // The here-document is the options file; ash backs it with a pipe, so nothing reaches disk
    // (measured on a read-only root filesystem, as the chart runs both containers).
    assert.match(CONTROL_SCRIPT, /^IFS= read -r password \|\|/);
    assert.match(CONTROL_SCRIPT, /\nexec mosquitto_rr -o \/dev\/fd\/3 "\$@" 3<<EOF\n-P \$password\nEOF$/);
    assert.ok(!/mktemp|\/tmp|>\s*\//.test(CONTROL_SCRIPT), 'the script writes a file');
  });

  test('a password the options file cannot carry is refused before anything runs', () => {
    const at = (password) => () => controlInput({ password }, '{}');
    for (const bad of ['', null, undefined, 'two\nlines', 'carriage\rreturn', 'nul\0byte', 'x'.repeat(1021)]) {
      assert.throws(at(bad), (e) => e instanceof CredentialError && e.code === 'backend_unavailable', JSON.stringify(bad));
    }
    assert.doesNotThrow(at('x'.repeat(1020)));
    assert.doesNotThrow(at(' a b$(id)`id`\\c\'"#;|&>*?~ x '));
  });

  test('the inventory summary carries no hash material', () => {
    const clients = { data: { clients: [
      { username: GW_A, roles: [{ rolename: 'gateway' }], groups: [], password: 'x', salt: 'y' },
      { username: GW_B, disabled: true, roles: [], groups: [] },
    ] } };
    const roles = { data: { roles: [{ rolename: 'gateway', acls: [{ acltype: 'subscribePattern', topic: 'spBv1.0/#', priority: 0, allow: true }] }] } };
    const summary = summariseInventory(clients, roles);
    assert.deepEqual(summary.clients, [
      { username: GW_A, roles: ['gateway'], disabled: false, connections: null, textname: null, textdescription: null },
      { username: GW_B, roles: [], disabled: true, connections: null, textname: null, textdescription: null },
    ]);
    assert.deepEqual(summary.roles, [{ rolename: 'gateway', acls: [{ acltype: 'subscribePattern', topic: 'spBv1.0/#', allow: true }] }]);
    assert.ok(!JSON.stringify(summary).includes('salt'));
  });

  test('the inventory summary counts each account\'s live sessions and carries no address', () => {
    // listClients verbose as 2.1.2 answers it: one entry per live session, each with its address.
    const clients = { data: { clients: [
      { username: GW_A, roles: [{ rolename: 'gateway' }], groups: [], connections: [{ address: '10.42.0.1' }] },
      { username: GW_B, roles: [{ rolename: 'gateway' }], groups: [], connections: [{ address: '10.42.0.1' }, { address: '10.42.0.7' }] },
      { username: 'aber_i3x', roles: [{ rolename: 'i3x' }], groups: [], connections: [] },
      { username: 'aber_monitor', disabled: true, roles: [{ rolename: 'monitor' }], groups: [], connections: [] },
    ] } };
    const summary = summariseInventory(clients, null);
    assert.deepEqual(summary.clients.map((c) => [c.username, c.connections]), [
      [GW_A, 1], [GW_B, 2], ['aber_i3x', 0], ['aber_monitor', 0],
    ]);
    const text = JSON.stringify(summary);
    assert.ok(!text.includes('address') && !text.includes('10.42.0'), 'the summary carries an address');
  });

  test('rolesFor names the role, or the gateway role', () => {
    assert.deepEqual(rolesFor('ingestion'), [{ rolename: 'ingestion' }]);
    assert.deepEqual(rolesFor(null), [{ rolename: GATEWAY_SHARED_ROLE }]);
  });
});

describe('the primary host STATE grant', () => {
  // The write half of a promise the shipped policy has always made on its read half: every gateway
  // is granted `spBv1.0/STATE/#` so it can learn whether its consumer is there, and until this
  // grant existed nothing was allowed to write it (issue #149).
  test('the shipped policy grants every gateway READ of the STATE subtree and no write', () => {
    // Its one write rule is beneath its own edge node, four levels deep; a host's STATE is three.
    const gateway = POLICY.roles.find((r) => r.rolename === GATEWAY_SHARED_ROLE);
    assert.ok(gateway.acls.some(
      (a) => a.acltype === 'publishClientReceive' && a.topic === 'spBv1.0/STATE/#' && a.allow,
    ));
    assert.ok(!gateway.acls.some((a) => a.acltype === 'publishClientSend' && a.topic.startsWith('spBv1.0/STATE')));
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
    const managed = [clientFromPasswordEntry(entry('aber_ingestion'), rolesFor('ingestion'))];
    const { config } = reconcile(null, withPrimaryHostGrant(POLICY, 'Site-One'), managed);
    const ingestion = config.roles.find((r) => r.rolename === 'ingestion');
    assert.ok(ingestion.acls.some((a) => a.acltype === 'publishClientSend' && a.topic === 'spBv1.0/STATE/Site-One'));
  });
});

describe('the Directory grant is derived from the site, not written in the policy', () => {
  test('the ingestion role gains the write on the prefix subtree, and no read', () => {
    // The daemon publishes the Directory and never subscribes to it (directory_publish.py).
    const granted = withDirectoryGrant(POLICY, 'Plant-7/Directory/v1');
    const ingestion = granted.roles.find((r) => r.rolename === 'ingestion');
    assert.deepEqual(
      ingestion.acls.filter((a) => a.topic === 'Plant-7/Directory/v1/#'),
      [{ acltype: 'publishClientSend', topic: 'Plant-7/Directory/v1/#', allow: true }],
    );
  });

  test('the policy file itself names no Directory subtree', () => {
    // The whole point: the group belongs to the site, so the repository cannot spell the topic.
    // A literal creeping back would grant one site's subtree on every other site's broker.
    assert.ok(
      !JSON.stringify(POLICY.roles).includes('/Directory/'),
      'dynsec-roles.json declares a Directory ACL; it is injected at reconcile time instead',
    );
  });

  test('no other role gains a read of the Directory', () => {
    // A gateway reading it would enumerate every asset on the site, and reading is silent.
    const granted = withDirectoryGrant(POLICY, 'Plant-7/Directory/v1');
    for (const role of granted.roles) {
      if (role.rolename === 'ingestion') continue;
      assert.ok(
        !(role.acls || []).some((a) => String(a.topic).includes('/Directory/')),
        `role ${role.rolename} may reach the Directory`,
      );
    }
  });

  test('a prefix with a wildcard or whitespace is refused', () => {
    for (const bad of ['a/+/b', 'a/#', 'a b', '', null, undefined]) {
      assert.throws(() => directoryTopicFilter(bad), (e) => e.code === 'invalid_directory_prefix', `${bad}`);
    }
  });

  test('a trailing slash does not produce an empty level', () => {
    assert.equal(directoryTopicFilter('Plant-7/Directory/v1/'), 'Plant-7/Directory/v1/#');
  });

  test('the argument is not mutated, so the document still matches the repository file', () => {
    const before = JSON.stringify(POLICY);
    withDirectoryGrant(POLICY, 'Plant-7/Directory/v1');
    assert.equal(JSON.stringify(POLICY), before);
  });

  test('applying it twice is a no-op, which is what makes the boot reconcile idempotent', () => {
    const once = withDirectoryGrant(POLICY, 'Plant-7/Directory/v1');
    const twice = withDirectoryGrant(once, 'Plant-7/Directory/v1');
    assert.deepEqual(twice, once);
  });

  test('a policy with no ingestion role is refused rather than silently ungranted', () => {
    const stripped = { ...POLICY, roles: POLICY.roles.filter((r) => r.rolename !== 'ingestion') };
    assert.throws(() => withDirectoryGrant(stripped, 'Plant-7/Directory/v1'), (e) => e.code === 'invalid_policy');
  });

  test('reconcile carries the grant through to the written document', () => {
    const managed = [clientFromPasswordEntry(entry('aber_ingestion'), rolesFor('ingestion'))];
    const { config } = reconcile(null, withDirectoryGrant(POLICY, 'Plant-7/Directory/v1'), managed);
    const ingestion = config.roles.find((r) => r.rolename === 'ingestion');
    assert.ok(ingestion.acls.some((a) => a.acltype === 'publishClientSend' && a.topic === 'Plant-7/Directory/v1/#'));
  });

  test('both derived grants survive each other', () => {
    // They edit the same role, so an implementation that replaced `acls` rather than appending
    // would drop whichever ran first and nothing else here would notice.
    const both = withDirectoryGrant(withPrimaryHostGrant(POLICY, 'Site-One'), 'Plant-7/Directory/v1');
    const ingestion = both.roles.find((r) => r.rolename === 'ingestion');
    const writes = ingestion.acls.filter((a) => a.acltype === 'publishClientSend').map((a) => a.topic);
    assert.ok(writes.includes('spBv1.0/STATE/Site-One'));
    assert.ok(writes.includes('Plant-7/Directory/v1/#'));
  });
});

describe('the Unified Namespace grant follows the root the deployment names', () => {
  test('the ingestion role gains the write on <root>/#, no read, and no other subtree', () => {
    // The daemon publishes the UNS and never subscribes to it (uns_publish.py).
    const granted = withUnsGrant(POLICY, 'plant/uns');
    const ingestion = granted.roles.find((r) => r.rolename === 'ingestion');
    assert.deepEqual(
      ingestion.acls.filter((a) => a.topic === 'plant/uns/#'),
      [{ acltype: 'publishClientSend', topic: 'plant/uns/#', allow: true }],
    );
    assert.ok(!ingestion.acls.some((a) => a.topic === 'uns/#'), 'the literal uns/# grant survived a different root');
  });

  test('the policy file itself names no UNS subtree', () => {
    // A literal in the file would grant uns/# whatever the root, and drop every publish under
    // another one, silently at QoS 0.
    assert.ok(!JSON.stringify(POLICY.roles).includes('"uns/'), 'dynsec-roles.json declares a UNS ACL');
  });

  test('the root is trimmed as uns_publish.py trims it, and may span levels', () => {
    assert.equal(unsTopicFilter('uns'), 'uns/#');
    assert.equal(unsTopicFilter(' /plant/uns/ '), 'plant/uns/#');
  });

  test('a root with a wildcard or whitespace, or none, is refused', () => {
    for (const bad of ['a/+/b', 'a/#', 'a b', '', '/', null, undefined]) {
      assert.throws(() => unsTopicFilter(bad), (e) => e.code === 'invalid_uns_root', `${bad}`);
    }
  });

  test('applying it twice is a no-op, and the argument is not mutated', () => {
    const before = JSON.stringify(POLICY);
    const once = withUnsGrant(POLICY, 'uns');
    assert.deepEqual(withUnsGrant(once, 'uns'), once);
    assert.equal(JSON.stringify(POLICY), before);
  });

  test('a policy with no ingestion role is refused rather than silently ungranted', () => {
    const stripped = { ...POLICY, roles: POLICY.roles.filter((r) => r.rolename !== 'ingestion') };
    assert.throws(() => withUnsGrant(stripped, 'uns'), (e) => e.code === 'invalid_policy');
  });

  test('all three derived grants survive each other', () => {
    const all = withUnsGrant(withDirectoryGrant(withPrimaryHostGrant(POLICY, 'Site-One'), 'Plant-7/Directory/v1'), 'plant/uns');
    const writes = all.roles.find((r) => r.rolename === 'ingestion').acls
      .filter((a) => a.acltype === 'publishClientSend').map((a) => a.topic);
    for (const topic of ['spBv1.0/STATE/Site-One', 'Plant-7/Directory/v1/#', 'plant/uns/#']) assert.ok(writes.includes(topic), topic);
  });
});

describe('the subscriber role reads the plant and writes nothing', () => {
  // The boot reconcile's order: every derived grant, the subscriber's read last.
  const booted = (policy = POLICY) => withUnsReadGrant(
    withUnsGrant(withDirectoryGrant(withPrimaryHostGrant(policy, 'Site-One'), 'Plant-7/Directory/v1'), 'plant/uns'),
    'plant/uns',
  );
  const subscriberOf = (policy) => policy.roles.find((r) => r.rolename === UNS_READER_ROLE);
  const pairs = (role) => role.acls.map((a) => [a.acltype, a.topic]).sort();

  test('the shipped role reads spBv1.0/# and holds no publish at all', () => {
    const role = subscriberOf(POLICY);
    assert.ok(role, 'dynsec-roles.json declares no subscriber role');
    assert.deepEqual(pairs(role), [['publishClientReceive', 'spBv1.0/#'], ['subscribePattern', 'spBv1.0/#']]);
  });

  test('at boot it gains subscribe and receive on <root>/#, from the root it is given, and nothing else', () => {
    assert.deepEqual(pairs(subscriberOf(booted())), [
      ['publishClientReceive', 'plant/uns/#'], ['publishClientReceive', 'spBv1.0/#'],
      ['subscribePattern', 'plant/uns/#'], ['subscribePattern', 'spBv1.0/#'],
    ]);
  });

  test('it publishes nowhere and reads no Directory, whatever else the boot grants', () => {
    const role = subscriberOf(booted());
    assert.ok(!role.acls.some((a) => a.acltype === 'publishClientSend'), 'the subscriber role may publish');
    assert.ok(!role.acls.some((a) => a.topic.includes('/Directory/')), 'the subscriber role reaches the Directory');
  });

  test('the writer keeps the write alone: reading the tree is the subscriber role\'s, not the daemon\'s', () => {
    const ingestion = booted().roles.find((r) => r.rolename === 'ingestion');
    assert.deepEqual(
      ingestion.acls.filter((a) => a.topic === 'plant/uns/#').map((a) => a.acltype),
      ['publishClientSend'],
    );
  });

  test('the root is trimmed and refused exactly as the writer\'s is', () => {
    const role = subscriberOf(withUnsReadGrant(POLICY, ' /plant/uns/ '));
    assert.ok(role.acls.some((a) => a.acltype === 'subscribePattern' && a.topic === 'plant/uns/#'));
    for (const bad of ['a/+/b', 'a/#', 'a b', '', '/', null, undefined]) {
      assert.throws(() => withUnsReadGrant(POLICY, bad), (e) => e.code === 'invalid_uns_root', `${bad}`);
    }
  });

  test('applying it twice is a no-op, and the argument is not mutated', () => {
    const before = JSON.stringify(POLICY);
    const once = withUnsReadGrant(POLICY, 'uns');
    assert.deepEqual(withUnsReadGrant(once, 'uns'), once);
    assert.equal(JSON.stringify(POLICY), before);
  });

  test('a role holding half the pair gains only the other half', () => {
    const half = {
      ...POLICY,
      roles: POLICY.roles.map((r) => (r.rolename === UNS_READER_ROLE
        ? { ...r, acls: [...r.acls, { acltype: 'subscribePattern', topic: 'uns/#', allow: true }] }
        : r)),
    };
    const onRoot = subscriberOf(withUnsReadGrant(half, 'uns')).acls.filter((a) => a.topic === 'uns/#');
    assert.deepEqual(onRoot.map((a) => a.acltype).sort(), ['publishClientReceive', 'subscribePattern']);
  });

  test('a policy with no subscriber role is refused rather than silently ungranted', () => {
    const stripped = { ...POLICY, roles: POLICY.roles.filter((r) => r.rolename !== UNS_READER_ROLE) };
    assert.throws(() => withUnsReadGrant(stripped, 'uns'), (e) => e.code === 'invalid_policy');
  });

  test('an account an operator made holding it survives the boot, and a widened stored role is replaced', () => {
    // No account holds the role from the environment: an operator creates one over the control API,
    // and the reconcile keeps it as it keeps any client it does not manage.
    const stored = {
      clients: [clientFromPasswordEntry(entry('scada-reader'), [UNS_READER_ROLE])],
      roles: [{ rolename: UNS_READER_ROLE, acls: [{ acltype: 'publishClientSend', topic: '#', allow: true }] }],
      groups: [],
    };
    const managed = [clientFromPasswordEntry(entry('aber_ingestion'), rolesFor('ingestion'))];
    const { config, report } = reconcile(stored, booted(), managed);
    const kept = config.clients.find((c) => c.username === 'scada-reader');
    assert.deepEqual(kept.roles, [{ rolename: UNS_READER_ROLE }]);
    assert.ok(report.unmanaged.includes('scada-reader'));
    const role = config.roles.find((r) => r.rolename === UNS_READER_ROLE);
    assert.ok(!role.acls.some((a) => a.acltype === 'publishClientSend'), 'the stored publish survived the boot');
    assert.equal(role.acls.length, 4);
  });
});

describe('an upgraded broker loses the ingestion role\'s reads of the UNS and the Directory', () => {
  // Every release before 1.7 reconciled all three ACL types onto both subtrees, and the stored
  // document keeps them. The boot that follows the upgrade must leave only the writes.
  const UNS = 'plant/uns/#';
  const DIRECTORY = 'Plant-7/Directory/v1/#';
  const READS = ['subscribePattern', 'publishClientReceive'];
  const stored = () => {
    const ingestion = POLICY.roles.find((r) => r.rolename === 'ingestion');
    const old = [UNS, DIRECTORY].flatMap((topic) => ['publishClientSend', ...READS]
      .map((acltype) => ({ acltype, topic, priority: 0, allow: true })));
    return {
      clients: [clientFromPasswordEntry(entry(GW_A), rolesFor(null))],
      roles: [{ ...pluginRole(ingestion), acls: [...pluginRole(ingestion).acls, ...old] }],
      groups: [],
    };
  };
  const policy = () => withUnsGrant(withDirectoryGrant(withPrimaryHostGrant(POLICY, 'Site-One'), 'Plant-7/Directory/v1'), 'plant/uns');
  const managed = [clientFromPasswordEntry(entry('aber_ingestion'), rolesFor('ingestion'))];
  const subtreeAcls = (config) => config.roles.find((r) => r.rolename === 'ingestion').acls
    .filter((a) => a.topic === UNS || a.topic === DIRECTORY);

  test('the stored fixture holds the reads, so the assertions below can fail', () => {
    const acls = stored().roles[0].acls;
    for (const topic of [UNS, DIRECTORY]) {
      for (const acltype of READS) assert.ok(acls.some((a) => a.topic === topic && a.acltype === acltype), `${acltype} ${topic}`);
    }
  });

  test('the reconcile replaces the stored role, leaving one write on each subtree', () => {
    const { config } = reconcile(stored(), policy(), managed);
    assert.deepEqual(
      subtreeAcls(config).map((a) => [a.acltype, a.topic]).sort(),
      [['publishClientSend', DIRECTORY], ['publishClientSend', UNS]],
    );
  });

  test('a second boot on the converged document leaves it as it is', () => {
    const { config: first } = reconcile(stored(), policy(), managed);
    const { config: second } = reconcile(first, policy(), managed);
    assert.deepEqual(subtreeAcls(second), subtreeAcls(first));
    assert.deepEqual(second.clients.map((c) => c.username).sort(), first.clients.map((c) => c.username).sort());
  });
});

describe('a read-only account in the subscriber scheme holds the subscriber role and nothing else', () => {
  const SUB_A = 'sub0a1b2c3d4e5f60718293a';
  const SUB_B = 'sub00000000000000000000b';
  const managed = [clientFromPasswordEntry(entry('aber_ingestion'), rolesFor('ingestion'))];
  const booted = () => withUnsReadGrant(withUnsGrant(withPrimaryHostGrant(POLICY, 'Site-One'), 'uns'), 'uns');
  const rolesOf = (config, username) => config.clients.find((c) => c.username === username).roles;

  test('a drifted account is put right on the next boot, and its hash is kept', () => {
    // SUB_A was given ingestion and admin by hand, SUB_B lost its role: both hold subscriber alone.
    const stored = {
      clients: [
        clientFromPasswordEntry(entry(SUB_A, 'b2xkc2FsdHNhbHQ='), [SUBSCRIBER_ROLE, 'ingestion', 'admin']),
        clientFromPasswordEntry(entry(SUB_B), []),
      ],
      roles: [],
      groups: [],
    };
    const { config, report } = reconcile(stored, booted(), managed);
    assert.deepEqual(rolesOf(config, SUB_A), [{ rolename: SUBSCRIBER_ROLE }]);
    assert.deepEqual(rolesOf(config, SUB_B), [{ rolename: SUBSCRIBER_ROLE }]);
    assert.equal(config.clients.find((c) => c.username === SUB_A).salt, 'b2xkc2FsdHNhbHQ=');
    assert.deepEqual(report.subscribers.sort(), [SUB_A, SUB_B].sort());
    assert.deepEqual(report.reassertedSubscribers.sort(), [SUB_A, SUB_B].sort());
    assert.ok(!report.unmanaged.includes(SUB_A), 'a subscriber-scheme account was treated as unmanaged');
  });

  test('a group cannot hand one a second role: its membership is dropped and the group kept', () => {
    const stored = {
      clients: [clientFromPasswordEntry(entry(SUB_A), [SUBSCRIBER_ROLE]), clientFromPasswordEntry(entry('bi_reader'), [])],
      roles: [],
      groups: [{ groupname: 'writers', roles: [{ rolename: 'ingestion' }], clients: [{ username: SUB_A }, { username: 'bi_reader' }] }],
    };
    const { config, report } = reconcile(stored, booted(), managed);
    assert.deepEqual(config.groups, [{ groupname: 'writers', roles: [{ rolename: 'ingestion' }], clients: [{ username: 'bi_reader' }] }]);
    assert.deepEqual(report.reassertedSubscribers, [SUB_A]);
    assert.equal(stored.groups[0].clients.length, 2, 'the stored document was mutated');
  });

  test('an account already right is left exactly as it is, its stored entry included', () => {
    const client = { ...clientFromPasswordEntry(entry(SUB_A), []), roles: [{ rolename: SUBSCRIBER_ROLE, priority: 3 }], textname: 'BI feed' };
    const stored = { clients: [client], roles: [], groups: [] };
    const { config: first, report } = reconcile(stored, booted(), managed);
    assert.deepEqual(first.clients.find((c) => c.username === SUB_A), client);
    assert.deepEqual(report.reassertedSubscribers, []);
    const { config: second } = reconcile(first, booted(), managed);
    assert.deepEqual(second, first);
  });

  test('only the exact scheme is held to it: a name near it is an account made by hand, kept as it is', () => {
    const near = ['subscriber-1', 'sub0a1b2c3d4e5f60718293', 'SUB0A1B2C3D4E5F60718293A', 'sub0a1b2c3d4e5f60718293ag', 'xsub0a1b2c3d4e5f6071829'];
    const stored = { clients: near.map((u) => clientFromPasswordEntry(entry(u), ['ingestion'])), roles: [], groups: [] };
    const { config, report } = reconcile(stored, booted(), managed);
    for (const u of near) assert.deepEqual(rolesOf(config, u), [{ rolename: 'ingestion' }], u);
    assert.deepEqual(report.subscribers, []);
    assert.deepEqual(report.unmanaged.sort(), [...near].sort());
  });

  test('a platform principal of that shape is the environment\'s, not the scheme\'s', () => {
    const principal = clientFromPasswordEntry(entry(SUB_A), ['monitor']);
    const stored = { clients: [clientFromPasswordEntry(entry(SUB_A), [SUBSCRIBER_ROLE])], roles: [] };
    const { config } = reconcile(stored, booted(), [principal]);
    assert.deepEqual(rolesOf(config, SUB_A), [{ rolename: 'monitor' }]);
  });
});

describe('creating and deleting a read-only account over the control API', () => {
  const SUB = 'sub0a1b2c3d4e5f60718293a';
  const PASSWORD = 'password-0000000000000000';
  const PURPOSE = { name: '  Line 4 OEE board ', description: ' Reads line 4 for the contractor dashboard. ' };

  test('create is one client holding the subscriber role, with its name and description', () => {
    assert.deepEqual(createSubscriberCommand(SUB, PASSWORD, PURPOSE), {
      command: 'createClient',
      username: SUB,
      password: PASSWORD,
      textname: 'Line 4 OEE board',
      textdescription: 'Reads line 4 for the contractor dashboard.',
      roles: [{ rolename: 'subscriber' }],
    });
  });

  test('create refuses a username outside the scheme, a password outside the alphabet and a missing purpose', () => {
    for (const bad of ['gwy120000000000400080000', 'aber_ingestion', 'dynsec-admin', 'sub123', `${SUB}0`, SUB.toUpperCase(), '', null]) {
      assert.throws(() => createSubscriberCommand(bad, PASSWORD, PURPOSE), (e) => e.code === 'invalid_subscriber_id', String(bad));
    }
    assert.throws(() => createSubscriberCommand(SUB, 'not base64url!', PURPOSE), (e) => e.code === 'invalid_password');
    for (const name of ['', '   ', null, 'two\nlines', 'x'.repeat(81)]) {
      assert.throws(() => createSubscriberCommand(SUB, PASSWORD, { ...PURPOSE, name }), (e) => e.code === 'invalid_subscriber_name', JSON.stringify(name));
    }
    for (const description of [undefined, '', 'tab\there', 'x'.repeat(501)]) {
      assert.throws(() => createSubscriberCommand(SUB, PASSWORD, { ...PURPOSE, description }), (e) => e.code === 'invalid_subscriber_description', JSON.stringify(description));
    }
    // Counted in characters, as Postgres counts them.
    assert.doesNotThrow(() => createSubscriberCommand(SUB, PASSWORD, { name: 'é'.repeat(80), description: '\u{1F4C8}'.repeat(500) }));
  });

  test('create sends one createClient, and an account that exists is refused, never taken over', () => {
    const sent = [];
    const send = (command) => { sent.push(command); return { command: command.command }; };
    const made = createSubscriberWithControl(send, PURPOSE, PASSWORD);
    assert.match(made.username, /^sub[0-9a-f]{21}$/);
    assert.deepEqual(made, { username: made.username, name: 'Line 4 OEE board', description: 'Reads line 4 for the contractor dashboard.', roles: ['subscriber'] });
    assert.deepEqual(sent.map((c) => c.command), ['createClient']);
    assert.equal(sent[0].username, made.username);

    const taken = [];
    const exists = (command) => { taken.push(command.command); return { command: command.command, error: 'Client already exists' }; };
    assert.throws(() => createSubscriberWithControl(exists, PURPOSE, PASSWORD, SUB), (e) => e.code === 'broker_refused');
    assert.deepEqual(taken, ['createClient'], 'an existing account was re-issued');
  });

  test('two creates make two usernames', () => {
    const send = (command) => ({ command: command.command });
    const names = new Set(Array.from({ length: 20 }, () => createSubscriberWithControl(send, PURPOSE, PASSWORD).username));
    assert.equal(names.size, 20);
  });

  test('delete reads the account for its purpose, then deletes it, and grants or removes no role', () => {
    const sent = [];
    const send = (command) => {
      sent.push(command.command);
      if (command.command === 'getClient') {
        return { data: { client: { username: SUB, textname: 'Line 4 OEE board', textdescription: 'Reads line 4.', roles: [{ rolename: 'subscriber' }], connections: [{}] } } };
      }
      return { command: command.command };
    };
    assert.deepEqual(deleteSubscriberWithControl(send, SUB), {
      existed: true, deleted: true, name: 'Line 4 OEE board', description: 'Reads line 4.', roles: ['subscriber'],
    });
    assert.deepEqual(sent, ['getClient', 'deleteClient']);
  });

  test('deleting an account the broker does not hold deletes nothing', () => {
    const sent = [];
    const send = (command) => { sent.push(command.command); return { command: command.command, error: 'Client not found' }; };
    assert.deepEqual(deleteSubscriberWithControl(send, SUB), { existed: false, deleted: false, name: null, description: null, roles: [] });
    assert.deepEqual(sent, ['getClient']);
  });

  test('delete refuses every username outside the scheme before anything is sent', () => {
    for (const bad of ['gwy120000000000400080000', 'gwy110000000000400080000', 'aber_ingestion', 'aber_i3x', 'aber_monitor', 'dynsec-admin', 'scada-reader', '']) {
      let sent = 0;
      assert.throws(() => deleteSubscriberWithControl(() => { sent += 1; return {}; }, bad), (e) => e.code === 'invalid_subscriber_id', bad);
      assert.throws(() => deleteSubscriberCommand(bad), (e) => e.code === 'invalid_subscriber_id', bad);
      assert.equal(sent, 0, bad);
    }
  });

  test('the inventory carries what an account is for, and null where the plugin holds nothing', () => {
    const clients = { data: { clients: [
      { username: SUB, textname: 'Line 4 OEE board', textdescription: 'Reads line 4.', roles: [{ rolename: 'subscriber' }], connections: [] },
      { username: GW_A, roles: [{ rolename: 'gateway' }], connections: [] },
    ] } };
    const summary = summariseInventory(clients, null);
    assert.deepEqual(summary.clients.map((c) => [c.username, c.textname, c.textdescription]), [
      [SUB, 'Line 4 OEE board', 'Reads line 4.'], [GW_A, null, null],
    ]);
  });
});

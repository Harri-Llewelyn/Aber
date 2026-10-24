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
      { username: GW_A, roles: ['gateway'], disabled: false, connections: null },
      { username: GW_B, roles: [], disabled: true, connections: null },
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

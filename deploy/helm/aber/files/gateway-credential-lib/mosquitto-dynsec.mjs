// The broker's Dynamic Security policy, as pure functions over its JSON document: one definition of a
// gateway's roles, one parser for the control API's replies, and one reconcile that never drops a
// client. Shared by the boot reconcile, the credential service, the operator CLI and the orphan
// sweep. Nothing here touches a filesystem, a broker or a shell. mosquitto/README.md is the
// reasoning; this file is the shape.
import { CredentialError, GATEWAY_ID_PATTERN, assertEntry, isGatewayId } from './mosquitto-credentials.mjs';

// The topic the plugin listens on, and where it answers.
export const CONTROL_TOPIC = '$CONTROL/dynamic-security/v1';
export const CONTROL_RESPONSE_TOPIC = '$CONTROL/dynamic-security/v1/response';

// Where the plugin keeps its document; mosquitto.conf names this path.
export const DYNSEC_FILE = '/mosquitto/data/dynamic-security.json';

// The role every gateway holds, and the prefix of the role only that gateway holds. The plugin on
// 2.0.x does not substitute %u in an ACL topic (measured), so confinement is one literal role per
// gateway rather than one pattern rule.
export const GATEWAY_SHARED_ROLE = 'gateway';
export const GATEWAY_ROLE_PREFIX = 'gateway-';

// The platform principals the boot reconcile owns: the env pair each is read from and the policy
// role it holds. role: null marks a gateway account, which holds the gateway roles for its own id.
export const PLATFORM_PRINCIPALS = [
  { env: 'INGESTION', role: 'ingestion' },
  { env: 'I3X', role: 'i3x' },
  { env: 'MONITOR', role: 'monitor' },
  { env: 'VALIDATOR', role: null },
];

// The role the credential service authenticates under.
export const ADMIN_ROLE = 'admin';

// The role that publishes the Sparkplug primary-host STATE, and the one topic it may write. Not a
// line in dynsec-roles.json: the host id is the deployment's, so the grant is injected at reconcile
// time. One literal topic rather than spBv1.0/STATE/#, because a wildcard would let this principal
// announce the death of someone else's host id.
export const PRIMARY_HOST_ROLE = 'ingestion';

// One topic level, so the literal grant below is the whole permission.
const PRIMARY_HOST_ID_PATTERN = /^[^/+#\s]+$/;

export function primaryHostStateTopic(hostId) {
  if (typeof hostId !== 'string' || !PRIMARY_HOST_ID_PATTERN.test(hostId)) {
    throw new CredentialError(
      `'${hostId}' is not a usable Sparkplug host id: it must be one topic level, with no '/', `
      + "'+', '#' or whitespace",
      'invalid_primary_host_id',
    );
  }
  return `spBv1.0/STATE/${hostId}`;
}

// Returns a NEW policy, so the document read from disk still matches the repository's file. Adding
// the same grant twice is a no-op, which keeps the boot reconcile idempotent across restarts.
export function withPrimaryHostGrant(policy, hostId) {
  const topic = primaryHostStateTopic(hostId);
  const roles = (policy?.roles || []).map((role) => {
    if (role.rolename !== PRIMARY_HOST_ROLE) return role;
    const acls = role.acls || [];
    const already = acls.some((a) => a.acltype === 'publishClientSend' && a.topic === topic);
    return already ? role : { ...role, acls: [...acls, { acltype: 'publishClientSend', topic, allow: true }] };
  });
  if (!roles.some((r) => r.rolename === PRIMARY_HOST_ROLE)) {
    throw new CredentialError(
      `the policy declares no '${PRIMARY_HOST_ROLE}' role, so the primary host has nothing to grant`,
      'invalid_policy',
    );
  }
  return { ...policy, roles };
}

// The role that writes the Directory, and the subtree it may write. Not in the roles file for the
// same reason: the subtree is named after the site's Sparkplug group, rendered once by the chart for
// both the daemon and this reconcile, so a broker granted one subtree while the daemon publishes
// another cannot happen.
export const DIRECTORY_ROLE = 'ingestion';

// No wildcard and no separator of its own: the grant appends /# and that is the whole width.
const DIRECTORY_PREFIX_PATTERN = /^[^+#\s]+$/;

export function directoryTopicFilter(prefix) {
  const clean = typeof prefix === 'string' ? prefix.trim().replace(/\/+$/, '') : '';
  if (!clean || !DIRECTORY_PREFIX_PATTERN.test(clean)) {
    throw new CredentialError(
      `'${prefix}' is not a usable Directory topic prefix: it must be non-empty and contain no `
      + "'+', '#' or whitespace",
      'invalid_directory_prefix',
    );
  }
  return `${clean}/#`;
}

// Returns a NEW policy; applying it twice is a no-op.
export function withDirectoryGrant(policy, prefix) {
  const topic = directoryTopicFilter(prefix);
  const acltypes = ['publishClientSend', 'subscribePattern', 'publishClientReceive'];
  const roles = (policy?.roles || []).map((role) => {
    if (role.rolename !== DIRECTORY_ROLE) return role;
    const acls = role.acls || [];
    const missing = acltypes
      .filter((acltype) => !acls.some((a) => a.acltype === acltype && a.topic === topic))
      .map((acltype) => ({ acltype, topic, allow: true }));
    return missing.length ? { ...role, acls: [...acls, ...missing] } : role;
  });
  if (!roles.some((r) => r.rolename === DIRECTORY_ROLE)) {
    throw new CredentialError(
      `the policy declares no '${DIRECTORY_ROLE}' role, so the Directory has nothing to grant`,
      'invalid_policy',
    );
  }
  return { ...policy, roles };
}

export function gatewayRoleName(sparkplugId) {
  if (!isGatewayId(sparkplugId)) {
    throw new CredentialError(`'${sparkplugId}' is not a gateway sparkplug_id`, 'invalid_sparkplug_id');
  }
  return `${GATEWAY_ROLE_PREFIX}${sparkplugId}`;
}

// Both roles a gateway client holds, shared first.
export function gatewayRoleNames(sparkplugId) {
  return [GATEWAY_SHARED_ROLE, gatewayRoleName(sparkplugId)];
}

// Publish and receive beneath its own edge node, and nothing else. Read of spBv1.0/STATE/# and the
// subscribe grant come from the shared role.
export function gatewayRole(sparkplugId) {
  const topic = `spBv1.0/+/+/${sparkplugId}/#`;
  return {
    rolename: gatewayRoleName(sparkplugId),
    acls: [
      { acltype: 'publishClientSend', topic, allow: true },
      { acltype: 'publishClientReceive', topic, allow: true },
    ],
  };
}

export function isGatewayRoleName(rolename) {
  return typeof rolename === 'string'
    && rolename.startsWith(GATEWAY_ROLE_PREFIX)
    && GATEWAY_ID_PATTERN.test(rolename.slice(GATEWAY_ROLE_PREFIX.length));
}

// One user:$7$iterations$salt$hash line as the plugin's client fields. mosquitto_passwd and the
// plugin share PBKDF2-SHA512 with the same framing, so a hash moves between them unchanged
// (measured on 2.0.22: a transplanted entry authenticates).
export function clientFromPasswordEntry(line, roles = []) {
  const m = /^([^:]+):\$7\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(line || '').trim());
  if (!m) {
    throw new CredentialError(`not a $7$ password entry: ${String(line).slice(0, 80)}`, 'hash_mismatch');
  }
  const [, username, iterations, salt, password] = m;
  return {
    username,
    password,
    salt,
    iterations: Number.parseInt(iterations, 10),
    roles: roles.map((rolename) => ({ rolename })),
  };
}

// A validated mosquitto_passwd line for username, as a client.
export function clientFromHash(entry, username, roles) {
  return clientFromPasswordEntry(assertEntry(entry, username), roles);
}

// Every account in a password file, with roles assigned by name; anything unrecognised takes none
// and is reported so an operator can decide. Malformed lines are reported, never silently dropped.
export function importPasswordFile(text, platformRoles = new Map()) {
  const clients = [];
  const unassigned = [];
  const malformed = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let client;
    try {
      client = clientFromPasswordEntry(line);
    } catch {
      malformed.push(line.split(':')[0]);
      continue;
    }
    if (platformRoles.has(client.username)) {
      client.roles = rolesFor(platformRoles.get(client.username), client.username);
    } else if (isGatewayId(client.username)) {
      client.roles = gatewayRoleNames(client.username).map((rolename) => ({ rolename }));
    } else {
      unassigned.push(client.username);
    }
    clients.push(client);
  }
  return { clients, unassigned, malformed };
}

// The role list a platform principal holds: its named role, or the gateway pair.
export function rolesFor(role, username) {
  const names = role ? [role] : gatewayRoleNames(username);
  return names.map((rolename) => ({ rolename }));
}

export function emptyConfig() {
  return { clients: [], roles: [], groups: [] };
}

function roleNamesOf(client) {
  return (client.roles || []).map((r) => r.rolename);
}

// The document the broker should boot on, from the one it has and what the repository declares.
// Roles: every policy role replaces the stored one of its name, a gateway-<id> role is regenerated
// for every gateway client, any other stored role is kept. Clients: every managed client replaces
// the stored one of its name, every other stored client is kept, a gateway client with the gateway
// roles ensured. THROWS rather than return a document missing a client: the stored document is the
// fleet's credentials, and a boot that lost one would fail silently at the appliance's next reconnect.
export function reconcile(existing, policy, managedClients) {
  const stored = existing && typeof existing === 'object' ? existing : emptyConfig();
  if (!Array.isArray(policy?.roles) || policy.roles.length === 0) {
    throw new CredentialError('the policy declares no roles', 'invalid_policy');
  }
  if (!policy.defaultACLAccess || typeof policy.defaultACLAccess !== 'object') {
    throw new CredentialError('the policy declares no defaultACLAccess', 'invalid_policy');
  }
  const policyRoleNames = new Set(policy.roles.map((r) => r.rolename));
  if (!policyRoleNames.has(GATEWAY_SHARED_ROLE) || !policyRoleNames.has(ADMIN_ROLE)) {
    throw new CredentialError(
      `the policy must declare the '${GATEWAY_SHARED_ROLE}' and '${ADMIN_ROLE}' roles`, 'invalid_policy',
    );
  }

  const managedByName = new Map();
  for (const c of managedClients || []) {
    if (managedByName.has(c.username)) {
      throw new CredentialError(`managed client '${c.username}' is declared twice`, 'invalid_policy');
    }
    managedByName.set(c.username, c);
  }

  const before = new Set((stored.clients || []).map((c) => c.username));
  const clients = [];
  const report = { managed: [], kept: [], gateways: [], unmanaged: [] };

  for (const c of managedByName.values()) {
    clients.push(c);
    report.managed.push(c.username);
  }
  for (const c of stored.clients || []) {
    if (managedByName.has(c.username)) continue;
    const client = { ...c, roles: (c.roles || []).map((r) => ({ ...r })) };
    if (isGatewayId(client.username)) {
      const have = new Set(roleNamesOf(client));
      for (const rolename of gatewayRoleNames(client.username)) {
        if (!have.has(rolename)) client.roles.push({ rolename });
      }
      report.gateways.push(client.username);
    } else {
      report.unmanaged.push(client.username);
    }
    clients.push(client);
    report.kept.push(client.username);
  }

  const after = new Set(clients.map((c) => c.username));
  const lost = [...before].filter((u) => !after.has(u));
  if (lost.length) {
    throw new CredentialError(
      `refusing to write a document that would LOSE client(s) ${lost.join(', ')}`, 'merge_would_lose_accounts',
    );
  }
  if (after.size !== clients.length) {
    throw new CredentialError('the stored document holds duplicate usernames; repair it by hand', 'duplicate_accounts');
  }

  const roles = policy.roles.map((r) => JSON.parse(JSON.stringify(r)));
  for (const c of clients) {
    if (isGatewayId(c.username)) roles.push(gatewayRole(c.username));
  }
  const generated = new Set(roles.map((r) => r.rolename));
  for (const r of stored.roles || []) {
    if (generated.has(r.rolename)) continue;
    // A role for a gateway that no longer has a client: regenerated from the id so a client re-created
    // by hand still confines, and never deleted, because deleting a role in use took the broker down.
    if (isGatewayRoleName(r.rolename)) {
      roles.push(gatewayRole(r.rolename.slice(GATEWAY_ROLE_PREFIX.length)));
    } else {
      roles.push(r);
    }
    generated.add(r.rolename);
  }

  const config = {
    defaultACLAccess: { ...policy.defaultACLAccess },
    clients,
    roles,
    groups: Array.isArray(stored.groups) ? stored.groups : [],
  };
  return { config, report };
}

// The message the plugin takes: one or more commands, answered in order.
export function controlPayload(commands) {
  return JSON.stringify({ commands });
}

// The plugin's reply as an array of responses. Empty output is mosquitto_rr timing out: a transport
// failure, not a refusal.
export function parseControlResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new CredentialError('the broker did not answer', 'backend_unavailable');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialError(`the broker answered something other than JSON: ${raw.slice(0, 120)}`, 'backend_unavailable');
  }
  if (!Array.isArray(parsed?.responses)) {
    throw new CredentialError('the broker\'s reply carries no responses', 'backend_unavailable');
  }
  return parsed.responses;
}

// mosquitto_rr's argument vector for one request. The payload rides on argv with -m: measured on
// 2.0.22, -s (stdin) and -f (file) both deliver a payload the plugin answers with "Payload not valid
// JSON". A password on argv is visible to the container's own process list for the request's
// duration, the exposure mosquitto_passwd -b has always had.
export function controlArgv({ host, port, username, password, timeoutSeconds = 5 }, payload) {
  return [
    '-h', String(host), '-p', String(port),
    '-u', String(username), '-P', String(password),
    '-t', CONTROL_TOPIC, '-e', CONTROL_RESPONSE_TOPIC,
    '-W', String(timeoutSeconds),
    '-m', String(payload),
  ];
}

// The commands that issue a gateway's account: its role, then the client holding both roles.
// Idempotent through the replies: "already exists" is the signal to fall back to setClientPassword
// and enableClient.
export function issueCommands(sparkplugId, password) {
  return [
    { command: 'createRole', ...gatewayRole(sparkplugId) },
    {
      command: 'createClient',
      username: sparkplugId,
      password,
      roles: gatewayRoleNames(sparkplugId).map((rolename) => ({ rolename })),
    },
  ];
}

// Whether a response is the plugin refusing with the given text.
export function isRefusal(response, text) {
  return typeof response?.error === 'string' && response.error.includes(text);
}

// The response, or a CredentialError naming the refusal.
export function assertOk(response) {
  if (response?.error) {
    throw new CredentialError(`${response.command}: ${response.error}`, 'broker_refused');
  }
  return response || {};
}

// Issue through `send`, a function taking one command and returning its response. Creates the role
// and the client; when the client exists already, sets its password first (a rotation that fails
// part-way has still rotated), enables it, and makes sure it holds both roles. `replaced` says which
// path was taken. Shared by the service and the operator CLI so the two cannot differ on the fallback.
export function issueWithControl(send, sparkplugId, password) {
  const [roleCommand, clientCommand] = issueCommands(sparkplugId, password);

  const role = send(roleCommand);
  if (!isRefusal(role, 'already exists')) assertOk(role);

  const created = send(clientCommand);
  if (!isRefusal(created, 'already exists')) {
    assertOk(created);
    return { replaced: false };
  }

  assertOk(send({ command: 'setClientPassword', username: sparkplugId, password }));
  assertOk(send({ command: 'enableClient', username: sparkplugId }));

  const current = assertOk(send({ command: 'getClient', username: sparkplugId }));
  const held = new Set((current.data?.client?.roles || []).map((r) => r.rolename));
  for (const rolename of gatewayRoleNames(sparkplugId)) {
    if (held.has(rolename)) continue;
    assertOk(send({ command: 'addClientRole', username: sparkplugId, rolename }));
  }
  return { replaced: true };
}

// A summary the dashboard can render: no hashes, no salts, and the role's ACLs in full.
export function summariseInventory(clientsResponse, rolesResponse) {
  const clients = (clientsResponse?.data?.clients || []).map((c) => ({
    username: c.username,
    roles: roleNamesOf(c),
    disabled: c.disabled === true,
  }));
  const roles = (rolesResponse?.data?.roles || []).map((r) => ({
    rolename: r.rolename,
    acls: (r.acls || []).map((a) => ({ acltype: a.acltype, topic: a.topic, allow: a.allow !== false })),
  }));
  return { clients, roles };
}

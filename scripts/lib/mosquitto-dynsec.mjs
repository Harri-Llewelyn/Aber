// The broker's Dynamic Security policy, as pure functions over its JSON document: one definition of
// what a gateway holds, one parser for the control API's replies, and one reconcile that never drops
// a client. Shared by the boot reconcile, the credential service, the operator CLI and the orphan
// sweep. Nothing here touches a filesystem, a broker or a shell. mosquitto/README.md is the
// reasoning; this file is the shape.
import {
  CredentialError, GATEWAY_ID_PATTERN, assertEntry, assertGatewayId, isGatewayId,
} from './mosquitto-credentials.mjs';

// The topic the plugin listens on, and where it answers.
export const CONTROL_TOPIC = '$CONTROL/dynamic-security/v1';
export const CONTROL_RESPONSE_TOPIC = '$CONTROL/dynamic-security/v1/response';

// Where the plugin keeps its document; mosquitto.conf names this path.
export const DYNSEC_FILE = '/mosquitto/data/dynamic-security.json';

// The one role every gateway holds. Its spBv1.0/+/+/%u/# rules confine a client to the edge node its
// username names, and a gateway's username is its sparkplug_id. The plugin substitutes %u from 2.1,
// in every ACL type but subscribeLiteral and unsubscribeLiteral.
export const GATEWAY_SHARED_ROLE = 'gateway';

// The prefix of the role generated per gateway before %u worked. The boot reconcile retires them.
export const RETIRED_GATEWAY_ROLE_PREFIX = 'gateway-';

// The platform principals the boot reconcile owns: the env pair each is read from and the policy
// role it holds. role: null marks a gateway account, which holds the gateway role.
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

// Publish on `topic` for one role, and nothing else: the role writes the tree and nothing on the
// platform reads it as that role. Returns a NEW policy; applying it twice is a no-op. A stored role
// holding the reads earlier releases granted loses them because reconcile replaces it whole.
function withSubtreeGrant(policy, rolename, topic, what) {
  const roles = (policy?.roles || []).map((role) => {
    if (role.rolename !== rolename) return role;
    const acls = role.acls || [];
    const already = acls.some((a) => a.acltype === 'publishClientSend' && a.topic === topic);
    return already ? role : { ...role, acls: [...acls, { acltype: 'publishClientSend', topic, allow: true }] };
  });
  if (!roles.some((r) => r.rolename === rolename)) {
    throw new CredentialError(
      `the policy declares no '${rolename}' role, so ${what} has nothing to grant`,
      'invalid_policy',
    );
  }
  return { ...policy, roles };
}

export function withDirectoryGrant(policy, prefix) {
  return withSubtreeGrant(policy, DIRECTORY_ROLE, directoryTopicFilter(prefix), 'the Directory');
}

// The role that writes the Unified Namespace, and the subtree it may write. Not in the roles file
// for the same reason: the root is the deployment's (ingestion.unsMqttTopicRoot), rendered once by
// the chart for both uns_publish.py and this reconcile.
export const UNS_ROLE = 'ingestion';

// Trimmed of slashes at both ends, as uns_publish.py trims it; the root may span levels.
export function unsTopicFilter(root) {
  const clean = typeof root === 'string' ? root.trim().replace(/^\/+|\/+$/g, '') : '';
  if (!clean || !DIRECTORY_PREFIX_PATTERN.test(clean)) {
    throw new CredentialError(
      `'${root}' is not a usable Unified Namespace root: it must be non-empty and contain no `
      + "'+', '#' or whitespace",
      'invalid_uns_root',
    );
  }
  return `${clean}/#`;
}

export function withUnsGrant(policy, root) {
  return withSubtreeGrant(policy, UNS_ROLE, unsTopicFilter(root), 'the Unified Namespace');
}

// A role generated per gateway before 2.1: gateway-<sparkplug_id>, and nothing near it.
export function isRetiredGatewayRoleName(rolename) {
  return typeof rolename === 'string'
    && rolename.startsWith(RETIRED_GATEWAY_ROLE_PREFIX)
    && GATEWAY_ID_PATTERN.test(rolename.slice(RETIRED_GATEWAY_ROLE_PREFIX.length));
}

// The keys the plugin defines for an ACL. The roles file also gives each ACL a `why` for people to
// read; only these keys reach the document the plugin loads.
const PLUGIN_ACL_KEYS = ['acltype', 'topic', 'priority', 'allow'];

// A policy role as the plugin is given it: a copy, with each ACL cut down to PLUGIN_ACL_KEYS.
export function pluginRole(role) {
  const copy = JSON.parse(JSON.stringify(role));
  copy.acls = (copy.acls || []).map((acl) => Object.fromEntries(
    PLUGIN_ACL_KEYS.filter((key) => key in acl).map((key) => [key, acl[key]]),
  ));
  return copy;
}

// One user:$7$iterations$salt$hash line as the plugin's client fields. mosquitto_passwd and the
// plugin share PBKDF2-SHA512 with the same framing, so a hash moves between them unchanged
// (measured on 2.0.22 and 2.1.2: a transplanted entry authenticates).
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

// The role list a platform principal holds: its named role, or the gateway role.
export function rolesFor(role) {
  return [{ rolename: role || GATEWAY_SHARED_ROLE }];
}

export function emptyConfig() {
  return { clients: [], roles: [], groups: [] };
}

function roleNamesOf(client) {
  return (client.roles || []).map((r) => r.rolename);
}

// The document the broker should boot on, from the one it has and what the repository declares.
// Roles: every policy role replaces the stored one of its name, a retired gateway-<id> role is
// dropped, any other stored role is kept. Clients: every managed client replaces the stored one of
// its name, every other stored client is kept, and a gateway client holds the gateway role and no
// retired one. The broker is down while this runs, so no connected client holds what is dropped.
// THROWS rather than return a document missing any other client: the stored document is the fleet's
// credentials, and a boot that lost one would fail silently at the appliance's next reconnect.
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
  const report = { managed: [], kept: [], gateways: [], unmanaged: [], retiredMemberships: 0, retiredRoles: [] };

  for (const c of managedByName.values()) {
    clients.push(c);
    report.managed.push(c.username);
  }
  for (const c of stored.clients || []) {
    if (managedByName.has(c.username)) continue;
    const client = { ...c, roles: (c.roles || []).map((r) => ({ ...r })) };
    if (isGatewayId(client.username)) {
      const held = client.roles.length;
      client.roles = client.roles.filter((r) => !isRetiredGatewayRoleName(r.rolename));
      report.retiredMemberships += held - client.roles.length;
      if (!roleNamesOf(client).includes(GATEWAY_SHARED_ROLE)) client.roles.push({ rolename: GATEWAY_SHARED_ROLE });
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

  const roles = policy.roles.map(pluginRole);
  const declared = new Set(roles.map((r) => r.rolename));
  for (const r of stored.roles || []) {
    if (declared.has(r.rolename)) continue;
    if (isRetiredGatewayRoleName(r.rolename)) {
      report.retiredRoles.push(r.rolename);
      continue;
    }
    roles.push(r);
    declared.add(r.rolename);
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

// mosquitto_rr's argument vector for one request. The payload rides on argv with -m: before 2.1,
// -s (stdin) and -f (file) delivered a payload the plugin answered with "Payload not valid JSON".
// A password on argv is visible to the container's own process list for the request's duration,
// the exposure mosquitto_passwd -b has always had.
export function controlArgv({ host, port, username, password, timeoutSeconds = 5 }, payload) {
  return [
    '-h', String(host), '-p', String(port),
    '-u', String(username), '-P', String(password),
    '-t', CONTROL_TOPIC, '-e', CONTROL_RESPONSE_TOPIC,
    '-W', String(timeoutSeconds),
    '-m', String(payload),
  ];
}

// The command that issues a gateway's account: a client holding the gateway role. Idempotent through
// the reply: "already exists" is the signal to fall back to setClientPassword and enableClient.
export function issueCommand(sparkplugId, password) {
  assertGatewayId(sparkplugId);
  return {
    command: 'createClient',
    username: sparkplugId,
    password,
    roles: [{ rolename: GATEWAY_SHARED_ROLE }],
  };
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

// Issue through `send`, a function taking one command and returning its response. Creates the
// client; when it exists already, sets its password first (a rotation that fails part-way has still
// rotated), enables it, and makes sure it holds the gateway role. `replaced` says which path was
// taken. Shared by the service and the operator CLI so the two cannot differ on the fallback.
export function issueWithControl(send, sparkplugId, password) {
  const created = send(issueCommand(sparkplugId, password));
  if (!isRefusal(created, 'already exists')) {
    assertOk(created);
    return { replaced: false };
  }

  assertOk(send({ command: 'setClientPassword', username: sparkplugId, password }));
  assertOk(send({ command: 'enableClient', username: sparkplugId }));

  const current = assertOk(send({ command: 'getClient', username: sparkplugId }));
  const held = (current.data?.client?.roles || []).map((r) => r.rolename);
  if (!held.includes(GATEWAY_SHARED_ROLE)) {
    assertOk(send({ command: 'addClientRole', username: sparkplugId, rolename: GATEWAY_SHARED_ROLE }));
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

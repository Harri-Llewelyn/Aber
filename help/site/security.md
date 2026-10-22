# Keeping Aber secure

**In short:** what an administrator does to keep Aber safe, and where each part is explained in
full. Aber is built for one site's own network, and it refuses everything a rule does not allow.
The reference behind this page is the [security model](../../docs/security-model.md), which says
how each part works and which risks Aber accepts.

## Keep it on the site's network

- **Aber runs on your site's own network.** It is not built to face the internet, or to run in the
  cloud.
- **To reach it from outside the site, use a VPN you manage.** Aber does not support public
  certificates.
- **Install the root certificate on the computers people use.** Every service uses certificates from
  Aber's own [internal CA](../guides/glossary.md#internal-ca-and-root-certificate). Step 8 of
  [Installing Aber](install.md#8-install-the-root-certificate) says how.

## People and their roles

- **Add people and set their roles on the Access Control page**, under **People**
  ([Access Control](../pages/access-control.md)). Only an Administrator can.
- **Give each person the smallest role that does their job.** The [roles](../guides/glossary.md#roles)
  are Administrator, Shopfloor_Manager, Operator and Auditor.
- **Nobody can change their own role, access or password there.** One Administrator who can sign in
  always remains, so make someone else an Administrator before you step down.
- **When someone leaves, use Remove Access.** Their account is blocked, not deleted, so the Audit
  Trail still names them.

Removing access works within a minute almost everywhere. Grafana can take up to an hour. If the
person was an Administrator, check Node-RED's flows, Grafana and the Audit Trail afterwards. Each
window is listed in
[A removed person keeps what a session already holds](../../docs/security-model.md#a-removed-person-keeps-what-a-session-already-holds).

A new password does not stop someone at once: they keep their role meanwhile. To stop someone, use
Remove Access first
([A new password does not end a session at once](../../docs/security-model.md#a-new-password-does-not-end-a-session-at-once)).

## Machines

- **Aber's own services sign in as [machine identities](../guides/glossary.md#machine-identity).**
  Each holds only what it needs, and none can sign in to the dashboard.
- **An Administrator can make another one** on Access Control, under **Machine identities**. It
  reaches the database only, never the broker. Its first token is shown once, so copy it then.
- **Machines propose, people decide.** A machine identity can file a change for someone to approve.
  It cannot approve one.
- **A revoked token is refused by the API at once.** Storage, Realtime, the edge functions' runtime
  and Studio accept it until it expires, at most 90 days later
  ([Revocation reaches PostgREST and nothing else](../../docs/security-model.md#revocation-reaches-postgrest-and-nothing-else)).

## Gateways

- **Each gateway has its own broker account.** It can publish only as itself, so one gateway cannot
  send another's readings.
- **When a gateway's computer is lost, stolen or scrapped, archive the gateway straight away.** That
  disables its broker account and drops its connection. It also removes its key to the forge
  ([An appliance that is lost, stolen or scrapped](../../docs/remote-gateways.md#an-appliance-that-is-lost-stolen-or-scrapped)).
- **An Administrator can show a Host, Simulated or Third-party gateway's broker password again.**
  Each showing is recorded in the Audit Trail
  ([Host gateway passwords are kept](../../docs/security-model.md#host-gateway-passwords-are-kept-and-administrators-can-see-them)).

## Protect the root key

The internal CA's private key is the one thing in Aber that cannot be revoked. It is kept in the
Kubernetes Secret `aber-ca-key-pair`. Treat that Secret as the most sensitive object on the server.
If its key is ever exposed, the only remedy is a new root, installed on every gateway and every
computer again
([There is no revocation list](../../docs/remote-gateways.md#there-is-no-revocation-list-and-that-is-a-decision)).

## Turn on network policies

Network policies are off when Aber is installed. Off, any part of the server can reach any other.
Turn them on before the forge holds real flows. The runbook's
[NetworkPolicies](../../deploy/k8s/README.md#networkpolicies-m4) section gives the settings
([NetworkPolicy is opt-in](../../docs/security-model.md#networkpolicy-is-opt-in)).

## Report a problem

To report a security problem in Aber, follow [`SECURITY.md`](../../SECURITY.md). Please do not open
a public issue for it.

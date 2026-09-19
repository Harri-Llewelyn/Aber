## Summary

Who and what can reach this platform, and with which authority. It covers both kinds of principal: the people who sign in, and the machines that do not -- gateways, connectors and services that hold a credential of their own.

## What the controls do

- **Identity** is the principal. **Holds** is what it currently has -- a role, a credential, a token. **Reaches** is what that lets it get to, and **Purpose** is why it exists, which is the field that makes an unfamiliar machine principal safe to leave alone or safe to remove.
- **Mint** and **Issue** create a credential. A machine credential is shown once, at the moment it is created, and cannot be re-shown -- if it is lost, the answer is to issue another and revoke the first.
- **New Principal** creates a database identity for a process that reads this platform through the API: a name, a purpose and read-only permissions from a fixed menu, then its first token. It reaches the database only. A process that speaks MQTT is issued a broker account, not a principal.
- **MQTT username** and **ACL pattern** are the broker half: the identity the principal connects as, and the topic rules that bound what it may publish or subscribe to.

## What the states mean

- **CANNOT SIGN IN** -- the principal is a machine. It has no password and no session; it holds a credential instead. This is the normal state for a gateway, not a fault.
- **No platform record** -- something exists on one side of the boundary and not the other. It is worth looking at, because it usually means a manual change was made somewhere this page cannot see.
- **ARCHIVED** -- decommissioned deliberately, and retained so that history still resolves.

**Revoking a principal reaches further than revoking its tokens.** A token can be withdrawn one at a time; withdrawing the principal withdraws everything issued to it, including what nobody remembered was issued. When the question is "make this stop", the principal is the answer.

## What this page is not

**It is not an inventory of the broker.** It lists the identities this platform issued and knows about. A client connecting with a credential the platform did not mint is not shown here, and the broker's own configuration is the authority on what the broker will accept.

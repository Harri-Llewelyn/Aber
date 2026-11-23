### From 1.9.0, a revocation is asked until the broker confirms it

Archiving a gateway, deleting it, changing its type to or from Remote, and setting a Remote gateway up
again each end its broker credential. Aber now asks the broker to disable the account until the broker
confirms it, every 15 minutes, whatever the gateway's type. It keeps asking after the gateway is
archived or deleted, and when the credential service is not configured yet (migrations `0311` and
`0312`).

#### What to check after you upgrade

1. Wait 15 minutes after the upgrade. In that time Aber asks the broker again for every revocation it
   has a record of, and for every archived gateway that ever held a credential.
2. Sign in as an Administrator and open **Access Control › Broker credentials**.
3. Look for a **Broker** column that reads **Active** for a gateway that is archived, or whose
   **Credential** reads **Revoked**. If one stays Active, the credential service cannot be reached:
   check that it is running.
4. Look for a gateway that is not archived and whose type changed to or from Remote before the
   upgrade. If its account is Active and the gateway should not be connecting, give it a new
   credential. Use **Generate Broker Credential**, or **Re-issue Setup** for a Remote gateway. Either
   replaces the old password.
5. Look for accounts marked **No gateway**. They belong to gateways deleted before the upgrade, which
   Aber has no record of. List them with `node scripts/revoke-orphaned-broker-accounts.mjs`, and
   disable them with `--yes`. The script never deletes an account.

#### What changes

- **Re-issue Setup** for an enrolled gateway disables the old appliance's broker account at once. The
  new appliance is given a new password when it enrols. The drawer now offers Re-issue Setup for an
  enrolled gateway that is offline or stale, after you type its name. It is never offered while the
  gateway is online.
- **Changing a gateway's type away from Remote** removes its appliance's deploy key from the forge, as
  archiving does. The repository is kept. Set the gateway up again to give a new appliance a key.
- **An archived gateway's Credential reads Revoked** while Aber is still asking the broker. It used to
  flip back to Issued while a failed request waited to be asked again.

A script of your own that reads `gateway_revocation_requests` should expect `request_id` to be empty
for a revocation that could not be asked yet. A deleted gateway's revocation is kept in
`deleted_gateway_revocations` until the broker confirms it. Nothing needs doing before you upgrade.

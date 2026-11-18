### From 1.9.0, a restored gateway keeps its revocation stamp

Restoring an archived gateway used to clear `credential_revoked_at`, the time its broker account was
disabled. The account stayed disabled, so the record said Issued where the broker said Disabled. A restore
now leaves the stamp (migration `0308`).

What you see after you restore a gateway:

- The **Credential** column on Access Control reads **Revoked**, beside a **Broker** column that reads
  **Disabled**. The two now agree.
- A **Remote** gateway is offered **Set Up Gateway** in its drawer, as the Restore dialog says. Run it to
  give the appliance a new setup command. The appliance enrols again and is given a new credential.
- A **Host**, **Simulated** or **Third-party** gateway is offered **Generate Broker Credential**, as before.

A gateway you restored before the upgrade keeps the record it has. It reads **Issued** beside a disabled
account until you issue it a credential or set it up again.

A script of your own that reads `credential_revoked_at` and takes an empty value to mean the gateway is
active should now read an enrolment or a `CREDENTIAL_ISSUED` row after the stamp as well. The dashboard
does the same: the stamp outranks an enrolment or an issue only while it is the later one.

Nothing needs doing before you upgrade.

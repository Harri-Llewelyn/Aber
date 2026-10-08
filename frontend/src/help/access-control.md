## What this page is for

This page shows who and what may reach Aber. Its first tab, **People**, lists everyone who signs in to the dashboard, with their role. The other four tabs cover the things that do not sign in: gateways, and Aber's own processes. Only Administrators can open it.

The page is one card with five tabs: **People**, **Broker credentials**, **Machine identities**, **Broker accounts** and **Broker roles**. The page opens on People. The list inside the card scrolls, and the page stays put. The **?** just after the tab names explains the selected tab.

People has a row of controls under the tabs, with **Refresh** and **Add Person**. Broker credentials has its filter on the left, and its buttons at the right-hand end. Machine identities has one for **New Machine Identity**. Broker accounts and Broker roles have no controls, so their lists start straight under the tabs.

## Adding and removing people

- **Add Person** asks for an email address and a role. The person signs in with that address.
- If this site has a mail relay, the person gets an invitation by email. They choose their own password from the link in it.
- Without a mail relay, Aber makes a password for them and shows it once. Copy it before you close the dialog. Give it to them in person, or by a channel you trust. Nothing in Aber keeps a copy.
- If that password is lost, it cannot be shown again. Select **Set New Password** on their row instead.
- **Role** is a list on each row. Choosing another role changes it straight away. Their own dashboard catches up when it next reloads. Each person holds one role.
- **Administrator** can do everything, including this page, backups and settings.
- **Shopfloor Manager** manages areas, cells, gateways and devices, and decides the quarantine queue.
- **Operator** reads the shopfloor and its live readings, and can propose changes.
- **Auditor** reads the Audit Trail, including who was given access.
- **Remove Access** asks you to confirm. Then it removes the person's role and blocks their sign-in. Their account stays, so the Audit Trail still names them.
- **Restore Access** lets them sign in again, with the role they had.
- **Set New Password** asks you to confirm. Then Aber makes a new password for the person and shows it once, as Add Person does. Their old password stops working straight away.
- Use it when someone has lost their password, with or without a mail relay. A person whose access is removed needs **Restore Access** first.
- **You cannot change your own role, remove your own access or set your own password here.** Ask another Administrator. Your own row is marked **YOU**, and its controls are greyed out. Hover over one to see why. To change your own password, use **Change Password** in your account menu, the round button at the top right.
- **One Administrator who can sign in always remains.** The last one cannot be given another role, or have their access removed. Make someone else an Administrator first.
- Adding a person, changing a role, removing access, restoring it and setting a new password are each recorded in the Audit Trail. The record names the person and who made the change. It never holds a password.
- A person changing their own password with **Change Password** is not in the Audit Trail. The sign-in service keeps its own record of it.

**Sessions a removed person already has end on their own, not at once.** Their role goes straight away, so the dashboard refuses anything a role allows. An open dashboard session can still read what any signed-in person can, such as the device list, for up to an hour. Sessions in Node-RED, Grafana and Studio keep what they had until they expire, up to eight hours in Node-RED. They cannot sign in again. If they held Administrator, check Node-RED's flows and the Audit Trail afterwards.

**A new password does not end their sessions at once either.** Their old password stops working straight away. An open dashboard asks them to sign in again within the hour. Sessions in Node-RED, Grafana and Studio last until they expire. They keep their role meanwhile. To take their role away at once, use **Remove Access** instead.

## The other tabs

- **Broker credentials** has one row per gateway, with the credential it uses to connect to the broker.
- The **credential filter** opens on **Active**. It offers each credential state with its count, and **Archived**. **Refresh** reads everything again, and **Clear filters** sets the filter back to Active.
- **Type** is the kind of gateway: Remote, Host, Simulated or Playback.
- **Credential** is what Aber issued and recorded. **Broker** is what the broker holds right now, read live. They sit side by side because they can disagree, and a disagreement is worth looking into.
- **Generate** issues a broker credential for a Host, Simulated or Playback gateway, and shows it. An Administrator can show a Host or Simulated gateway's credential again, from the gateway's drawer on the Gateways page.
- **Bundle** is offered for a Remote gateway. It produces the setup bundle. The gateway creates its own credential when it enrols, so the password never passes through a browser.
- An archived gateway offers neither, only **Restore to issue**. Its credential was disabled at the broker. Once the gateway is restored, it can be issued a new one.
- The Playback gateway's credential is shown only once. If it is lost, issue another.
- **Machine identities** lists Aber's own non-human identities on the database side. **Broker accounts** lists the broker's own accounts, read live. **Broker roles** lists what each role may publish, receive and subscribe to. Search for one of the five tab names in the search bar to open the page on that tab.
- **No gateway** marks a broker account that looks like a gateway's, but that no gateway claims and nothing declares. It is listed under **Broker accounts**, after Aber's own accounts. It is usually the account of a gateway that was deleted before deleting a gateway also disabled its broker account. `scripts/revoke-orphaned-broker-accounts.mjs` lists such accounts and disables them. It never deletes one.
- **New Machine Identity** creates an identity for a process that uses Aber through the API. You give a name, a purpose and permissions from a fixed menu, then issue its first token.
- Machines propose, and people decide. The menu's two writes are filing change proposals and versioning schemas. Nothing on it lets a machine write a device, decide a proposal or a quarantine, or change who has access.
- A machine identity reaches the database only. A process that speaks MQTT is issued a broker account instead.
- The pencil beside an identity's name changes its name or purpose. What it holds is fixed when it is created, because a wider grant would apply to every token already issued for it.
- **Holds** is the permissions the identity has, and **Reaches** is what those let it get to. Hover over its name for its purpose. The purpose tells you whether an unfamiliar identity is safe to leave alone, or safe to remove.
- **Issue Token** signs a long-lived token for the identity. It shows the token once, with its expiry and its token ID. Issuing another **adds** a credential; it does not replace the first.
- **Copy Command** copies a command to run from a shell. Two identities keep their keys in the deployment's environment. They have no **Issue Token** button, and their **Copy Command** copies the rotation command. For every other identity, it copies the mint command, which is the way in when nobody can sign in to this page.
- **Tokens** shows how many tokens are still valid, such as **2 active**. Click it to list every recorded token, including expired and revoked ones. Each live token has a **Revoke** button there, and a revoked one reads **REVOKED**.
- A dash under **Tokens** means no token is on record. That is not the same as none existing: hover over it for why.
- **Withdraw** takes a whole machine identity out of use, with an optional reason. **Reinstate** puts it back. **New Machine Identity**, **Issue Token**, **Withdraw** and **Reinstate** are each recorded in the Audit Trail.
- **Rules** on a broker role is the number of rules the broker reports for it. To see the rules exactly as the broker holds them, click the role's row, or press Enter or Space on it. They open in a side panel. A row ending in a chevron opens a panel. Leaving the **Broker roles** tab closes the panel.

## What the states mean

- **Active**, on a person: they have signed in. **Invited**: they were sent an invitation and have not signed in yet. **Not signed in yet**: they were given a password and have not used it.
- **Access removed**: the person has no role and cannot sign in. **Restore Access** brings both back.
- **Sign-in still open**: the person's role was removed, but blocking their sign-in did not finish. Select **Remove Access** again to finish it.
- **CANNOT SIGN IN**: on a machine identity, it has no password and no session, and holds a token instead. This is the normal state, not a fault.
- **WITHDRAWN**: the machine identity was taken out of use. The API refuses every token that names it, including tokens issued afterwards.
- **REVOKED**: a token, or a gateway's broker credential, was revoked. A revoked broker credential is disabled at the broker, and its next connection is refused.
- **No platform record**: the broker holds an account that Aber never recorded issuing. It was usually made on the host by a script. Look into it, because it means a change was made somewhere Aber did not see.
- **Setup outstanding**: setup was started for a Remote gateway, as an install command or a bundle, and the gateway's machine has not used it yet.
- **Active**, **Disabled**, **No account** and **Not read** in the **Broker** column are about the broker account itself. **Not read** means the broker could not be reached. That is about this page load, not about the account.
- **ARCHIVED**: taken out of service on purpose, and kept so that its history can still be looked up.

**Withdrawing a machine identity reaches further than revoking its tokens.** Tokens are revoked one at a time. Withdrawing the identity refuses every token that names it. That includes tokens nobody remembered issuing, and tokens issued afterwards. To stop a machine's access, withdraw its identity.

Neither reaches everything. Revoking stops a token at the API. Storage, realtime, the edge functions and Studio check only the token's signature, so a revoked token keeps working there until it expires. Reinstating an identity brings back the identity, but not the tokens revoked with it.

A machine identity lives on one of two sides, and nothing holds both. A database identity is a set of permissions. A broker identity is an entry in the broker's access list (ACL). A gateway signs in to the broker with the account issued for it.

## What this page is not

**It does not show who is connected.** It reads the broker's accounts and roles live, but not its sessions. So an account that is Active is one that may connect, not one that has. When the broker cannot be read, the Broker column says **Not read**, and the two broker tabs say so. Only the database half of the page is left.

**It does not change your own password.** Use **Change Password** in your account menu. It asks for your current password, then the new one twice. The new one needs at least 12 characters. Someone who has forgotten theirs can use **Forgot your password?** on the sign-in page, if the site has a mail relay. Otherwise an Administrator gives them a new one here, with **Set New Password**.

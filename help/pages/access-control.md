## What this page is for

This page shows who and what may reach Aber. Its first tab, **People**, lists everyone who signs in to the dashboard, with their role. The other four tabs cover the things that do not sign in: gateways, and Aber's own processes. Only Administrators can open it.

The page is one card with five tabs: **People**, **Broker credentials**, **Machine identities**, **Broker accounts** and **Broker roles**. The page opens on People. Each tab has its own address, so a reload, a bookmark or **Back** returns to the same tab, with its filters. The list inside the card scrolls, and the page stays put. Point at a tab, or move to it with the keyboard, to read what it holds.

People, Broker credentials and Machine identities each have a row of controls under the tabs. The search box and filters are on the left, and the buttons at the right-hand end: **Add Person** on People, **New Machine Identity** on Machine identities. Broker accounts and Broker roles have no controls, so their lists start straight under the tabs.

There is no Refresh button. Every change you make here reads the list again. To pick up a change made somewhere else, such as by another Administrator, reload the page: it opens on the same tab and filters.

## Finding a person

- The **search** box matches the email address.
- The **role** filter offers each role, and **No role**. The **status** filter offers the Status column's states. Each option shows how many people it would list.
- People whose access is removed are hidden. Select **Show removed** to list them. The button shows how many there are, and appears only while there are some. While it is on, the status filter also offers **Access removed**.
- A **Sign-in still open** row is never hidden. Its removal did not finish, so it still needs **Remove Access**.
- **Clear filters** resets the search, both filters and Show removed. When nothing matches, the list says so.
- **A column's heading sorts the table** by that column, on every tab. Click it again to reverse the order, and a third time to go back to the usual order. A status sorts the most serious first, and an empty cell always sorts last. The page's address keeps the order, so a link or a reload shows the table the same way. The token list that **Tokens** opens sorts the same way, until it closes.

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
- **You cannot change your own role, remove your own access or set your own password here.** Ask another Administrator. Your own row is marked **YOU**. Its role and removal controls are greyed out: hover over one to see why. In place of **Set New Password**, your row has **Open Profile**. Your **Profile** page is where you change your own password, with **Change Password**.
- **One Administrator who can sign in always remains.** The last one cannot be given another role, or have their access removed. Make someone else an Administrator first.
- Adding a person, changing a role, removing access, restoring it and setting a new password are each recorded in the Audit Trail. The record names the person and who made the change. It never holds a password.
- A person changing their own password with **Change Password** is not in the Audit Trail. The sign-in service keeps its own record of it.

**A removed person loses their sessions within a minute, except in Grafana.** Their role goes straight away. An open dashboard gets nothing more from the database. Studio and the forge refuse their next request. Node-RED signs them out within a minute, and Grafana within the hour. They cannot sign in again. If they held Administrator, check Node-RED's flows, Grafana and the Audit Trail afterwards.

**A new password ends their other sessions, some of them later.** Their old password stops working straight away. Studio and the forge sign them out at their next request, and Node-RED within a minute. An open dashboard and Grafana ask them to sign in again within the hour. They keep their role meanwhile. To take their role away at once, use **Remove Access** instead.

## The other tabs

- **Broker credentials** has one row per gateway, with the credential it uses to connect to the broker.
- The **search** box matches a gateway's name and its MQTT username. The **state filter** offers each credential state with its count.
- Archived gateways are hidden. Select **Show archived** to list them. While it is on, the state filter also offers **Archived**. **Clear filters** resets the search, the filter and Show archived.
- **Type** is the kind of gateway: Remote, Third-party, Host, Simulated or Playback.
- **Credential** is what Aber issued and recorded. **Broker** is what the broker holds right now, read live. They sit side by side because they can disagree, and a disagreement is worth looking into.
- **Generate** issues a broker credential for a Third-party, Host, Simulated or Playback gateway, and shows it. An Administrator can show a Third-party, Host or Simulated gateway's credential again, from the gateway's drawer on the Gateways page.
- **Bundle** is offered for a Remote gateway. It produces the setup bundle. The gateway creates its own credential when it enrols, so the password never passes through a browser.
- An archived gateway offers neither, only **Restore to issue**. Its credential was disabled at the broker. Once the gateway is restored, it can be issued a new one.
- The Playback gateway's credential is shown only once. If it is lost, issue another.
- **Machine identities** lists Aber's own non-human identities on the database side. **Broker accounts** lists the broker's own accounts, read live. **Broker roles** lists what each role may publish, receive and subscribe to. Search for one of the five tab names in the search bar to open the page on that tab.
- On **Machine identities**, the search box matches an identity's name. Withdrawn identities are hidden. Select **Show withdrawn** to list them.
- **No gateway** marks a broker account that looks like a gateway's, but that no gateway claims and nothing declares. It is listed under **Broker accounts**, after Aber's own accounts. It is usually the account of a gateway that was deleted before deleting a gateway also disabled its broker account. `scripts/revoke-orphaned-broker-accounts.mjs` lists such accounts and disables them. It never deletes one.
- Aber's own broker accounts are made each time the broker starts, by `mosquitto-init`. There is one for each `MQTT_…_USER` and `MQTT_…_PASSWORD` pair in the deployment's environment.
- **New Machine Identity** creates an identity for a process that uses Aber through the API. You give a name, a purpose and permissions from a fixed menu, then issue its first token.
- Machines propose, and people decide. The menu's two writes are filing change proposals and versioning schemas. Nothing on it lets a machine write a device, decide a proposal or a quarantine, or change who has access.
- A machine identity reaches the database only. A process that speaks MQTT is issued a broker account instead.
- **Read-only API client** is the identity for a tool that only reads: i3X Explorer, an MCP client, Swagger UI or a script. Issue it a token, and give the tool that token. It reads telemetry, and cannot read the Audit Trail or change anything.
- The pencil beside an identity's name changes its name or purpose. What it holds is fixed when it is created, because a wider grant would apply to every token already issued for it.
- **Holds** is the permissions the identity has, and **Reaches** is what those let it get to. Hover over its name for its purpose. The purpose tells you whether an unfamiliar identity is safe to leave alone, or safe to remove.
- **Issue Token** signs a long-lived token for the identity. It shows the token once, with its expiry and its token ID. Issuing another **adds** a credential; it does not replace the first.
- **Copy Command** copies a command to run from a shell. Two identities keep their keys in the deployment's environment. They have no **Issue Token** button, and their **Copy Command** copies the rotation command. For every other identity, it copies the mint command, which is the way in when nobody can sign in to this page.
- **Tokens** shows how many tokens are still valid, such as **2 active**. Click it to list every recorded token, including expired and revoked ones. Each live token has a **Revoke** button there, and a revoked one reads **REVOKED**.
- A dash under **Tokens** means no token is on record. That is not the same as none existing: hover over it for why.
- **Withdraw** takes a whole machine identity out of use, with an optional reason. **Reinstate** puts it back. **New Machine Identity**, **Issue Token**, **Withdraw** and **Reinstate** are each recorded in the Audit Trail.
- **Rules** on a broker role is the number of rules the broker reports for it. To see the rules exactly as the broker holds them, click the role's row, or press Enter or Space on it. They open in a side panel. A row ending in a chevron opens a panel. Leaving the **Broker roles** tab closes the panel.
- Each role's purpose is declared in `mosquitto/dynsec-roles.json`, and checked when Aber is built.
- Every gateway account holds the one **gateway** role. In its rules, **%u** stands for the account's own username, which is the gateway's Sparkplug ID. So each gateway can publish and receive only under its own edge node.

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

**It does not change your own password.** Use **Change Password** on your **Profile** page. It asks for your current password, then the new one twice. The new one needs at least 12 characters. Someone who has forgotten theirs can use **Forgot your password?** on the sign-in page, if the site has a mail relay. Otherwise an Administrator gives them a new one here, with **Set New Password**.

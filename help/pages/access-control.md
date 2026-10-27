## What this page is for

This page shows who and what may reach Aber. Its first tab, **People**, lists everyone who signs in to the dashboard, with their role. The other four tabs cover the things that do not sign in: gateways, and Aber's own processes. Only Administrators can open it.

The page is one card with five tabs: **People**, **Broker credentials**, **Machine identities**, **Broker accounts** and **Broker roles**. The page opens on People. Each tab has its own address, so a reload, a bookmark or **Back** returns to the same tab, with its filters. The list inside the card scrolls, and the page stays put. Point at a tab, or move to it with the keyboard, to read what it holds.

People, Broker credentials and Machine identities each have a row of controls under the tabs. The search box and filters are on the left, and the buttons at the right-hand end: **Add Person** on People, **New Machine Identity** on Machine identities. Broker accounts and Broker roles have no controls, so their lists start straight under the tabs.

There is no Refresh button. Every change you make here reads the list again. To pick up a change made somewhere else, such as by another Administrator, reload the page: it opens on the same tab and filters.

## Finding a person

- The **search** box matches the display name and the email address.
- The **role** filter offers each role, and **No role**. The **status** filter offers the Status column's states. Each option shows how many people it would list.
- People whose access is removed are hidden. Select **Show removed** to list them. The button shows how many there are, and appears only while there are some. While it is on, the status filter also offers **Access removed**.
- A **Sign-in still open** row is never hidden. Its removal did not finish, so it still needs **Remove Access**.
- **Clear filters** resets the search, both filters and Show removed. When nothing matches, the list says so.
- **A column's heading sorts the table** by that column, on every tab. Click it again to reverse the order, and a third time to go back to the usual order. A status sorts the most serious first, and an empty cell always sorts last. The page's address keeps the order, so a link or a reload shows the table the same way. The token list that **Tokens** opens sorts the same way, until it closes.

## Adding and removing people

- **Add Person** asks for an email address and a role, and can take a display name. The person signs in with that address.
- **A display name** is shown first, with the email address beside it. Two people can have the same name, so the address is always shown here, on Approvals and on the Audit Trail. A person without one is shown by email address alone.
- If the display name is too long, or holds a line break or a tab, Add Person refuses it before anything is made. It can be up to 80 characters.
- If this site has a mail relay, the person gets an invitation by email. They choose their own password from the link in it.
- Without a mail relay, Aber makes a password for them and shows it once. Copy it before you close the dialog. Give it to them in person, or by a channel you trust. Nothing in Aber keeps a copy.
- If that password is lost, it cannot be shown again. Open their row and select **Set New Password** instead.
- **Role** is shown on each row, and in the person's drawer. Each person holds one role. To change it, select **Change Role** in their drawer.
- **Administrator** can do everything, including this page, backups and settings.
- **Shopfloor Manager** manages areas, cells, gateways and devices, and decides the quarantine queue.
- **Operator** reads the shopfloor and its live readings, and can propose changes.
- **Auditor** reads the Audit Trail, including who was given access.
- **Click a person's row**, or press Enter on it, to open their drawer. Click the row again, or press Escape, to close it.
- Every action for that person is in the drawer: **Change Name**, **Change Email**, **Change Role**, **Set New Password**, **End Sessions**, **Reset MFA**, and **Remove Access** or **Restore Access**.
- The drawer shows their email address, display name, role, status and last sign-in.
- **Sessions**, in the drawer, counts their sign-ins: the dashboard in each browser, and each service such as Grafana. It says when one was last used.
- Select **Show sessions**, under the count, to list them. Each row says where the session is: a browser and system, a program, or a service. It says when the session started and when it was last active. No address is shown.
- **End**, on a row of that list, signs them out of that one session. A dialog asks first, naming the session and when it was last active. Select **End Session** to end it. Their other sessions stay signed in, so use it for a lost laptop.
- **Remove Access** asks you to confirm. Then it removes the person's role and blocks their sign-in. Their account stays, so the Audit Trail still names them.
- **Restore Access** lets them sign in again, with the role they had.
- **Change Name** sets or changes a person's display name. Empty the box and select **Save** to remove it. Their email address does not change. A person can also set their own, on their **Profile** page.
- A new name shows everywhere at once, even beside things the person did before. Approvals and Archived Entities still show the email address the person had at the time.
- **Change Role** lists the roles, starting on theirs. Choose another, and the dialog says what it lets them do. Nothing changes until you select **Change Role** in the dialog.
- The new role applies from their next request. Node-RED follows within a minute, and Grafana when they next sign in to it. Their own dashboard catches up when it next reloads. A person whose access is removed needs **Restore Access** first.
- **Set New Password** asks you to confirm. Then Aber makes a new password for the person and shows it once, as Add Person does. Their old password stops working straight away.
- Use it when someone has lost their password, with or without a mail relay. A person whose access is removed needs **Restore Access** first.
- **End Sessions** asks you to confirm. Then it signs them out of every browser and every service. Use it for a shared screen left signed in, or when you cannot tell which session to end. They keep their role, and can sign in again.
- **Reset MFA** asks you to confirm. Then it removes every second factor the person has, so their password alone signs them in. Use it when they have lost the phone or app that shows their codes.
- Reset MFA leaves their sessions signed in. To sign them out as well, use **End Sessions**. They can add a new second factor on their **Profile** page's **Security** tab.
- Each reset is recorded in the Audit Trail, with how many second factors it removed. You cannot reset your own here: remove it on your **Profile** page's **Security** tab.
- **If the only Administrator loses their phone**, nobody can reset it here. Whoever runs the server can remove it with the site's secret key, as [Resetting the only Administrator's second factor](../../docs/security-model.md#resetting-the-only-administrators-second-factor) shows. Keep two Administrators, so each can reset the other.
- **Change Email** gives them a new address to sign in with. It works straight away. No email is sent to either address, so tell them yourself.
- Changing the address ends all their sessions, so they sign in again with the new one. Their role, name and history stay.
- An address another account already has is refused. A person whose access is removed needs **Restore Access** first.
- An invitation or a password-reset link sent to the old address stops working. If they have not set a password yet, give them one with **Set New Password**.
- **Which address shows where.** People and the Audit Trail show the address the account has now. Approvals and Archived Entities keep the address the person had when they acted.
- **Grafana** takes the new address at their next sign-in there. **The forge** does not. A person's forge profile keeps the address it was made with. Someone who first opens the forge on Aber 1.7.0 or later has a placeholder address there instead. Either way, they sign in to the forge as before.
- **You cannot change your own role, email address or access here, set your own password or end your own sessions.** Ask another Administrator. Your own row is marked **YOU**. Those actions in your drawer are greyed out: hover over one to see why. In place of **Set New Password**, your drawer has **Open Profile**. Your **Profile** page is where you change your own password, with **Change Password**. Its **Security** tab lists your own sessions and ends them, so your drawer has no list.
- **One Administrator who can sign in always remains.** The last one cannot be given another role, or have their access removed. Make someone else an Administrator first.
- Each act here is recorded in the Audit Trail. That covers adding a person, a new role, name or address, removing or restoring access, a new password and ended sessions. The record names the person and who made the change. A new address is recorded with the old one. It never holds a password.
- A person changing their own password with **Change Password** is not in the Audit Trail. The sign-in service keeps its own record of it.

**A removed person loses their sessions within a minute, except in Grafana.** Their role goes straight away. An open dashboard gets nothing more from the database. Studio and the forge refuse their next request. Node-RED signs them out within a minute, and Grafana within the hour. They cannot sign in again. If they held Administrator, check Node-RED's flows, Grafana and the Audit Trail afterwards.

**Ending their sessions, or changing their address, signs them out of everything, some of it later.** The API refuses them straight away. Studio and the forge sign them out at their next request. Node-RED does within a minute, and Grafana within the hour. They keep their role. To stop them signing in again, use **Remove Access**.

**A new password ends their other sessions, some of them later.** Their old password stops working straight away. Studio and the forge sign them out at their next request. Node-RED and an open dashboard do within a minute, and Grafana within the hour. They keep their role meanwhile. To take their role away at once, use **Remove Access** instead.

## The other tabs

- **Broker credentials** has one row per gateway, with the credential it uses to connect to the broker.
- The **search** box matches a gateway's name and its MQTT username. The **state filter** offers each credential state with its count.
- Archived gateways are hidden. Select **Show archived** to list them. While it is on, the state filter also offers **Archived**. **Clear filters** resets the search, the filter and Show archived.
- **Type** is the kind of gateway: Remote, Third-party, Host, Simulated or Playback.
- **Credential** is what Aber issued and recorded. **Broker** is what the broker holds right now, read live. They sit side by side because they can disagree, and a disagreement is worth looking into.
- Beside Active or Disabled, the **Broker** column says **Connected** or **Not connected**. Connected means something holds a live session on the account. It is read live with the rest of the page, so reload the page to read it again. **Connected (2)** means two sessions at once: a gateway should hold one, so look into it. **Broker accounts** shows the same for Aber's own accounts. The broker's admin account always reads Connected, because the page reads the broker as that account. Where a session connects from is not shown: the broker sees one address for every client outside the cluster.
- **Generate** issues a broker credential for a Third-party, Host, Simulated or Playback gateway, and shows it. An Administrator can show a Third-party, Host or Simulated gateway's credential again, from the gateway's drawer on the Gateways page.
- **Bundle** is offered for a Remote gateway. It produces the setup bundle. The gateway creates its own credential when it enrols, so the password never passes through a browser.
- An archived gateway offers neither, only **Restore to issue**. Its credential was disabled at the broker. Once the gateway is restored, it can be issued a new one.
- The Playback gateway's credential is shown only once. If it is lost, issue another.
- **Machine identities** lists Aber's own non-human identities on the database side. **Broker accounts** lists the broker's own accounts, read live. **Broker roles** lists what each role may publish, receive and subscribe to. Search for one of the five tab names in the search bar to open the page on that tab.
- On **Machine identities**, the search box matches an identity's name, or its whole principal ID. Withdrawn identities are hidden. Select **Show withdrawn** to list them.
- **No gateway** marks a broker account that looks like a gateway's, but that no gateway claims and nothing declares. It is listed under **Broker accounts**, after Aber's own accounts. It is usually the account of a gateway that was deleted before deleting a gateway also disabled its broker account. `scripts/revoke-orphaned-broker-accounts.mjs` lists such accounts and disables them. It never deletes one.
- Aber's own broker accounts are made each time the broker starts, by `mosquitto-init`. There is one for each `MQTT_…_USER` and `MQTT_…_PASSWORD` pair in the deployment's environment.
- **New Machine Identity** creates an identity for a process that uses Aber through the API. You give a name, a purpose and permissions from a fixed menu, then issue its first token.
- Machines propose, and people decide. The menu's two writes are filing change proposals and versioning schemas. Nothing on it lets a machine write a device, decide a proposal or a quarantine, or change who has access.
- A machine identity reaches the database only. A process that speaks MQTT is issued a broker account instead.
- **Read-only API client** is the identity for a tool that only reads: i3X Explorer, an MCP client, Swagger UI or a script. Issue it a token, and give the tool that token. It reads telemetry, and cannot read the Audit Trail or change anything.
- After **Issue Token**, the dialog says how to connect, for any identity that reads telemetry. It gives the i3X server's address and a setup for each client, with the token already in it. The setups go when the dialog closes, as the token does.
- The pencil beside an identity's name changes its name or purpose. What it holds is fixed when it is created, because a wider grant would apply to every token already issued for it.
- **Holds** is the permissions the identity has, and **Reaches** is what those let it get to. Hover over its name for its purpose. The purpose tells you whether an unfamiliar identity is safe to leave alone, or safe to remove.
- **Issue Token** signs a long-lived token for the identity. It shows the token once, with its expiry and its token ID. Issuing another **adds** a credential; it does not replace the first.
- **Copy Command** copies a command to run from a shell. Three identities keep their keys in the deployment's environment. They have no **Issue Token** button, and their **Copy Command** copies the rotation command. For every other identity, it copies the mint command, which is the way in when nobody can sign in to this page.
- **Tokens** shows how many tokens are still valid, such as **2 active**. Click it to list every recorded token, including expired and revoked ones. Each live token has a **Revoke** button there, and a revoked one reads **REVOKED**.
- A dash under **Tokens** means no token is on record. That is not the same as none existing: hover over it for why.
- **Aber warns before a token expires.** A 30- or 90-day token warns 7 days before it expires. A 7-day token warns when a quarter of its life is left, about 42 hours before.
- The warning is the Grafana alert **Service Token Expiring**. It pops up as a message, and is listed under the alert counter in the top bar. It names the identity, the token ID and when the token expires. In the dashboard, only Administrators see it. Select it to open the identity on this tab.
- To deal with it, select **Issue Token** on the identity's row, and put the new token in the client that uses the old one. Then open **Tokens** and select **Revoke** on the old token. The alert clears once the old token is revoked.
- An identity with no **Issue Token** button is renewed by the command its **Copy Command** copies. Run it, then revoke the old token in the same way.
- Only a token Aber recorded can warn. The keys those three identities were given when Aber was installed were not recorded, so their first expiry gives no warning. `npm run keys:check` says how long they have left.
- **Last Used**, in the token list, says when a client last used each token through the i3X server. It shows the hour, or **Never**.
- It covers i3X Explorer, MCP clients and any other client of the i3X server. A script that calls the API directly is not recorded, so its token can read **Never** while it is in use.
- The three identities with no **Issue Token** button read **Not recorded**. Their services call the API directly, never through the i3X server.
- Select the **Last Used** heading to bring the unused tokens to the top. If a token has read **Never** for weeks, and you know no script calls the API with it, revoke it.
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
- **Active**, **Disabled**, **No account** and **Not read** in the **Broker** column are about the broker account itself. **Not read** means the broker could not be reached. It also shows when your session has ended; sign in again to read it. Either way, it is about this page load, not about the account.
- **ARCHIVED**: taken out of service on purpose, and kept so that its history can still be looked up.
- **Connected** and **Not connected**, beside Active or Disabled in the **Broker** column, say whether anything holds a live session on the account. When the broker could not be read, neither is shown.

**Withdrawing a machine identity reaches further than revoking its tokens.** Tokens are revoked one at a time. Withdrawing the identity refuses every token that names it. That includes tokens nobody remembered issuing, and tokens issued afterwards. To stop a machine's access, withdraw its identity.

Neither reaches everything. Revoking stops a token at the API. Storage, realtime, the edge functions and Studio check only the token's signature, so a revoked token keeps working there until it expires. Reinstating an identity brings back the identity, but not the tokens revoked with it.

A machine identity lives on one of two sides, and nothing holds both. A database identity is a set of permissions. A broker identity is an entry in the broker's access list (ACL). A gateway signs in to the broker with the account issued for it.

## What this page is not

**It does not show where a client connects from.** It counts each broker account's live sessions, but leaves out their addresses. When the broker cannot be read, the Broker column says **Not read**, and the two broker tabs say so. Only the database half of the page is left.

**It does not change your own password.** Use **Change Password** on your **Profile** page. It asks for your current password, then the new one twice. The new one needs at least 12 characters. Someone who has forgotten theirs can use **Forgot your password?** on the sign-in page, if the site has a mail relay. Otherwise an Administrator gives them a new one here, with **Set New Password**.

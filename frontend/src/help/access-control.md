## Summary

Who and what may reach this platform, and with which credential, for the machines that do not sign in: gateways, and the stack's own processes. It lists no people. It is open to Administrators. It is one card with four tabs, **Broker credentials**, **Machine identities**, **Broker accounts** and **Broker roles**, and the list inside the card scrolls while the page stays put. The **?** straight after the tab names explains the selected tab. Broker credentials has a row under the tabs, its filter on the left and its buttons at the right-hand end, and Machine identities has one for **New Machine Identity**. Broker accounts and Broker roles have no controls, so their list starts straight under the tabs.

## What the controls do

- **Broker credentials** is the tab the page opens on: one row per gateway, and the credential it uses to connect to the broker. The **credential filter** opens on **Active** and offers each credential state with its count, and **Archived**. **Refresh** reads everything again, and **Clear filters** returns the filter to Active.
- **Type** is the kind of gateway: Remote, Host, Simulated or Playback. **Credential** is what the platform issued and recorded, and **Broker** is what the broker holds right now, read live. The two are shown side by side because they can disagree, and the disagreement is the finding.
- **Generate** issues a broker credential for a Host, Simulated or Playback gateway and shows it. A Host or Simulated gateway's can be shown again by an Administrator, from the gateway's drawer on the Gateways page. **Bundle** is offered for a Remote gateway: it produces the bootstrap bundle, and the appliance creates its own credential when it enrols, so the password never passes through a browser. An archived gateway offers neither, only **Restore to issue**: its credential was disabled at the broker, and it can be issued a new one after it is restored. A credential is shown once and cannot be shown again; if it is lost, issue another.
- **Machine identities** lists the stack's own non-human identities on the database side. **Broker accounts** lists the broker's own accounts, read live. **Broker roles** lists what each role may publish, receive and subscribe to. Searching for one of the four names in the search bar opens the page on that tab.
- **No gateway** marks a broker account shaped like a gateway's that no gateway claims and nothing declares, listed under **Broker accounts** after the stack's own. It is usually a credential whose gateway was deleted straight from the broker. `scripts/revoke-orphaned-broker-accounts.mjs` lists and disables such accounts; it never deletes one.
- **New Machine Identity** creates an identity for a process that uses this platform through the API: a name, a purpose and permissions from a fixed menu, then its first token. Machines propose, people decide: the menu's two writes file change proposals and version schemas, and nothing on it lets a machine write a device, decide a proposal or a quarantine, or change who has access. It reaches the database only. A process that speaks MQTT is issued a broker account, not a machine identity. The pencil beside such an identity's name changes its name or purpose; what it holds is fixed at creation, because a wider grant would reach every token already issued for it.
- **Holds** is the permissions the identity has, and **Reaches** is what those let it get to. The purpose, which is what makes an unfamiliar identity safe to leave alone or safe to remove, is the tooltip on its name.
- **Issue Token** signs a long-lived token for the identity and shows it once, with its expiry and its token ID. Issuing another **adds** a credential; it does not replace the first. The two identities whose keys live in the deployment's environment have no such button, only **Copy Command**, which copies the rotation command. For the others, **Copy Command** copies the mint command, which is the way in when nobody can sign in to this page.
- **Tokens** reads how many tokens are still valid, such as **2 active**. Click it to list every recorded token, expired and revoked ones included; each live token has a **Revoke** button there, and a revoked one reads **REVOKED**. A dash means no token is on record, which is not the same as none existing: hover it for why.
- **Withdraw** takes a whole machine identity out of use, with an optional reason; **Reinstate** puts it back. **New Machine Identity**, **Issue Token**, **Withdraw** and **Reinstate** each write to the Audit Trail.
- **Rules** on a broker role is the number of rules the broker reports for it. Click the role's row, or press Enter or Space on it, to open the rules, exactly as the broker holds them, in a side panel. A row ending in a chevron opens a panel. Leaving the **Broker roles** tab closes the panel.

## What the states mean

- **CANNOT SIGN IN** -- on a machine identity: it has no password and no session and holds a token instead. This is the normal state, not a fault.
- **WITHDRAWN** -- the machine identity was taken out of use. The API refuses every token that names it, including tokens issued afterwards.
- **REVOKED** -- a token, or a gateway's broker credential, was revoked. A revoked broker credential is disabled at the broker, and its next connection is refused.
- **No platform record** -- the broker may hold an account that the platform never recorded issuing, usually one made on the host by a script. It is worth looking at, because it means a change was made somewhere the platform did not see.
- **Setup outstanding** -- setup was started for a Remote gateway (an install command or a bundle) and the appliance has not used it yet.
- **Active**, **Disabled**, **No account** and **Not read** are what the **Broker** column says about the account itself. **Not read** means the broker could not be reached, which is a fact about this page load and not about the account.
- **ARCHIVED** -- decommissioned deliberately, and retained so that history still resolves.

**Withdrawing a machine identity reaches further than revoking its tokens.** A token is revoked one at a time. Withdrawing the identity refuses every token that names it, including ones nobody remembered were issued and ones issued afterwards. When the question is "make this stop", the identity is the answer. Neither reaches everything: revocation stops a token at the API, and storage, realtime, the edge functions and Studio check only its signature, so a revoked token keeps working there until it expires. Reinstating an identity restores the identity, not the tokens revoked with it.

A machine identity lives on one of two planes, and nothing here holds both. A database identity is a set of permissions; a broker identity is an ACL entry. A gateway authenticates to the broker as an account issued against it.


## What this page is not

**It does not show who is connected.** It reads the broker's accounts and roles, live, but not its sessions, so an account that is Active is one that may connect, not one that has. When the broker cannot be read, the Broker column says **Not read** and the two broker tabs say so, and only the database half of the page is left.

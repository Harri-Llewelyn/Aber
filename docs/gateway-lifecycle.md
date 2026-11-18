# What each gateway step leaves behind

This page says what every step of a gateway's life leaves behind, for each type of gateway. It is for
people who change the gateway code, the Gateways page or the broker's accounts. It is the table the code
is held to: a suite walks it, and a check keeps it in step with the code.

To use the page, read [its help](../help/pages/gateways.md). The design reasons are in
[Remote gateways](remote-gateways.md).

Every row says what the step **should** leave. Where today's code does something else, the row carries a
key such as **[Dn]**, with a number for n, and [*Where the code differs*](#where-the-code-differs) says what. Where only a live
gateway can show a cell, the cell says so.

## The types

A gateway has one of five types. The database holds two columns, and the Type column of the Gateways
page reads them.

| Type | `deployment` | Flags | Who issues its broker credential | Setup token | Forge repository |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Remote | `remote` | none | The appliance, when it enrols. It never passes through a browser. | Yes | Yes, once it enrols, where the deployment has a forge |
| Third-party | `third_party` | none | A person, from the drawer. | No | No |
| Host | `host` | none | A person, from the drawer. | No | No |
| Simulated | `host` | `is_simulated` | A person, from the drawer. | No | No |
| Playback | `host` | `is_simulated`, `is_shadow` | A person, from the drawer. It is delivered to the playback worker. | No | No |

Third-party, Host and Simulated gateways are the **dashboard-issued** types: all three hold a credential a
person issued. A change among them ends nothing. The Playback gateway is seeded. A person cannot create
it, change its type, archive it or delete it.

## Reading the tables

Each table covers one group of steps. A row is one step for one type, from the starting state it names.

- **Status** is the stored `status` and what `gateway_status.live_status` and the Status column show.
  `live_status` is the stored value, except that a stored `ONLINE` older than 90 seconds reads `STALE`.
  `PENDING_ENROLLMENT` and `AWAITING_BIRTH` win outright, and are not faults.
- **Setup token** is a row of `gateway_enrollment_tokens`: live, consumed or cancelled. Cancelled means
  consumed without being redeemed.
- **Record** is the platform's own record of a credential: `enrolled_at`, `credential_revoked_at` (the
  stamp) and the `CREDENTIAL_ISSUED` rows in the Audit Trail. The dashboard's Credential state reads
  these. It does not read the broker.
- **Broker** is the account in the broker's Dynamic Security plugin, which the Access Control page lists.
  A revocation **disables** the account. It does not delete it, and issuing again re-enables it.
- **Forge** is the gateway's repository and its deploy key.
- **Drawer** lists the actions the step changes. The drawer always offers View Audit Trail and Attached
  Links to a reader who may use them. One action is primary.
- **Audit and toast** is what the Audit Trail records and what the person sees. A person-made action ends
  with a success toast, which also files a bell notification.

A revocation is asked of the broker through `pg_net`, so the database cannot see the answer in the
same transaction. The sweep runs every 15 minutes and judges each request by its reply. The README's
sections on [0252](../supabase/README.md#changing-a-gateways-type-cleans-up-after-the-old-type-0252) and
[0288](../supabase/README.md#a-failed-revocation-after-a-change-of-type-is-asked-again-0288) say which
failed requests it asks again.

## Registration and setup

Setup is a Remote gateway's own step. The other types are issued a credential instead: see
[*Credentials*](#credentials).

| Step and type | Status | Setup token | Record | Broker | Forge | Drawer | Audit and toast |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Register** a Remote gateway | `OFFLINE`, until Set up issues a token | None | None | No account | None | Set Up Gateway (primary), Request Rebirth, Edit Details, Archive Gateway | One `INSERT`. The toast says to issue the install command or a bundle, and the Set up dialog opens. |
| **Register** a Third-party gateway | `OFFLINE` | None | None | No account | None | Generate Broker Credential, Edit Details, Archive Gateway. The primary is Launch UI when it has a console address, otherwise Edit Details. | One `INSERT`. The toast says it was created, and the credential dialog opens. |
| **Register** a Host or Simulated gateway | `OFFLINE` | None | None | No account | None | As Third-party | One `INSERT`. The toast says it was created. |
| **Register** a Playback gateway | Not by a person | n/a | n/a | n/a | n/a | n/a | The seed makes it. Every API role is refused when it tries to mark a gateway Playback. |
| **Setup issued**, Remote, `OFFLINE` | `PENDING_ENROLLMENT`, read as AWAITING SETUP | One live token. It lasts 30 minutes by default and a day at most. | None | No account | None | Set Up Gateway (primary). Request Rebirth is disabled until the first birth. | One `UPDATE` of the status. The toast says the install command was issued, and links to the gateway. A downloaded bundle's toast has no link. |
| **Setup re-issued**, Remote, `PENDING_ENROLLMENT` | Unchanged | The earlier token is cancelled and one new token is live | None | No account | None | Set Up Gateway. It asks the person to type the gateway's name first. | None: the status did not change. Same toast. |
| **Setup re-issued**, Remote, `AWAITING_BIRTH` | Back to `PENDING_ENROLLMENT` | One new token is live | `enrolled_at` is kept. The stamp is set as the revocation is asked. | The account is disabled at once. Redeeming the new setup enables it with a new password. | The repository is kept | Re-issue Setup (primary), then Set Up Gateway | One `UPDATE` of the status. Same toast. |
| **Setup re-issued**, Remote, enrolled and published, its appliance rebuilt | Back to `PENDING_ENROLLMENT` | One new token is live | `enrolled_at` is kept. The stamp is set as the revocation is asked. | The account is disabled at once. Redeeming the new setup enables it with a new password. | The repository is kept. The new appliance's key replaces the old. | Re-issue Setup, which asks first. Today the drawer offers nothing: **[D7]** | One `UPDATE` of the status. Same toast. |
| **Setup issued**, Third-party, Host, Simulated or Playback | Unchanged | None: the issue is refused | None | None | None | No setup action | None. The refusal names the type. |
| **Setup issued**, an archived Remote gateway | Refused | None | None | None | None | No setup action | None. Today it is accepted: **[D4]**. |
| **Setup expires unused**, Remote, `PENDING_ENROLLMENT` | Unchanged: still AWAITING SETUP | The token stays unconsumed past its expiry. Redeeming it, and the installer, answer as for an unknown token. | None | No account | None | Set Up Gateway (primary) | Nothing is written. |
| **Enrolment**, Remote, `PENDING_ENROLLMENT` with a live token | `AWAITING_BIRTH`, read as ENROLLED, NO DATA YET | Consumed. Of two appliances racing for one token, one wins. | `enrolled_at` is set. The stamp is left as it was. | An account is created, or re-enabled, with a new password | The repository is created or adopted, and the appliance's deploy key is registered. That needs a forge on the deployment and a key from the appliance (confirmed by the live walk, item 5). | Re-issue Setup (primary). Request Rebirth stays disabled. | One `UPDATE` by the actor `service`. No toast: an appliance did it. |
| **Enrolment refused**: a gateway that is archived or not Remote, or a token that is unknown, expired or spent | Unchanged | Not burned. An archived gateway's was cancelled when it was archived. | None | None | None | Unchanged | None. The answer is the same `401` in every case. |
| **First birth**, any type | `ONLINE`. The heartbeat writes it. | Unchanged | Unchanged | Unchanged | Unchanged | Launch UI is primary when there is a console address. Request Rebirth is enabled. | One `UPDATE` of the status, by the ingestion daemon. A later heartbeat writes none. A changed flow hash writes one `FLOW_DEPLOYED` row. |

## Credentials

A Third-party, Host, Simulated or Playback gateway is issued its credential from the drawer.
A Remote gateway gets one at enrolment, which the table above covers.

| Step and type | Status | Setup token | Record | Broker | Forge | Drawer | Audit and toast |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Credential issued**, Third-party, Host or Simulated | Unchanged: `OFFLINE` until it publishes | None | One `CREDENTIAL_ISSUED` row. `enrolled_at` stays empty. A copy of the password is kept encrypted in the database. | An account is created, or re-enabled, with a new password | None | Generate Broker Credential. Show Broker Credential, for an Administrator. | One `CREDENTIAL_ISSUED` row, in the asset lane, with no password in it. The toast says the credential was issued, and links to the gateway. |
| **Credential re-issued**, the same types | Unchanged | None | A second `CREDENTIAL_ISSUED` row. The kept copy is replaced. | The password is replaced and any session on the old one is dropped | None | The dialog asks first | As above |
| **Credential shown**, the same types | Unchanged | None | Unchanged | Unchanged | None | Show Broker Credential, for an Administrator only | One `CREDENTIAL_SHOWN` row, with no password in it. No copy is kept after an archive, a type change or a delete: the dialog then says to issue a new one. |
| **Credential issued**, Playback | Unchanged | None | One `CREDENTIAL_ISSUED` row. No copy is kept. | An account is created, or re-enabled | None | Generate Broker Credential (primary, for this gateway alone) | As above. The password goes to the playback worker. If delivery fails, the dialog shows the Helm value to set. |
| **Credential issued**, Remote | Unchanged | None | None | None | None | No credential action | None. The refusal says to use a setup command. |
| **Credential issued**, any archived gateway | Unchanged | None | None | None | None | No credential action | None. The refusal says to restore it first. |
| **Credential issued after a revocation** | Unchanged | None | The `CREDENTIAL_ISSUED` row is newer than the stamp, so it outranks it. The stamp stays. | The account is re-enabled | None | Generate Broker Credential | As above |

## Changing the type

The Edit Gateway dialog writes `deployment` and `is_simulated` on every save. A database trigger does the
clean-up, so a type change through any other route ends the same things. Only **crossing Remote's boundary**
ends anything: Remote to another type, or another type to Remote.
[*Changing a gateway's type cleans up after the old type (0252)*](../supabase/README.md#changing-a-gateways-type-cleans-up-after-the-old-type-0252) is the design. [*A failed revocation after a change of type is asked again (0288)*](../supabase/README.md#a-failed-revocation-after-a-change-of-type-is-asked-again-0288) is the retry.

| Step and type | Status | Setup token | Record | Broker | Forge | Drawer | Audit and toast |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Remote, `OFFLINE` with no token, to another type** | `OFFLINE` | None | None | None: it holds no account | None | Generate Broker Credential | One `UPDATE`. The toast says it was saved. |
| **Remote, `PENDING_ENROLLMENT`, to another type** | `OFFLINE` | Cancelled | None | None: it never enrolled | None | Generate Broker Credential | One `UPDATE`. The toast says the unused setup command was cancelled. |
| **Remote, enrolled, to another type** | `OFFLINE` if it was `PENDING_ENROLLMENT` or `AWAITING_BIRTH`. Otherwise its own word: an online appliance reads ONLINE until the broker drops it. | Cancelled | The stamp is set as the revocation is asked. `enrolled_at` stays. | The account is disabled. If the call fails, the sweep asks again every 15 minutes until a reply says it landed, or until a credential issued or enrolled after the change replaces it. | The repository is kept as it is (confirmed by the live walk, item 5) | Generate Broker Credential. Save asks first. | One `UPDATE` that carries the status and the stamp. The toast says the credential is ended. |
| **A dashboard-issued type, with a credential, to Remote** | `OFFLINE` | None | The stamp is set. The kept copy is forgotten. | The account is disabled, and re-enabled when the appliance enrols | None | Set Up Gateway (primary), because a revocation stands | One `UPDATE`. The toast says the credential is ended, and to set it up from the drawer. Save asks first. |
| **A dashboard-issued type, with no credential, to Remote** | `OFFLINE` | None | None | None | None | Set Up Gateway (primary) | One `UPDATE`. The toast says to set it up. |
| **Among Third-party, Host and Simulated** | Unchanged | None | Unchanged. The kept copy stays. | Unchanged | None | Unchanged | One `UPDATE`. Nothing is said to have ended. |
| **The same type saved again** | Unchanged | Unchanged | Unchanged | Unchanged | Unchanged | Unchanged | One `UPDATE` for whatever else changed. |
| **Any type, to or from Playback** | Refused by a constraint | n/a | n/a | n/a | n/a | The drawer has no Edit Details | A refusal. The Playback gateway stays as the seed made it. |
| **An archived gateway**, to another type | The clean-up skips an archived gateway. A Remote gateway left in `PENDING_ENROLLMENT` stays so. **[D6]** | Already cancelled | Unchanged | Already disabled | n/a | Restore Gateway | One `UPDATE` |
| **Remote, to another type and back**, never enrolled again | `OFFLINE` | None | `enrolled_at` is older than the stamp, so no enrolment stands, and the database counts none. Leaving Remote again asks for no second revocation. | Disabled | The repository is kept | Set Up Gateway (primary) | One `UPDATE` each way |

## Renaming and changing the Sparkplug group

Neither is a lifecycle step in the database: each is one `UPDATE` and nothing follows it. The rows say so, so
that a change which makes something follow it is a decision.

| Step and type | Status | Setup token | Record | Broker | Forge | Drawer | Audit and toast |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Rename**, any type | Unchanged | Unchanged | Unchanged | Unchanged: the account is named by the Sparkplug ID, never the name | The repository is named by the Sparkplug ID, so it keeps its place. Its description and wiki home keep the name written at enrolment (confirmed by the live walk, item 5). | Unchanged | One `UPDATE`. The toast says it was saved. |
| **Group change**, Remote | Unchanged | Unchanged. A token redeemed afterwards hands the appliance the new group. | Unchanged | Unchanged: the broker pins the node's ID, not its group | Unchanged | Unchanged. While the appliance publishes under the old group, the page warns. | One `UPDATE`. The toast says it was saved. The Factory+ Directory address moves at once. An enrolled appliance keeps the group written into its flow and `platform.yml` until it is set up again or its flow changes (confirmed by the live walk, item 5). |
| **Group change**, Third-party, Host or Simulated | Unchanged | None | Unchanged | Unchanged | None | Unchanged. The edge node is changed on the node itself. | As above |
| **Group change**, Playback | Not offered | n/a | n/a | n/a | n/a | The drawer has no Edit Details | n/a |

A group cannot be empty, and cannot contain `/`, `+` or `#`: a constraint refuses it.

## Archive, restore, auto-delete and delete

Archiving is the revocation. [*An appliance that is lost, stolen or scrapped*](remote-gateways.md#an-appliance-that-is-lost-stolen-or-scrapped)
says why.

| Step and type | Status | Setup token | Record | Broker | Forge | Drawer | Audit and toast |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Archive**, Remote, `PENDING_ENROLLMENT` or `OFFLINE`, never enrolled | Unchanged. The dashboard leaves an archived gateway out of every warning. | Cancelled | None: no account was ever issued, so none is asked for | None | None | Restore Gateway | One `UPDATE` with `archived_at` and the timer. The toast says it was archived. |
| **Archive**, Remote, enrolled | Unchanged until the broker drops the session | Cancelled | The stamp is set as the revocation is asked | The account is disabled and its session dropped. Asked again every 15 minutes until a reply says it landed. | The sweep removes the deploy key and archives the repository, read-only. Archiving asks it at once. | Restore Gateway | One `UPDATE`. The toast says it was archived. |
| **Archive**, Third-party, Host or Simulated, with a credential | Unchanged | None | The stamp is set. The kept copy is forgotten. | The account is disabled. Asked again until a reply says it landed. | None | Restore Gateway | One `UPDATE`. The toast says it was archived. |
| **Archive**, Third-party, Host or Simulated, with no credential | Unchanged | None | None | None: nothing is asked | None | Restore Gateway | One `UPDATE` |
| **Archive**, Playback | Refused while it is the only Playback gateway | n/a | n/a | n/a | n/a | The drawer has no Archive Gateway | A refusal |
| **Restore**, Remote, never enrolled | Unchanged: `PENDING_ENROLLMENT` stays so | None: a cancelled token does not come back | None | None | None | Set Up Gateway (primary) | One `UPDATE` clearing `archived_at` and the timer. The toast says it was restored. |
| **Restore**, Remote, enrolled | Unchanged | None | The stamp stays, so the record keeps reading Revoked until a credential is issued or enrolled after the restore. | The account stays disabled until the appliance enrols again | The repository comes back out of the forge's archive. The deploy key does not come back, and the appliance enrols again to be given one. **[D3]** | Set Up Gateway (primary) | One `UPDATE`. The toast says it was restored. |
| **Restore**, Third-party, Host or Simulated, with a credential | Unchanged | None | The stamp stays. | The account stays disabled until a credential is issued | None | Generate Broker Credential. No kept copy comes back. The Restore dialog names Host and Simulated and leaves out Third-party: **[D2]** | One `UPDATE`. The toast says it was restored. |
| **Restore**, any type, with no credential | Unchanged | None | None | None | None | As an active gateway | One `UPDATE` |
| **Auto-delete**, any type but Playback | The row goes | Go with the row | Gone | Nothing is asked: the account was disabled when the gateway was archived. | The sweep removes any key left and archives the repository. A repository is never deleted. | n/a | One `DELETE`, by the retention job, and a tombstone on the Archived Entities page. It runs nightly at 03:30. A gateway with no timer, or one a playback names, is skipped. |
| **Delete**, any type but Playback | The row goes | Go with the row | Gone | An archived gateway: as for auto-delete. One that is not archived and holds a credential: its account is disabled. | As for auto-delete | n/a | One `DELETE`, and a tombstone for an archived gateway. The toast says it was permanently deleted. |

## Proposals

A proposal can carry six columns of a gateway: `name`, `description`, `cell_id`, `area_id`,
`location_scope` and `access_url`. Machines propose and people decide. Approving is applying: it writes the
columns in the approver's transaction.

| Step and type | Status | Setup token | Record | Broker | Forge | Drawer | Audit and toast |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Rename, relocate or set the console address by proposal**, any type | Unchanged | Unchanged | Unchanged | Unchanged | Unchanged | Unchanged | One `UPDATE` by the approver and one `PROPOSAL_APPLIED` row that names both people, in one transaction |
| **Type, group, archive, restore, delete, setup or credentials by proposal** | Refused when the proposal is filed | n/a | n/a | n/a | n/a | The Type select is disabled for a person who may only propose | None |

## Where the code differs

Each key below is a row above. A difference is a bug, and the suite marks it as expected to fail so that
whoever fixes it has to remove the mark and this text with it.

| Key | What the code does today | How it is confirmed |
| :--- | :--- | :--- |
| **[D2]** | *The Restore dialog names Host and Simulated gateways where a credential is issued again, and leaves out Third-party.* The drawer offers Generate Broker Credential to a Third-party gateway as it does to the other two. | `ArchivesTab.test.jsx` and `gatewayRowActions.test.jsx`, which hold the dialog's text |
| **[D3]** | *The Gateways help says restoring a gateway brings back its deploy key, which it does not.* The forge sweep removes the key on archive and has nothing to register on restore. The Restore dialog says so correctly. [An appliance that is lost, stolen or scrapped](remote-gateways.md#an-appliance-that-is-lost-stolen-or-scrapped) says the same as the help. | `test_forge_sweep.py`, and the sweep's own source |
| **[D4]** | *Issuing a setup token for an archived gateway succeeds and moves it to Awaiting setup.* Credential issue refuses an archived gateway. Redeeming the token is refused, so nothing can enrol. | `test_gateway_lifecycle.py`, expected to fail |
| **[D6]** | *Changing the type of an archived gateway leaves the old type's status behind.* The clean-up skips an archived gateway. The Edit dialog is not offered for one, so only a direct write reaches it. | `test_gateway_lifecycle.py`, expected to fail |
| **[D7]** | *A Remote gateway whose appliance was rebuilt has no Re-issue Setup in the drawer.* [Re-issuing, and what it invalidates](remote-gateways.md#6-re-issuing-and-what-it-invalidates) says to re-issue for a replaced appliance. The drawer offers it only while the gateway waits for its first birth, or after its enrolment was revoked. | `gatewayTypeChange.test.jsx`, which holds the drawer's rule |

## How the code is held to this page

- [`supabase/migrations/test_gateway_lifecycle.py`](../supabase/migrations/test_gateway_lifecycle.py) walks
  every row that the database can answer: the gateway row, its tokens and its record. It runs in the
  `db` lane, against a migrated database.
- [`supabase/functions/enroll-gateway/test_gateway_lifecycle_broker.py`](../supabase/functions/enroll-gateway/test_gateway_lifecycle_broker.py)
  reads the broker account from Dynamic Security after the steps a stack can take, and compares each to
  the record. It runs in the `stack` lane.
- A drift check fails when a type the database admits, or the dashboard names, has no row in
  [*The types*](#the-types), and when a difference above is not held by a test, or a test holds one this
  page does not name.
- A walk with a real Remote appliance, set up from the bundle or the install command, covers the cells
  marked as confirmed by the live walk.

When you add a type, add a row to [*The types*](#the-types) and a row to each table above. When you add a
step, add a table row for each type that can take it, and a test in the suite.

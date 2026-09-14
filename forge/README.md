# The forge's repositories

Everything under this directory is published into the forge (the platform's Gitea) as a
repository, by the platform itself, never by a person pushing to it. The forge is where appliances
read from; this directory is where what they read is written and reviewed.

| Directory | Published as | By |
| :--- | :--- | :--- |
| [`gateway-platform/`](gateway-platform) | `platform/gateway-platform`, tagged `v<version>` | `forge-sweep`, on every pass ([how](../supabase/README.md#the-platform-playbook-is-published-by-the-sweep)) |
| [`gateway-custom-example/`](gateway-custom-example) | `platform/gateway-custom-example`, a template repository, untagged | `forge-sweep`, on every pass ([how](../supabase/README.md#a-gateway-that-needs-code-of-its-own-0106)) |

**Tagged or not** is what the repository is *for*. The playbook is converged to, so an appliance
pins a released version of it and a tag must never move. The example is **copied**, once, by a
person making a gateway that needs code of its own; nothing pins it, so it carries `main` alone
and is marked as a template so the forge offers **Use this template**.

A repository the platform provisions per gateway (`gateways/gateway-<sparkplug_id>`) has no
directory here: it is created empty at enrolment, or copied from the example above, and its
content is the gateway's own from that moment.

**`trust/` on `platform/gateway-platform` has no directory here either**, and cannot: it is the
root the broker is presenting today, which this repository does not know and which changes without
a release. `forge-sweep` writes it from the credential service onto `main`, and it is declared
`unmanaged` in the playbook's `PublishSpec` so publishing the tree neither ships nor deletes it.
It is on `main` rather than in a tag because every appliance must read it whatever tag it is
pinned to (`../supabase/README.md`, "The broker's root rides on `main`").

**Adding one.** Put the directory beside `gateway-platform/`, add a row to `PUBLISHED` in
[`scripts/sync-gateway-platform.mjs`](../scripts/sync-gateway-platform.mjs) so the edge runtime
carries it as a generated module (an edge worker has no filesystem), add a `PublishSpec` to the
sweep, and add the row above. `main` on a published repository admits the machine account alone,
so a change is a pull request in this repository and never an edit in the forge.

**One module per directory, not one map of everything.** `gateway-install` zips every entry of the
playbook's map into the `platform.zip` a commissioning appliance fetches, so a second directory
folded into that map would be installed on every appliance in the fleet.

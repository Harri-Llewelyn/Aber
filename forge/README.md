# The forge's repositories

Everything under this directory is published into the forge (the platform's Gitea) as a
repository, by the platform itself, never by a person pushing to it. The forge is where appliances
read from; this directory is where what they read is written and reviewed.

| Directory | Published as | By |
| :--- | :--- | :--- |
| [`gateway-platform/`](gateway-platform) | `platform/gateway-platform`, tagged `v<version>` | `forge-sweep`, on every pass ([how](../supabase/README.md#the-platform-playbook-is-published-by-the-sweep)) |

A repository the platform provisions per gateway (`gateways/gateway-<sparkplug_id>`) has no
directory here: it is created empty at enrolment and its content is the gateway's own.

**Adding one.** Put the directory beside `gateway-platform/`, add it to
[`scripts/sync-gateway-platform.mjs`](../scripts/sync-gateway-platform.mjs) or a sibling so the
edge runtime carries it as a generated module (an edge worker has no filesystem), teach the sweep
to publish it, and add the row above. `main` on a published repository admits the machine account
alone, so a change is a pull request in this repository and never an edit in the forge.

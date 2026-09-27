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

## Provisioning the server

[`scripts/gitea-init.sh`](../scripts/gitea-init.sh) runs in the chart's initContainer before the
Gitea server starts, from a mirror the sync script keeps identical to the file in `scripts/`. It
is provisioning policy, which accounts exist and what they may do, and policy that lives in two
hand-copied shell blocks drifts; the same arrangement `node-red-init.mjs` has, for the same reason.

**It calls the image's own setup rather than writing `app.ini` itself.** Every `gitea` subcommand
refuses to run without a config file, with an error that names `--config` and reads as a broken
image. `/etc/s6/gitea/setup` is what the server runs to build one from the `GITEA__section__KEY`
environment, so calling it here means the two containers cannot disagree about what they built.
Re-running it is harmless: the template is expanded only when `app.ini` is absent, and the
environment-to-ini step merges into it rather than replacing it. The script runs as root and then
as `git` through `su-exec`: the setup script chowns `/data` to the `git` user, which is the whole
reason the server can read what this wrote, and every gitea command after it runs as that user so
nothing in the database or the repository tree ends up owned by root.

**Two accounts, and the second one is the point.** The administrator exists because
`INSTALL_LOCK` closes the web installer: a forge on a plant network would otherwise be one HTTP
request away from anybody making themselves its admin. It is for a human, rarely. The machine
account is what the platform authenticates as, and it is deliberately not an admin: it owns the
per-gateway repositories, which is all the authority it needs to create one and attach a deploy key
and branch rules to it. An admin token would be able to read and rewrite every repository in the
forge, including the playbook the whole fleet converges to, and it would be held by an edge
function reachable from the network. The machine account is optional, and its absence is a
deployment without the forge integration rather than a broken one: `enroll-gateway` creates a
gateway's repository and registers its deploy key only when it holds these same credentials, so
unset at both ends means enrolment behaves exactly as it did before the forge existed, and says so
in its response. Setting the password at one end and not the other is the case worth being loud
about, so the platform logs what it could not reach rather than silently skipping.

**Idempotent by inspection, not by `|| true`.** Creating an account that already exists is the
ordinary state of every boot after the first and exits non-zero; every other non-zero exit, an
unwritable volume, a corrupt database, has to keep failing. Swallowing the code would report both
as provisioned, so the script reads the command's output for "already exists" and refuses to
report success on anything else.

**It publishes the SSH host key, so an appliance can verify this forge instead of trusting it on
sight.** A gateway clones over SSH with its deploy key. With no `known_hosts` entry it must either
accept whatever key answers on the first connection, trust on first use, which is exactly the
moment an attacker would choose, or be told to skip verification, which this platform refuses
outright. Neither is acceptable for a machine that will pull unattended for years.

The host key is public by construction: anyone who can open a TCP connection to port 22 is handed
it during the handshake, which is what `ssh-keyscan` does. Publishing it changes nothing about its
secrecy; it is the private half in the same directory that matters, which is why only the `.pub`
is copied and why the script refuses to run if the file does not start with the algorithm name,
since copying a private key into a directory served over unauthenticated HTTP is the one mistake
here that would matter. What makes the published key trustworthy is the channel it arrives on, not
the file: `enroll-gateway` reads it over the internal network and returns it inside the enrolment
response, which the appliance already fetches over TLS, authenticated by a single-use token bound
to one gateway row. So the appliance learns the forge's identity from the platform it already
trusts, before its first clone, and trust on first use never happens. An appliance fetching the
URL directly would be back to trusting the network, so nothing in the bundle does.

`/data/gitea` is Gitea's custom directory and `custom/public/` is served at `/assets/`, measured
against the running forge rather than assumed: the file appears at `/assets/ssh_host_key.pub` with
no restart, which also means a rotated host key is republished by the next boot. Only the ed25519
key is published, of the three sshd offers: `ssh` negotiates a host key algorithm it has a known
key for, so one line is a complete answer rather than a partial one, and ed25519 is what
`bootstrap.mjs` generates its own key as, so an appliance needs no second algorithm anywhere. The
image generates host keys when the sshd service starts, in the server container, after this one
has already exited, so on a fresh volume there would be no key to publish and every appliance
enrolling before the next restart would get none; the script calls `/etc/s6/openssh/setup` first,
which is idempotent and is the same script the server will run, so the key published is the key
sshd will present. A missing key is not fatal: a forge with no host key still serves HTTP, so the
dashboard, the proposals and every existing appliance are unaffected. What is lost is new
appliances, which enrol with no `known_hosts` entry and decline to converge rather than trusting an
unverified forge, and the script says so because nothing else would.

# The forge's repositories

**In short:** the forge is Aber's built-in git server (Gitea). This folder holds the repositories
Aber publishes into it itself, such as the playbook every Remote gateway follows. Read this before
changing what gateways install or run.

Everything under this directory is published into the forge (the platform's Gitea) as a
repository, by the platform itself, never by a person pushing to it. The forge is where appliances
read from; this directory is where what they read is written and reviewed.

| Directory | Published as | By |
| :--- | :--- | :--- |
| [`gateway-platform/`](gateway-platform) | `platform/gateway-platform`, tagged `v<version>` | `forge-sweep`, on every pass ([how](../supabase/README.md#the-platform-playbook-is-published-by-the-sweep)) |
| [`gateway-custom-example/`](gateway-custom-example) | `platform/gateway-custom-example`, a template repository, untagged | `forge-sweep`, on every pass ([how](../supabase/README.md#a-gateway-that-needs-code-of-its-own-archived-migration-0106)) |

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

[`scripts/gitea-init.sh`](../scripts/gitea-init.sh) runs in the chart's two init containers before
the Gitea server starts (`gitea-init`, then `gitea-token` for the machine account's token), from a
mirror `scripts/sync-helm-chart-files.mjs` keeps identical to it. It
is provisioning policy, which accounts exist and what they may do, and policy that lives in two
hand-copied shell blocks drifts; the same arrangement `node-red-init.mjs` has, for the same reason.

**It calls the image's own setup rather than writing `app.ini` itself.** Every `gitea` subcommand
refuses to run without a config file, with an error that names `--config` and reads as a broken
image. `/etc/s6/gitea/setup` is what the server runs to build one from the `GITEA__section__KEY`
environment, so calling it here means the two containers cannot disagree about what they built.
Re-running it is harmless: the template is expanded only when `app.ini` is absent, and the
environment-to-ini step merges into it rather than replacing it. The script runs as root and then
as `git` through `su-exec`: the setup script chowns `/data/gitea` and `/data/git` to the `git`
user, which is the whole reason the server can read what this wrote, and every gitea command after
it runs as that user so nothing in the database or the repository tree ends up owned by root.

**A restored database is given back to `git`.** After the setup, the script checks `gitea.db`, its
`-journal`, `-wal` and `-shm` files, and `/data/gitea` itself. Whatever `git` does not own is
chowned to it, and one log line names it. A normal start changes nothing.

The setup misses this case: it chowns `/data/gitea` recursively only when the directory itself is
not `git`'s. The backup service copies `gitea.db` as root, so a forge archive taken before 1.4.0
holds it as root. A restore untars as root, which keeps an archive's owners, so the database came
back unwritable inside a `git`-owned directory. Measured against `gitea/gitea:28.0.0`, the server
then answered `/api/healthz` with 200 and failed every write with `attempt to write a readonly
database`; nothing reported it. Since 1.4.0 `gitea-token` writes the database before the server
starts, so without this step the pod stops in `Init:CrashLoopBackOff`. The token step and the gitea
CLI write only the database and its directory (measured), so nothing else is changed: the
repository tree and the host keys keep the owners the setup gives them.

**Two accounts: an administrator and a bot.** The administrator exists because `INSTALL_LOCK`
closes the web installer: a forge on a plant network would otherwise be one HTTP request away from
anybody making themselves its admin. It is for a human, rarely. The machine account,
`gitea.machineUser` (`aber_platform`), is what the platform authenticates as. It is a Gitea **bot**,
and deliberately not an admin: it owns the per-gateway repositories, which is all the authority it
needs to create one and attach a deploy key and branch rules to it. An admin token would be able to
read and rewrite every repository in the forge, including the playbook the whole fleet converges
to, and it would be held by an edge function reachable from the network.

A bot is the narrowest account Gitea 28 has for this, measured against `gitea/gitea:28.0.0`:

- **It holds no password.** `gitea admin user create --user-type bot` refuses one, and so does
  `change-password`. An account an earlier release made as a person, with a password, is converted
  in place by `gitea admin user change-type`, and its stored password then answers 401.
- **Nothing signs it in to the web UI.** A reverse-proxy header naming it gets the sign-in page,
  even from the forge's own loopback, and a site admin cannot impersonate it.
- **Its only credential is one scoped token**, below. `GET /api/v1/user` answers `"type": "Bot"`.

The script acts only after checking the account's type in Gitea's database: absent, it creates the
bot; a person (`type` 0), it converts it; a bot (`type` 4), it leaves it alone; anything else stops
the forge, with a message. A site administrator cannot become a bot, so an account someone made one
stops the forge the same way.

The machine account is optional, and its absence is a deployment without the forge integration
rather than a broken one: `gitea.machineUser: ""` creates no account and mints no token, and the
functions pod is given no forge variables, so `enroll-gateway` enrols exactly as it did before the
forge existed and says so in its response.

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

The host key is public by construction: anyone who can open a TCP connection to the SSH port is
handed it during the handshake, which is what `ssh-keyscan` does. Publishing it changes nothing about its
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

## How the platform reaches the forge

The edge functions call Gitea's API through the gateway's `forge-api` listener, on
`supabase-envoy:8003`. They never reach Gitea's own port 3000. This section is for anyone changing
how a function talks to the forge.

**Why not port 3000.** Gitea signs in whoever the `X-WEBAUTH-USER` header names on its web routes,
from any peer that reaches port 3000. A function that reached that port could become any user, the
site administrator included. Measured against `gitea/gitea:28.0.0`: the header fetched the audit
export from another container on the same network.

**What the listener does**, measured with `envoyproxy/envoy:v1.39.2` running the shipped
`supabase/envoy.yaml`:

- It serves `/api/` and `/assets/ssh_host_key.pub`, the host key enrolment hands an appliance.
- It answers 403 to every other path, after normalising it. `/api/../-/admin`,
  `/api/%2e%2e/-/admin` and `/API/v1/version` all answer 403, and an escaped slash (`%2f`) answers
  400.
- It removes `X-WEBAUTH-USER`, `X-WEBAUTH-EMAIL` and `X-WEBAUTH-FULLNAME` from every request. So
  even a path that reached Gitea would sign nobody in.
- It removes `X-Real-IP`, `True-Client-IP` and `Forwarded`, and sets `X-Forwarded-For` to the
  caller's own address. Gitea's audit log then records the function pod's address, not one a
  request chose. Without this, a request's own `X-Real-IP` was what Gitea recorded (measured).
- It logs refusals only (400, 401, 403 and 5xx) as `aber-forge-api` lines. The 404s the platform's
  look-before-create calls draw on every pass are not logged.

**Who reaches it.** Under `networkPolicy.enabled`, only `supabase-functions`, on the edge
`supabase-functions → supabase-envoy:8003`. Port 3000 admits the gateway alone, whether or not that
layer is on, through the forge policy the chart always renders. With the layer off, any pod can
reach 8003, as any pod can reach the `forge` listener's own `/api/` route on 8002. Neither serves a
web route or passes the header on.

The push webhook is unchanged: Gitea delivers it to `forge-events` directly, on
`gitea → supabase-functions:9000`. `test_forge_sweep.py` (`TestTheEdgeRuntimesPathToTheForge`) asks
from inside the functions pod: a web route with the header is refused, the API and the host key
answer, and `gitea:3000` does not answer at all.

## The machine account's token

Every call the platform makes to the forge carries one Gitea access token, named `aber-platform`,
with four scopes. The forge mints it when it starts, and the edge runtime reads it from a file. This
section is for an operator who rotates it or is reading why a forge call failed.

### Rotating it

Empty the Secret and restart the forge:

```bash
kubectl -n aber patch secret aber-forge-token --type merge -p '{"data":{"token":""}}'
kubectl -n aber rollout restart deploy/gitea
```

The forge's next start deletes the old token, mints a new one and writes it into the Secret. The old
token stops working at once (measured: 401). The functions pod reads the new one within about a
minute; until then each forge call is skipped and logged as `the forge's token has not been
delivered yet`. The Secret is `<release>-forge-token`, so `aber-forge-token` for a release named
`aber`.

Gitea 28's in-place regeneration (go-gitea/gitea#38907) does not reach this token. It is a web-UI
action on your own tokens, and nobody can sign in as a bot or impersonate one (measured: 404 for
another account's token, 400 for impersonating the bot).

### The scopes

`write:organization,write:issue,write:repository,read:user`, in the order Gitea normalises them to.
Each was measured by driving the platform's own calls (`_shared/forge.ts`, `forge-membership`,
`forge-sweep`, `forge-events`, `enroll-gateway`) against `gitea/gitea:28.0.0` with a token lacking it:

| Scope | What needs it | Without it |
| :--- | :--- | :--- |
| `write:organization` | The `gateways` and `platform` organisations, their teams, every seat placed or removed, the repository listing | `POST /orgs` answers 403 with `read:organization`; `GET /orgs/gateways` with neither |
| `write:repository` | Repositories, branch rules, deploy keys, the push webhook, commits, tags, commit statuses, the archive mark, raw reads | `POST /orgs/gateways/repos` answers 403 with `read:repository` |
| `write:issue` | The *Incident* label enrolment creates | `POST /repos/…/labels` answers 403 |
| `read:user` | Looking up a person's forge login before seating them | `GET /users/{name}` answers 403 |

Everything else is refused. `test_forge_sweep.py` asserts two of the refusals: adding an SSH key to
the account (`write:user`) and listing the site's users (`read:admin`). A refused call answers 403
naming the scope it needed. A change that needs another scope adds it to `TOKEN_SCOPES` in
[`scripts/gitea-init.sh`](../scripts/gitea-init.sh), in Gitea's order; the next forge start sees
different scopes and mints a new token.

### How it reaches the functions

1. `gitea-init` makes the account a bot, as above.
2. `gitea-token`, the pod's second init container, gives it its token. It runs as `git` with a
   read-only root filesystem and no capabilities, and it is the only container in the pod holding a
   ServiceAccount token. It reads the Secret through the API, and the `access_token` row named
   `aber-platform` from Gitea's database.
3. **It keeps the token** when the forge holds one under that name, with the same scopes, ending in
   the same eight characters. Gitea stores only a hash and those eight, and the server has not
   started yet, so that is as far as a check reaches. Otherwise it deletes the row by name, mints
   with `gitea admin user generate-access-token --raw --scopes …`, and patches the Secret.
4. The Role `<release>-gitea` grants `get` and `patch` on that one Secret. A Role cannot restrict
   `create` by name, so the chart creates the Secret, empty, and carries its value through
   `helm upgrade` with `lookup`, as the playback delivery Secret is. `resource-policy: keep` keeps it
   through an uninstall. A render without the cluster (`helm template`, a GitOps tool) writes it
   empty, and the forge mints a new token on its next start.
5. The functions pod mounts the Secret at `/home/deno/forge`, marked optional so the pod starts
   before it holds anything. `main/index.ts` reads the file at each worker spawn and hands the
   forge functions `GITEA_MACHINE_TOKEN`. A file and not an environment variable, because the
   kubelet refreshes a mounted Secret and never an environment variable.
6. Under `networkPolicy.enabled` the forge pod joins the API-server egress policy.

### When the token is missing

- **An install or an upgrade.** The functions pod can start before the forge has minted the token.
  For that minute or two, enrolment completes without a repository (enrol the appliance again), the
  sweep answers 503 and is asked again within fifteen minutes, and the door lets people in with the
  seats they already hold. It ends without a restart.
- **An upgrade from 1.3.0.** A 1.3.0 functions pod still running sends the old password, which the
  converted account refuses with 401, until the rollout replaces it.
- **The API server cannot be reached.** `gitea-token` retries for a minute, then fails, and the
  forge does not start until it can. The pod retries on its own. A 401, 403 or 404 fails at once:
  the Role or the Secret is missing.
- **A Gitea upgrade.** The script reads `user.type` and `access_token`'s `uid`, `name`,
  `token_last_eight` and `scope` with the image's `sqlite3`, and deletes `access_token` rows by
  `uid` and `name`. A Gitea release that moves them stops the forge with the failing statement in
  the log, which the upgrade's own test run meets first.

The conversion is in the audit log (`user:type:update`, actor `(gitea-cli)`); minting the token is
not, because the CLI's `generate-access-token` records nothing. Every event the platform causes
carries `actor_credential: access-token:<id>`, which names the token it used.

## The audit log

The forge keeps a record of who changed its controls: team seats, deploy keys, branch rules made in
the web UI, accounts. It answers the question `forge-sweep`'s summary cannot. The sweep says what it
put back; the log says who took it away. This section is for an operator with `kubectl` access to
the release's namespace.

### Reading it

Open a port-forward to the forge's own port, then ask for the export as the administrator:

```bash
kubectl -n aber port-forward deploy/gitea 3000:3000
# in a second terminal:
curl -s -H 'X-WEBAUTH-USER: gitea_admin' \
  'http://127.0.0.1:3000/-/admin/monitor/audit_logs/export?action=repository:branch:protection' \
  -o forge-audit.jsonl
```

Each line is one event, oldest first: the action, the actor, the origin (`ui`, `api`, `cli` or
`system`), the IP address, the time and what changed. The export takes the listing's filters:
`action` (a whole action, or a prefix such as `repository:branch:protection`), `actor` (a username)
and `origin`. Leave them out for every event. Close the forward when you are done: while it is open,
anything on your machine that can reach port 3000 can act as any forge user.

`gitea_admin` is the administrator `gitea.adminUser` names. A different value there means a
different header value here.

**Why this works, and why only for an operator.** Gitea signs in whoever the `X-WEBAUTH-USER` header
names, from any peer that reaches port 3000. A port-forward arrives from the pod's own loopback, so
the forge treats it like any other peer. The NetworkPolicy edge list keeps every pod but the gateway
off that port. The gateway's `forge` listener replaces the header with the signed-in person's id, and
its `forge-api` listener, the edge functions' path, removes it. So the path is open to someone who may port-forward in the namespace, and that
person can already do anything there. Measured against `gitea/gitea:28.0.0` on 2026-10-12: the
header fetched the export from the pod's loopback and from another container on the same network,
and a request without it was sent to the sign-in page.

### What it records here, and what it does not

Measured against `gitea/gitea:28.0.0` by driving the platform's own calls (enrolment, the door's
placement, the sweep) and reading the export after each step.

| Change | Recorded? |
| :--- | :--- |
| A person's first visit (`user:create`, actor `(gitea-auth-source)`) | Yes |
| A seat placed or taken away (`organization:team:member:add`/`remove`) | Yes |
| A gateway's repository and its wiki page created at enrolment | Yes |
| A deploy key removed, by the sweep or by enrolment | Yes |
| A branch rule, deploy key, webhook or archive mark changed **in the web UI** | Yes, with the person who did it (measured for a branch rule; the rest read from the source) |
| The machine account's type changed with `gitea admin user change-type` | Yes, actor `(gitea-cli)` |
| A branch rule, webhook or archive mark changed **through the API** | **No** |
| A deploy key added through the API | **No** |
| Accounts created and tokens minted with `gitea admin` | **No** |
| Sign-ins, clones, pushes and page views | **No** |

**A rule changed through the API leaves no event.** Gitea 28.0.0 records branch-rule, webhook,
archive and deploy-key-add changes only in its web handlers (`routers/web/repo/setting/`), not in
the API's. The platform makes every one of those changes through the API, so its own furnishing is
not in the log either. What the log adds is the person who changed a rule in the web UI, which is how
a person changes one. Someone holding the machine account's credential or `gitea_admin`'s password
could change a rule through the API unrecorded. The sweep still puts the rule back within fifteen
minutes. `test_forge_sweep.py` holds both halves: the web change is found under its author, and the
API change is not found at all, so a Gitea that starts recording it fails the test and this table is
updated.

**A quiet sweep writes nothing.** Every step of a pass reads before it writes, so a pass that finds
the forge as it left it records no event. The door's placement is the same: `forge-membership` asks
whether a person holds a seat before taking it away, because Gitea answers 204 to removing a
non-member and records the removal anyway. Before that check, every visit logged a removal that
never happened, up to twelve an hour for each person using the forge.

### How long events are kept

`gitea.audit.retentionDays`, **365** by default, and `0` keeps every event. Gitea's own default is
30 days, which can be shorter than the gap between a rule changing and someone asking why. A daily
Gitea job deletes older events. The events are rows in `gitea.db`, so the backup takes them with the
rest of the forge and a restore brings them back.

The table stays small. An event is about 410 bytes on disk with its indexes (2,044 events took
839,680 bytes in `audit_event`). A busy site writes tens of events on a day with changes and none on a
day without. A year at a hundred a day is about 15 MB on the forge's 10 GiB volume.

### Other ways to read it, which the chart does not take

**One named person as a site administrator** is a per-site choice. `gitea_admin` can make one
person's forge account an administrator, in the web UI through the port-forward above or with
`PATCH /api/v1/admin/users/{username}`. That person then reads the whole log through the `forge`
listener, with no port-forward. They also get every right the machine account holds, and more: they
can change the rules the sweep defends, delete repositories and make other administrators. The chart
never does this, and the sweep never undoes it, so a site that does it must also remember to undo it.

**Raising the dashboard's Administrators to repository admin or organisation owner** is not
recommended. It would let them read each repository's or the organisation's events. It would also
hand every one of them the branch rules and deploy keys `forge-sweep` defends, and the sweep and the
people it seats would keep undoing each other.

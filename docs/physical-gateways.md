# Physical gateways — operator runbook

How a piece of hardware on a shopfloor becomes a gateway this platform trusts, and what to do when
that goes wrong.

A **virtual** gateway is a connector running on the application host: it exists the moment its row
does, and it needs nothing installed. A **physical** gateway runs on its own machine — a Raspberry
Pi, an industrial PC, a spare server in a cabinet — and has to be given an identity, a credential and
a way to verify the broker before it can publish anything. This document is about the second kind.

> **The short version.** Create the gateway in the dashboard with *Virtual* left unchecked and
> paste the command it shows on a fresh Ubuntu machine; it installs everything, enrols, and prints
> the editor password once. Or download the bundle, copy the folder to a machine with Docker, run
> `docker compose up -d --build`, then `docker compose logs bootstrap`. Either way the gateway goes
> **AWAITING SETUP → ENROLLED — NO DATA YET → ONLINE** on its own.

---

## 1. What the design is protecting against

Every decision below follows from one constraint: **the bundle travels through untrusted places.** It
goes into a downloads folder, onto a USB stick, probably through a chat message, and it sits on a
laptop afterwards. So it must not contain anything worth stealing.

It therefore carries a **claim, not a credential**:

| | In the bundle | Obtained by the appliance |
| :--- | :--- | :--- |
| Broker password | ✗ never | ✓ at first boot, from `enroll-gateway` |
| Enrolment token | ✓ single-use, 30-minute default | — |
| Broker CA | ✗ | ✓ at first boot, with the credential |
| Editor password | ✗ | ✓ generated on the appliance, printed once |

The token is single-use and bound to one gateway. Once redeemed it is inert, so a copy of the bundle
left on a laptop grants nothing. That is the whole point of the indirection — a broker password in
that file would have no revocation story at all.

---

## 2. Provisioning, step by step

### In the dashboard

0. **The deployment must know its own address first.** The page asks `gateway-bundle` whether an
   appliance could enrol and, if not, says so above the table and in the form, naming the variable
   (§7). Save is withheld for a Remote gateway until it can; Host and Simulated are unaffected.
   `npm run setup` asks for the domain when it writes a values file.
1. **Gateways → New Gateway.** Name it after the machine or the cell it serves.
2. **Leave “Mark as Virtual Gateway” unchecked.** The form says which way it is going before you
   save: *“Runs on its own hardware. On save you will be given a bundle to copy to that machine.”*
3. **Save.** The setup modal opens and **mints immediately** — the gateway is seconds old, so
   there is no earlier token for this one to invalidate. It is now **AWAITING SETUP**
   (`PENDING_ENROLLMENT`). On a deployment with TLS on its API the modal shows **one command to
   paste**; otherwise it downloads the **bundle** (a folder to copy), and either can be swapped
   for the other from the modal, which re-mints and asks first.
4. **Copy the command**, or the three bundle commands, with the button beside them, and note the
   countdown: the token is good for 30 minutes.

Coming back later — **Gateways → the gateway → Download Setup Bundle** — behaves differently on
purpose. That gateway may already hold a command or bundle somebody is carrying to a machine, so
the modal **asks first and makes you type the gateway's name** before it mints anything. See §6.

Requires **Administrator** or **Shopfloor_Manager** (`gateway:manage`). Operator and Auditor never
see the action, and `gateway-bundle` answers `403` if it is called anyway — no token is minted by
the refusal.

### On the appliance: the command

A fresh **Ubuntu** or **Ubuntu Server** machine (amd64 or arm64) with a user who can `sudo` and a
route to the platform. Paste the command. It is two stages in one line:

- **Stage 0 carries no secret.** It fetches the platform's root certificate over plain HTTP from
  the dashboard's host (`/.well-known/acs-cymru/ca.pem`, inert bytes), computes the SHA-256 of
  the root's public key, compares it with the **pin** the dashboard minted beside the token over
  your authenticated session (the trusted channel), and installs the root only when they match.
  A mismatch stops there and nothing has been sent. The public key rather than the certificate is
  pinned, because the root's certificate is re-issued a year before it expires while its key
  stays (`deploy/k8s/internal-ca.yaml`).
- **Stage 1 runs over TLS that pin has verified.** It fetches the installer with the token in a
  header and runs it as root with the token and the pin in its environment. The installer puts
  the packages the playbook needs in place, fetches the platform playbook and runs it (packages,
  upgrades, chrony, Docker, the compose project; §12), writes the appliance's `.env` from a
  token-gated fetch, and **enrols last** by starting the compose project. Every step before
  enrolment is idempotent and the same command can be pasted again; only enrolment spends the
  token, and the installer refuses to run on an appliance that has enrolled.

It ends by printing the Node-RED editor password **once**, and within about a minute the dashboard
shows the gateway **ONLINE**. The installer then runs the appliance's first convergence from the
forge; the timer the playbook installed does the rest.

**Why the command is not `curl | bash` alone.** A fresh appliance does not trust the platform's
internal root, and a one-liner that ends in `curl -k` would be worse than the bundle. The pin is
what lets the appliance trust the root it fetched without trusting the network it fetched it
over. A plant that images its own appliances can plant the root with cloud-init instead and skip
stage 0.

**On a deployment without TLS on its API**, the command is not offered: the installer route
carries the token and the credential secret, and `gateway-install` refuses to serve them over
plain HTTP. The readiness answer says so and the modal offers the bundle. (The development values
set `allowPlaintextInstaller`, which mints an unpinned command over HTTP on a laptop cluster and
nowhere else; the modal says when a command is unpinned.)

### On the appliance: the bundle

The bundle is for a machine that already has Docker, or one set up by hand. Copy the whole
unpacked folder to the machine, then:

```bash
cd acs-gateway-<name>-<sparkplug_id>
docker compose up -d --build          # ~1 minute; builds on the appliance, see §4
docker compose logs bootstrap         # prints the Node-RED editor password, ONCE
```

Within about a minute the dashboard shows the gateway **ONLINE**. Nothing converges the host of a
bundle-installed appliance until somebody runs the platform playbook on it once (§12).

### Prerequisites on the appliance

* For the command: Ubuntu, `curl` and `openssl` (both in a default install), and `sudo`.
* For the bundle: Docker and the Compose plugin.
* A route to the platform's API — the address in `ACS_SUPABASE_URL`, which the server refuses to set
  to anything in-stack (§7).
* A route to the broker on **8883**. Physical gateways use MQTTS exclusively; 1883 is published only
  for gateways not yet moved, and is not used here.
* The broker's hostname must resolve. It also has to be in the certificate's SAN — see §7.

---

## 3. What is in the bundle

```
acs-gateway-<name>-<sparkplug_id>/
├── .env                  generated per gateway — the only file that differs between bundles
├── GATEWAY.txt           which gateway this is, and the two commands. Self-identifying on a USB stick
├── docker-compose.yml     bootstrap (one-shot) + node-red
├── Dockerfile             thin layer on a pinned nodered/node-red
├── bootstrap.mjs          first-boot provisioning
├── flows.template.json    the sample flow, with placeholders
└── README.md              the appliance-side copy of this procedure
```

Everything except `.env` and `GATEWAY.txt` is mirrored verbatim from
[`forge/gateway-platform/appliance/`](../forge/gateway-platform/appliance/).

`.env` carries exactly six values, all read by `bootstrap.mjs`:

| Key | Purpose |
| :--- | :--- |
| `ACS_SUPABASE_URL` | the platform, as reachable **from the appliance** |
| `ACS_SUPABASE_PUBLISHABLE_KEY` | gets the request past the gateway's key check; public by construction |
| `ACS_ENROLLMENT_TOKEN` | the single-use claim |
| `NODERED_CREDENTIAL_SECRET` | encrypts `flows_cred.json` on the appliance; **generated per bundle** |
| `ACS_AGENT_VERSION` | recorded on the gateway so the fleet's vintage is visible |
| `ACS_GATEWAY_NAME` | display name only |

`NODERED_CREDENTIAL_SECRET` being per-bundle matters: a shared value would let one appliance's
credential file be decrypted with another's `.env`.

---

## 4. Why the image is built on the appliance

`docker compose up --build` takes about a minute on a Pi. That is deliberate:

* It removes any need for the plant to reach `ghcr.io`.
* An **arm64** appliance builds the same `Dockerfile` unchanged. The platform's published images are
  `linux/amd64` only, so a pulled image would not run on a Pi at all.

The base tag is pinned to the same tag the platform's own Node-RED uses. The generated `settings.js`
depends on Node-RED contracts internal enough to move between releases, and an appliance is the worst
place to discover that — it is the hardest thing in the deployment to get a shell on.

---

## 5. The enrolment lifecycle

```
   operator saves a physical gateway
                │
                ▼
      PENDING_ENROLLMENT ── "AWAITING SETUP"        waiting for a PERSON
                │                                    (solid badge)
                │  appliance redeems the token
                ▼
        AWAITING_BIRTH ──── "ENROLLED — NO DATA YET" waiting for a MACHINE
                │                                    (dashed badge)
                │  first Sparkplug NBIRTH arrives
                ▼
             ONLINE
```

The last transition needs no code: the ingestion daemon writes `status` on every node-level message,
so the first heartbeat clears the transitional state.

**Neither pending state counts as a fault.** They do not turn a cell amber on the Cells page and are
counted separately from *offline* on the Site Map — a gateway waiting for somebody to carry a bundle
to a machine is an unfinished task, and flagging it as broken would make the attention signal useless
on the day a few appliances are ordered.

### What `enroll-gateway` does, in order

1. **Claims the token atomically.** Two appliances racing one token produce exactly one winner. This
   matters because the broker ACL pins the topic's edge-node segment to the connecting username, so
   two credentials for one gateway would silently contend for a single Sparkplug identity.
2. **Issues the broker credential** through the credential service beside the broker.
3. **Marks the gateway `AWAITING_BIRTH`.**

If step 2 fails the claim is **released** and the response is `503` with `retryable: true` — the same
bundle works again, so a broker restart during commissioning costs a retry rather than a new bundle
for every appliance. `bootstrap.mjs` retries that case on its own, six times over about two minutes.

---

## 6. Re-issuing, and what it invalidates

Only **one bundle works at a time**. Issuing consumes any live token for that gateway, so:

> Every re-issue **invalidates the bundle you already have.** Delete the old folder, or you will
> eventually boot the wrong one and get a `401` that cannot tell you which bundle was stale.

### Which is why it asks

Everywhere except immediately after creating the gateway, the modal stops and makes you **type the
gateway's name** before it mints. That is not ceremony: the loss is invisible from the dashboard —
the bundle stays on the operator's laptop, the folder still unpacks, and the failure only appears
minutes later at an appliance that cannot say what went wrong. A permission check would not have
helped, because `gateway:manage` **is** the authority to issue bundles; narrowing the role would
only decide who gets to make the mistake.

The name is matched leniently — trimmed, case-folded, inner whitespace collapsed. The gate is
against an accidental click, not a determined typist.

**Cancel** puts you back on the bundle you already had, rather than closing over it. A failed issue
does the same, and leaves the previous bundle live: nothing was minted, so nothing was consumed.

Re-issue when:

* the token expired before the appliance was started (the modal counts it down and says so);
* the appliance was replaced, or its volume was destroyed;
* a gateway sits in `AWAITING_BIRTH` and never publishes. The modal names this case explicitly,
  because re-issuing there also revokes the broker credential its appliance already holds.

The **Re-issue Bundle** action is deliberately absent once a gateway is `ONLINE`: re-issuing then
would invalidate the credential a working appliance is using, which is destructive dressed up as a
convenience. To rotate a live gateway's credential, use
`node scripts/mosquitto-provision-gateway.mjs <sparkplug_id>` or re-enrol on purpose.

### A refused enrolment cannot tell you why

`401` covers unknown, expired **and** already-redeemed, and does so on purpose — distinguishing them
would let someone learn which token values ever existed. The countdown in the dashboard is therefore
the only place the expiry is visible while you still know which bundle is which.

---

## 7. The two addresses that must be right

Both are refused rather than defaulted, because a wrong value here produces an appliance that enrols
perfectly and then connects to nothing — the hardest version of this failure to diagnose.

| Variable | What breaks if it is in-stack |
| :--- | :--- |
| `SUPABASE_PUBLIC_URL` | `gateway-bundle` answers `503` and mints no token. `supabase-kong`, `localhost` and loopback addresses are all refused. |
| `MQTT_PUBLIC_HOST` | `enroll-gateway` answers `503` **without consuming the token**. `mosquitto`, `supabase-kong`, `localhost` and loopback addresses are refused. |

Both name the same machine. The chart derives both from `global.publicBaseDomain`, which
`npm run setup` asks for (`--domain=<base>` answers it from a script; blank keeps the loopback
default, and means remote gateways cannot be enrolled). `supabaseFunctions.gatewayEnrolment`
overrides either where the address appliances dial differs from the domain browsers use, which is
what `npm run dev:up` does on a laptop.

**The dashboard asks before it offers.** `GET /functions/v1/gateway-bundle` reports both addresses,
judged by the same predicates the two refusals use (`_shared/publicAddresses.ts`), and the Gateways
page shows the answer above the table, withholds Save for a Remote gateway and withholds the
drawer's bundle action until the deployment can issue one. A `503` reached some other way is shown
with the variable it names and no retry, since retrying a deployment fault cannot succeed.

`MQTT_PUBLIC_HOST` is also folded into the broker certificate's SAN. Change it and the leaf is
reissued on the next boot of `mosquitto-tls-init` — **the root is untouched, so no appliance has to be
re-enrolled.** A certificate that does not name the address gateways dial fails verification at every
appliance while in-cluster clients verify perfectly, so the stack reports itself healthy and the fleet
is silently off.

---

## 8. Certificates, and the two clocks they run on

**Almost every question about certificates here answers itself once the two are separated.** There
are two, they have nothing in common but a name, and only one of them is your problem.

| | **The root (CA)** | **The leaf** |
| :--- | :--- | :--- |
| What it is | the trust anchor every appliance holds | the certificate the broker presents on 8883 |
| Lifetime | **10 years** (`duration: 87600h`) | **90 days** (`duration: 2160h`) |
| Renewed | a year early (`renewBefore: 8760h`) | 30 days early (`renewBefore: 720h`) |
| Who holds a copy | every gateway, every browser, and three in-cluster clients | only the broker |
| How it is distributed | **by hand, one machine at a time** | it is not distributed at all |
| Automated? | no | completely |

**You distribute the root and you rotate the leaf, and that asymmetry is the entire reason a
certificate hierarchy exists.** A gateway never verifies the leaf against a copy it holds — it
verifies that the root it already trusts signed it. So the certificate that changes four times a
year never has to travel, and the one that has to travel changes once a decade.

### What already happens without you

The leaf renews on its own. cert-manager re-issues at `renewBefore`, the certificate-reload sidecar
sends the broker a `SIGHUP`, and Mosquitto re-reads the certificate **in place without dropping a connected
gateway**. No appliance notices, nothing is redistributed, and there is nothing to do.

### What the fleet tells you, and why it is the right question

Every appliance reports the expiry of **the certificate it is actually holding**, captured at
enrolment and published on the heartbeat:

* the **Gateways page** shows `CA Expires`, in red inside the window;
* `gateway_health.cert_expires_in_days` backs both the fleet dashboard and the
  **Gateway CA Expiring** alert, which fires per gateway at **30 days** and keeps firing once the
  number goes negative.

A check against the broker's own certificate would tell you what the **server** presents. This tells
you what each **client** will accept, and the fleet-wide outage happens on the day those two stop
agreeing — so this is the version worth alerting on.

**The reported date is fixed at enrolment.** Replacing `/data/certs/ca.crt` by hand without
re-enrolling leaves the appliance reporting the old date forever. Until the platform playbook owns
the CA (docs/roadmap.md, "The appliance itself"), re-enrolment is the only path that updates both the file and the number.

### Rotating the root, in the order that matters

Re-minting the root does not fail loudly. It succeeds, and every gateway in the plant drops off
together — which looks exactly like a broker outage and gets diagnosed as one. **The overlap is the
whole design; there is never a moment when one answer is the only correct one.**

1. **Issue the new root alongside the old.** Both valid. The overlap window opens here.
2. **Distribute the new root *in addition to* the old.** A trust store holds many roots — this is an
   addition, never a swap. On an appliance that means a second file in
   `/usr/local/share/ca-certificates/` and `update-ca-certificates`.
3. **Wait until the fleet reports it.** This is what the health telemetry is for. Do not proceed on
   the assumption that a distribution step reached every machine.
4. **Only now switch the broker's leaf** to be issued by the new root.
5. **Remove the old root** once nothing reports it.

Doing 4 before 3 is a flag day, and a flag day is the fleet going dark.

**The overlap window has to be longer than your longest expected outage.** An appliance powered down
across the rotation comes back holding only the old root and cannot be told anything, because it
cannot connect. A year is generous for a plant that runs continuously and is not obviously enough for
seasonal or mothballed lines — that is a question about the site, not about this platform.

> **A note on why this is gentler than it looks.** `internal-ca.yaml` sets `rotationPolicy: Never`,
> so when cert-manager re-issues the root it keeps the **same private key**. A chain signed by the
> re-issued root still verifies against the old copy in an appliance's trust store, because
> verification matches on subject and public key and neither changed. The appliance keeps working
> until *its own copy* expires, which is what the year of `renewBefore` is there to cover. Worth
> confirming against your own fleet before relying on it.

### The clock is part of certificate verification

**A certificate is only valid between two dates, so an appliance with a wrong clock cannot verify
anything.** A fresh Ubuntu install whose NTP is blocked by the plant firewall — common, and the whole
point of an air-gapped network — can sit far enough out to reject a perfectly good certificate. It
presents as a TLS failure at enrolment, or as MQTTS that works in the workshop and not on the line.

Check it first when verification fails for no visible reason:

```bash
timedatectl                       # "System clock synchronized: yes" is the line that matters
openssl s_client -connect <broker>:8883 -showcerts </dev/null | openssl x509 -noout -dates
```

If the plant blocks public NTP, it needs an internal time source and the appliances need to be
pointed at it. That is a conversation with whoever runs the network, and it is worth having before
commissioning rather than during.

**And the wrong clock that does not fail is the one to worry about.** A clock out by months breaks
TLS and stops the appliance dead, in front of whoever is holding it. A clock out by *minutes*
verifies every certificate perfectly, connects, authenticates — and then files every reading at a
time that never happened, because devices supply their own metric timestamps and are trusted for
ordering. Nothing about that appliance looks wrong: it is ONLINE, it drops nothing, and every
number it reports is plausible.

The platform measures this without the appliance doing anything, by comparing the timestamp on each
heartbeat against the time it arrived:

* **Clock offset** on the gateway fleet-health dashboard, **positive meaning the appliance is
  ahead**, which is the direction that corrupts;
* the **Gateway Clock Skew** alert, at a minute of drift sustained for fifteen;
* and past **+5 minutes** the telemetry stops being written at all — refused rather than clamped,
  and counted per gateway by `acs_ingestion_timestamps_rejected_total{edge_node}`. The backward
  tolerance is a full day, because an appliance flushing a buffered outage is legitimate late data.

**Nothing on the platform corrects it, deliberately.** Rewriting a device's timestamps centrally
would swap a visible clock fault for an invisible one and destroy the only evidence the appliance
is wrong. The fix is time synchronisation on the appliance, every time.

### There is no revocation list, and that is a decision

Nothing in this stack publishes a CRL or answers OCSP, and no client here checks for one. For a fleet
of this size that is the right trade — a revocation infrastructure is a service to run, keep
available and distribute in its own right — but it has a consequence worth stating plainly:

**If the root's private key were ever exposed, the only remedy is to mint a new root and repeat the
distribution above for the entire fleet.** There is no faster path. What keeps that acceptable is
that the key never leaves cert-manager's `acs-cymru-ca-key-pair` Secret, is never mounted into an application pod, and is never copied to an appliance —
appliances receive `ca.crt` and only `ca.crt`. Treat that Secret as the most sensitive object in the
deployment, because it is the one thing here with no revocation story.

Broker **credentials** are a different matter and are revocable immediately — see below.

### An appliance that is lost, stolen or scrapped

The broker password is on the appliance in plaintext, in `/data/gateway.env`. That is unavoidable —
something has to connect — and the blast radius is deliberately small: the gateway's broker role
confines it to its own edge node, so a stolen appliance can publish as **itself** and as nothing
else. It cannot forge another gateway's telemetry and it cannot read the fleet's.

**Archiving the gateway is the revocation.** It disables the broker account: the appliance's live
session is dropped at once and its next connection is refused. Do it the moment hardware goes
missing rather than as part of a later tidy-up; the Access Control page shows the account as
*Disabled* once it has landed.

What archiving does **not** do is retrieve the CA copy on that appliance — but that certificate is
public by nature and worth nothing to whoever has the box.

---

## 9. The editor login is local, and why

The appliance's Node-RED uses a **local bcrypt account**, not Supabase SSO. That is a deliberate
divergence from the platform's own Node-RED:

* OAuth requires the authorisation server to hold an **exact** `redirect_uri` per client, and an
  appliance on DHCP has no stable URL. Every shopfloor subnet would fail with `invalid redirect_uri`.
* SSO needs a route to the platform, so the editor would be unreachable exactly when the link is
  down — which is when somebody is standing in front of the box wanting to look at it.

The trade is that the password is per-appliance and cannot be centrally revoked. So it is
**generated** (never defaulted), shown once, and re-issued rather than recovered:

```bash
docker compose run --rm bootstrap node /bundle/bootstrap.mjs --reset-admin-password
```

The **data path is unaffected.** Editor login is a human question; telemetry authenticates to
Mosquitto with the enrolled `sparkplug_id` over MQTTS. The two auth planes are independent, which is
what makes the substitution safe.

---

## 10. Adding devices — nothing is pre-registered

The sample flow includes an **▶ ADD YOUR OWN DEVICE** inject. Click it and the device publishes a
Sparkplug `DBIRTH`; it then appears in the dashboard's **quarantine queue** as `UNKNOWN_DEVICE`, and
its data is dropped until an operator approves it.

That is the intended path. There is no device registration step and no API to call from the flow — the
gateway announces, the platform quarantines, a human approves.

The broker confines this gateway to `spBv1.0/+/+/<sparkplug_id>/#`. A message published under any
other edge node is dropped **silently, by design** — it is what stops one gateway forging another's
telemetry.

---

## 11. Proposing a flow

The appliance's flow lives on a Docker volume on hardware in a plant. It is the only copy, and
`docker compose down -v` or a failed SD card takes the plant's edge logic with it.

**Gateways → select the gateway → Propose a flow.** Export `flows.json` from the appliance's editor
(*menu → Export → all flows*) and drop it there. It is committed to a branch in **this gateway's own
repository** in the forge and opened as a pull request; **nothing is deployed by proposing**.

Once somebody approves and merges it, the appliance's own `flow-sync` service pulls it — within five
minutes by default — and reloads Node-RED. The appliance is what reaches out; the platform never
opens a connection to a gateway, which is the same rule that keeps `node_exporter` unscraped.

**Watching it land.** The drawer's **Committed** row shows the head of `main` the moment the forge
reports the push, and its **Flow** row shows the hash of the flow the appliance last deployed,
reported on every heartbeat from `/data/gitops/deployed.json`. *main moved, deploying* means the
appliance has not ticked since the merge; *matches main* means it has; *differs from main* more than
ten minutes after a merge means the appliance refused the commit or cannot reach the forge, and
`docker compose logs flow-sync` on the appliance says which. An edit made in the appliance's editor
is in neither hash, and the next approved deploy overwrites it.

### What the appliance reports back

`main` is what was approved. **`appliance` is what is running**, a second branch in the same
repository that only the appliance writes and people read in the forge rather than through a shell
on the box. After every pass `flow-sync` pushes two files there when they have changed:
`flows.json` exactly as Node-RED is running it, and `deployed.json`, the record of what was last
deployed and from which commit. That is the whole allowlist; `flows_cred.json` is on no list, and
a staged path outside the list aborts the commit before anything reaches the forge.

The branch is append-only and tamper-evident by the forge's rules, not by the appliance's good
behaviour: the `appliance` rule admits pushes from deploy keys and from no login, and blocks
force-push; `main` admits no deploy key; and a `**` rule closes every other branch to them. So the
deploy key, which is now writable, lets an appliance *report* and never *deploy*. The machine
account cannot write the branch either (its contents API answers 403 there), so what it holds is
what an appliance said.

**Watching it.** The drawer's **Reported** row shows the head of `appliance` and when it was
pushed, and says *edited on the appliance* when the flows.json on the branch differs from the one
the puller last deployed, which is an edit somebody made in the box's editor. The repository
panel's **Running vs approved** link opens the forge's diff between the two branches, which is the
drift in a form a person can read. The heartbeat's flow hash stays the dashboard's source of truth
for what is deployed, because it arrives over the broker credential.

### What the appliance refuses to deploy

`flow-sync` is the last of three checks on a `flows.json` and the only one on the appliance, so it
re-checks what the browser and the edge function already did and adds two of its own:

| Refusal | Why it is a stop rather than a warning |
| :--- | :--- |
| The forge's host key is unknown | With no `known_hosts` entry the appliance could only trust whatever answers on the SSH port. There is no option to skip the check. |
| The tracked branch's history was rewritten | A force-push cannot be told from a legitimate advance, so following one would deploy something no pull request ever showed. A revert must be a new commit. |
| A committed `mqtt-broker` node id has no credential here | Node-RED would start, report success, and hand that node an empty username — the broker refuses it with no stated cause, and the *next* deploy destroys the credential this appliance still holds. |
| The file is not a flow array, or looks like `flows_cred.json` | Same two shape checks the dashboard makes, made where they still matter. |

The third is the one worth knowing about, because the way to cause it is convenient: the editor's
**Import copy** re-ids every node. Commit the appliance's own `/data/flows.json`, never a flow that
has been through an import dialog. `docker compose logs flow-sync` names the node.

| Role | The forge |
| :--- | :--- |
| Administrator | signs in with their dashboard identity; may open, review and **approve** a pull request |
| Shopfloor_Manager | signs in with their dashboard identity; may open and review a pull request, and merge one an administrator has approved |
| Operator, Auditor | no login — the gateway's `forge` listener answers 403 after the OAuth flow |

**Proposing a change is a pull request in the forge, under the author's own name.** The drawer's
**Repository** link opens the gateway's repository; the `flows.json` exported from the appliance's
Node-RED editor goes in as a commit on a branch, and the pull request is the proposal. `main` is
protected on every gateway repository — no direct pushes, one approval required from the
`administrators` team — so an approved merge is the only way a flow reaches `main`, and `main` is
what the appliance pulls. A dropzone in the drawer used to do the first half of this through an edge
function; it went when the forge got a door, because a pull request opened by the person is a better
record than one opened by the platform with their name in the body.

**A host-run gateway has no repository**, and the reason is not a permission. Its connector runs
in the platform's own Node-RED, an instance that can carry several host gateways at once, so
`flows.json` there is the whole instance rather than one gateway's — a change "for" one would replace
every other gateway's flow in the same file. The mechanical reason agrees: repositories are created
when an appliance enrols with a deploy key, and a host-run gateway never enrols.

**`flows_cred.json` is never committed.** It is encrypted with a secret that exists only in the
appliance's `.env`, so a copy on the platform would be either useless or dangerous. Nothing between
the forge's web editor and the appliance checks its shape yet — the puller's refusal above is the
last line, and a required status check in the forge is the next one (docs/roadmap.md, "The appliance itself").


---

## 12. The operating system, and the platform playbook

The bundle covers what runs *in* Docker. What runs *under* it — the packages, the upgrade
policy, the clock, Docker itself, and the timer that keeps all of that converged — is the
**platform playbook**, [`forge/gateway-platform/`](../forge/gateway-platform), published into the forge as
`platform/gateway-platform` and tagged `v<version>` once per platform version.

**The fleet tracks a tag, and the pointer is per gateway.** Enrolment seeds `platform.yml` on
the gateway's `main` naming the tag current at that moment; changing it is a pull request in the
gateway's own repository, so a fleet bump is one pull request per gateway or a scripted batch,
and a canary is one gateway. Nothing tracks `main` of the platform repository, and `main` there
admits pushes from the platform's machine account and nobody else: the playbook is changed in
the platform's own repository and reviewed there.

**`ansible-pull`, not Ansible.** The appliance runs `acs-gateway-converge` hourly and after boot:
it reads the tag from the puller's checkout of the gateway's `main`, runs `ansible-pull` against
the platform repository at that tag over SSH with the same deploy key and the same pinned host
key the puller uses (the key is read-only there; measured to be refused when it pushes), and
records the outcome in `/data/gitops/converged.json`, which the puller adds to the `appliance`
branch. Outbound only, no inventory, self-healing on a timer, idempotent by construction.

**What it decides** is in the playbook's README: Ubuntu and Ubuntu Server, amd64 and arm64;
`unattended-upgrades` without automatic reboot, with Docker's packages held out of it; Docker
from Ubuntu's own archive; `chrony` pointed at what `platform.yml` names (`vars.chrony_servers`)
or Ubuntu's pool; and the compose volume bound to `/var/lib/acs-gateway/data`, so the host's
converge script can reach what `bootstrap.mjs` wrote inside the container.

**The first run is a person's** (or the installer's, when the one-liner lands): the playbook
installs the timer that runs it afterwards.

```bash
sudo apt-get install -y ansible-core
sudo ansible-pull -U ssh://git@<forge>/platform/gateway-platform.git -C v<version> \
  -i localhost, site.yml
```

That expects an enrolled `/data` under `/var/lib/acs-gateway/data` and the bundle's `.env` at
`/opt/acs-gateway/.env`; without the `.env` the playbook sets the host up and says the compose
project was not started.

## 13. Troubleshooting

**The Gateways page says remote gateways cannot be enrolled on this deployment.**
One of the two addresses in §7 is unset or in-stack; the notice names which. Set it where the
deployment is configured (`.env` on Compose, `global.publicBaseDomain` on the chart) and restart
the functions service. The notice clears on the next visit to the page.

**`docker compose logs bootstrap` says the token was refused (`401`).**
Unknown, expired or already redeemed. Re-issue from the dashboard.

**`503` with `retryable: true`.**
The broker credential service was unreachable and your token was **released**. Start the container
again; the same bundle works.

**`503` with `retryable: false`.**
The claim could not be released. That bundle is spent — generate a new one.

**Bootstrap succeeded but the gateway stays `AWAITING_BIRTH`.**
The appliance holds a credential but is not publishing. Check `docker compose logs node-red`:

* `Connection failed to broker` — the broker is unreachable on 8883, or the certificate does not
  name the address being dialled (§7). This message is the same one a wrong password produces and
  never mentions certificates.
* `applied_to_running_broker: false` in the bootstrap output — the credential is stored but the
  running broker has not reloaded it yet (up to ~90s on Kubernetes). Node-RED retries on its own.

**Nothing at all in the dashboard, and bootstrap never ran.**
`docker compose ps` — if `bootstrap` exited non-zero, `node-red` will not have started at all
(`depends_on: service_completed_successfully`). Its logs carry the reason.

**The gateway is `ONLINE` but its devices are not.**
They are in the quarantine queue awaiting approval (§10). That is the design, not a fault.

---

## Related

* [`forge/gateway-platform/appliance/README.md`](../forge/gateway-platform/appliance/README.md) — the copy that
  ships in the bundle
* [`docs/openapi.yaml`](openapi.yaml) — `enroll-gateway` and `gateway-bundle` contracts
* [`deploy/k8s/internal-ca.yaml`](../deploy/k8s/internal-ca.yaml) — the Kubernetes CA
* [`scripts/mosquitto-tls-init.mjs`](../scripts/mosquitto-tls-init.mjs) — the broker CA generator the broker config check builds its TLS fixture with
* [`scripts/mosquitto-provision-gateway.mjs`](../scripts/mosquitto-provision-gateway.mjs) — issuing a
  credential by hand, without the enrolment path

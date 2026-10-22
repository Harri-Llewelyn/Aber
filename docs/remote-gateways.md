# Remote gateways — design

**In short:** why a Remote gateway is set up the way it is. This reference page is for people who
change how gateways enrol, and for anyone who wants the reason behind a step. It covers what the
bundle carries, the enrolment lifecycle, re-issuing, certificates and the clock, the editor login
and the platform playbook.

The steps a site's operator follows are in the help page
[Remote gateways](../help/site/remote-gateways.md), which the dashboard shows too: provisioning
(§2), the two addresses (§7), adding devices (§10), proposing a flow (§11) and troubleshooting
(§13). Each section keeps its number on both pages.

---

## 1. What the design is protecting against

Every decision on this page follows from one constraint:
**the bundle travels through untrusted places.** It goes into a downloads folder, onto a USB stick,
probably through a chat message, and it stays on a laptop afterwards. So it must not contain
anything worth stealing.

The bundle therefore carries a **claim, not a credential**:

| | In the bundle | Obtained by the appliance |
| :--- | :--- | :--- |
| Broker password | ✗ never | ✓ at first boot, from `enroll-gateway` |
| Enrolment token | ✓ single-use, 30-minute default | — |
| Broker CA | ✗ | ✓ at first boot, with the credential |
| Editor password | ✗ | ✓ generated on the appliance, printed once |

The token is single-use and bound to one gateway. Once redeemed it does nothing, so a copy of the
bundle left on a laptop grants nothing. That is the point of using a token: a broker password in
that file could never be revoked.

---

## 3. What is in the bundle

```
aber-gateway-<name>-<sparkplug_id>/
├── .env                  generated per gateway — the only file that differs between bundles
├── GATEWAY.txt           which gateway this is, and the two commands. Self-identifying on a USB stick
├── platform-root.pem     the root that issued the platform's certificate; empty only with ingress TLS off
├── docker-compose.yml     bootstrap (one-shot) + node-red + flow-sync + node-exporter
├── Dockerfile             thin layer on a pinned nodered/node-red
├── bootstrap.mjs          first-boot provisioning
├── flow-sync.mjs          converges the flow to what was approved in the forge
├── flows.template.json    the sample flow, with placeholders
└── README.md              the appliance-side copy of this procedure
```

Everything except `.env`, `GATEWAY.txt` and `platform-root.pem` is copied unchanged from
[`forge/gateway-platform/appliance/`](../forge/gateway-platform/appliance/).

**`platform-root.pem` is what `bootstrap` trusts for its first call.** That call is HTTPS to Aber's
public URL, made from inside the container. The container trusts the roots bundled with Node, not
the host's store. So a certificate from an internal CA fails there, even on a host that trusts it.
The compose file points `NODE_EXTRA_CA_CERTS` at this file. `gateway-bundle` fills it from the same
root the install command pins (`ABER_CA_PEM`). It is empty only on a deployment without ingress TLS,
where an empty file adds nothing and logs nothing.

**Nothing is minted without a root to hand over.** On an HTTPS deployment, `gateway-bundle` answers
`503` for the bundle and the command alike, and mints no token, when:

* cert-manager has not yet issued the ingress certificate; or
* the certificate's Secret carries no `ca.crt`, because the internal CA did not issue it.

Either way, an appliance could not verify Aber. Once the internal CA has issued the certificate,
the functions read the root from their mount on the next request, with no restart.

`.env` carries exactly six values, all read by `bootstrap.mjs`:

| Key | Purpose |
| :--- | :--- |
| `ABER_SUPABASE_URL` | Aber's address, as reachable **from the appliance** |
| `ABER_SUPABASE_PUBLISHABLE_KEY` | gets the request past the gateway's key check; public by design |
| `ABER_ENROLLMENT_TOKEN` | the single-use claim |
| `NODERED_CREDENTIAL_SECRET` | encrypts `flows_cred.json` on the appliance; **generated per bundle** |
| `ABER_AGENT_VERSION` | recorded on the gateway, so you can see which version each appliance runs |
| `ABER_GATEWAY_NAME` | display name only |

`NODERED_CREDENTIAL_SECRET` is per bundle for a reason. With a shared value, one appliance's
credential file could be decrypted with another's `.env`.

---

## 4. Why the image is built on the appliance

`docker compose up --build` builds the image on the appliance, which takes about a minute on a Pi.
That is deliberate:

* The plant never needs to reach `ghcr.io`.
* An **arm64** appliance builds the same `Dockerfile` unchanged. Aber's published images are
  `linux/amd64` only, so a pulled image would not run on a Pi at all.

The base tag is pinned to the tag Aber's own Node-RED uses. The generated `settings.js` relies on
Node-RED internals that can change between releases. An appliance is the worst place to find that
out, because it is the hardest machine in the deployment to get a shell on.

---

## 5. The enrolment lifecycle

```
   operator saves a Remote gateway
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

The last step needs no code. The ingestion daemon writes `status` on every node-level message, so
the first heartbeat clears the waiting state.

**Neither pending state counts as a fault.** They do not turn a cell amber on the Cells page, and
the Site Map counts them separately from *offline*. A gateway waiting for somebody to carry a bundle
to a machine is an unfinished task, not a broken one. Flagging it as broken would make the warning
useless on the day a few appliances are ordered.

### What `enroll-gateway` does, in order

1. **Claims the token atomically.** If two appliances race for one token, exactly one wins. This
   matters because the broker ACL ties the topic's edge-node segment to the connecting username.
   Two credentials for one gateway would silently compete for a single Sparkplug identity.
2. **Issues the broker credential** through the credential service beside the broker.
3. **Marks the gateway `AWAITING_BIRTH`.**

If step 2 fails, the claim is **released** and the response is `503` with `retryable: true`. The
same bundle then works again, so a broker restart during commissioning costs a retry, not a new
bundle for every appliance. `bootstrap.mjs` retries this case by itself, six times over about two
minutes.

---

## 6. Re-issuing, and what it invalidates

Only **one bundle works at a time**. Issuing a new one consumes any live token for that gateway, so:

> Every re-issue **invalidates the bundle you already have.** Delete the old folder. Otherwise you
> will one day boot the wrong one, and get a `401` that cannot tell you which bundle was stale.

### Which is why it asks

Except straight after you create the gateway, the modal always stops and makes you **type the
gateway's name** before it mints. This is not ceremony. The loss is invisible from the dashboard:
the bundle stays on the operator's laptop, and the folder still unpacks. The failure only shows
minutes later, at an appliance that cannot say what went wrong. A permission check would not help,
because `gateway:manage` **is** the authority to issue bundles. Narrowing the role would only decide
who gets to make the mistake.

The name is matched loosely: trimmed, case-folded, with inner whitespace collapsed. The check is
there to stop an accidental click, not a determined typist.

**Cancel** puts you back on the bundle you already had, rather than closing over it. A failed issue
does the same and leaves the previous bundle live: nothing was minted, so nothing was consumed.

Re-issue when:

* the token expired before the appliance was started (the modal counts down and says so);
* the appliance was replaced, or its volume was destroyed;
* a gateway stays in `AWAITING_BIRTH` and never publishes. The modal names this case, because
  re-issuing there also revokes the broker credential its appliance already holds.

The drawer's **Set Up Gateway** and **Re-issue Setup** actions are deliberately absent once a gateway
is `ONLINE`. Re-issuing then
would invalidate the credential a working appliance is using: a destructive action dressed up as a
convenience. To rotate a live gateway's credential, run
`node scripts/mosquitto-provision-gateway.mjs <sparkplug_id>`, or re-enrol on purpose.

### A rebuilt appliance is a re-issue, and keeps its repository

For a dead SD card, a replaced box or a destroyed volume: re-issue, install, and the gateway carries
on under the same identity. **Nothing about the repository changes and there is no cleanup step.**

* **The repository is the same one.** Enrolment adopts the repository that already exists under the
  gateway's name, rather than creating a second. The flow, `platform.yml`, the incident template and
  every pull request that ever ran through it stay where they were.
* **The new key replaces the old, on both repositories.** Like every appliance, the rebuilt one
  generates its own keypair. `ensureOnlyDeployKey()` removes every other key from the gateway's
  repository. `ensureDeployKey()` removes the replaced key of the same title from the platform
  repository. If the old appliance is ever powered on again, it can open neither.
* **The `appliance` branch resumes rather than restarting.** `flow-sync` fetches
  `origin/appliance` and resets to its head before it writes. So the branch stays one continuous
  record across the rebuild.

**What the branch shows for the gap** is the interval between its last two commits. Those are the
last report from the old appliance and the first from the new one. The rebuild itself shows as the
`deployed.json` commit carrying `"source": "enrolment"`. `bootstrap.mjs` writes that at enrolment
and `flow-sync` never does, so it appears only when an appliance is new or rebuilt. There is no
record of *why* the gap happened, and there should not be. That belongs in the repository's wiki or
an issue, which is what they are for.

### A refused enrolment cannot tell you why

`401` covers unknown, expired **and** already-redeemed tokens, on purpose. Telling them apart would
let someone learn which token values ever existed. So the dashboard's countdown is the only place
you can see the expiry while you still know which bundle is which.

---

## 8. Certificates, and the two clocks they run on

Two certificates matter here: the root and the leaf. They have nothing in common but a name, and
only one of them is your problem.
**Almost every question about certificates here answers itself once the two are separated.**

| | **The root (CA)** | **The leaf** |
| :--- | :--- | :--- |
| What it is | the trust anchor every appliance holds | the certificate the broker presents on 8883 |
| Lifetime | **10 years** (`duration: 87600h`) | **90 days** (`duration: 2160h`) |
| Renewed | a year early (`renewBefore: 8760h`) | 30 days early (`renewBefore: 720h`) |
| Who holds a copy | every gateway, every browser, and three in-cluster clients | only the broker |
| How it is distributed | at enrolment, then from `trust/` on the platform repository | it is not distributed at all |
| Automated? | yes, on appliances at a tag that carries the mechanism | completely |

**You distribute the root and you rotate the leaf, and that asymmetry is the entire reason a
certificate hierarchy exists.** A gateway never checks the leaf against a copy it holds. It checks
that the root it already trusts signed the leaf. So the certificate that changes four times a year
never has to travel, and the one that has to travel changes once a decade.

### What already happens without you

The leaf renews on its own. cert-manager re-issues it at `renewBefore`, and the certificate-reload
sidecar sends the broker a `SIGHUP`. Mosquitto then re-reads the certificate **in place without
dropping a connected gateway**. No appliance notices, nothing is redistributed, and there is nothing
to do.

### What the fleet tells you, and why it is the right question

Every appliance reports the expiry of **the certificate it is actually holding**. It is captured at
enrolment and published on the heartbeat:

* the **Gateways page** shows `CA Expires`, in red inside the warning window;
* `gateway_health.cert_expires_in_days` backs both the fleet dashboard and the
  **Gateway CA Expiring** alert. The alert fires per gateway at **30 days**, and keeps firing once
  the number goes negative.

A check against the broker's own certificate would tell you what the **server** presents. This tells
you what each **client** will accept. The fleet-wide outage happens on the day those two stop
agreeing, so this is the one worth alerting on.

**The reported date follows the file.** `bootstrap.mjs` writes `/data/certs/ca.json` beside the root
at enrolment. `aber-gateway-converge` rewrites both whenever Aber publishes a root this appliance does
not already hold. The flow reads that file every minute. So the date on the page belongs to the root
the appliance holds now, not the one it was first given.

**The Gateways page says who is behind.** The drawer's `CA Expires` row reads *holds an older root*
when the appliance's reported expiry is more than a day earlier than the root Aber publishes. Step 3
below waits on that signal.

### How the root reaches an appliance

`forge-sweep` reads the root the broker is presenting, from the credential service. That service sits
beside the broker, and is the one component that can read the file the broker actually loads. The
sweep writes `trust/ca-bundle.pem` and `trust/manifest.json` onto **`main`** of the platform
repository. Within fifteen minutes of a re-issue, that is what `main` holds.

**On `main`, not in the tag.** Everything else an appliance reads from that repository comes from the
tag its own `platform.yml` names. So a fleet spread across three platform versions reads three
different trees. A re-issued root has to reach all of them, including the appliances nobody is
upgrading. The published tree neither ships `trust/` nor deletes it.

**The bundle is a union, not a replacement.** This CA bundle carries the current root plus every
earlier published root that has not yet expired, so a broker presenting either verifies. That is
what makes steps 3 and 4 below independent of each other.

**The appliance refuses a bundle that would cut it off.** On each hourly pass, the converge script
fetches the bundle. It offers each root in it to the live broker with
`openssl s_client -verify_return_error`, and installs nothing unless one of them verifies. Then it
writes `/data/certs/ca.crt` and `ca.json`, and restarts Node-RED. It restarts once, and only when
the bytes changed; the MQTT session drops for a few seconds. The restart is what makes the new root
take effect. Node-RED's `tls-config` node reads the file when it is created, so a running container
keeps the bytes it read at start. A refused bundle is recorded in `converged.json` on the appliance
branch, and the appliance keeps the root it has.

The bundle does **not** update the operating system's own trust store. Nothing on the appliance makes
an HTTPS call after enrolment. Re-running the install command re-fetches the root by pin, over the
trusted channel.

### Rotating the root, in the order that matters

Follow these steps in order. **The overlap is the whole design; there is never a moment when one
answer is the only correct one.**

1. **Re-issue the root.** cert-manager does this on its own a year before expiry, keeping the same
   private key. A compromised key means a new key. That also changes the pin the dashboard mints
   into the install command, so re-issue the bundles for any appliance you have not yet enrolled.
2. **The sweep publishes it, within fifteen minutes.** Nothing to do. `trust/ca-bundle.pem` on
   `main` now carries both roots.
3. **Wait until no gateway *holds an older root*.** Each appliance installs the new root at its next
   hourly convergence. Do not assume a distribution step reached every machine. An appliance that
   was powered off has not converged, and the page says so.
4. **Only now switch the broker's leaf** to be issued by the new root.
5. **Nothing to remove.** The old root leaves the bundle on the first sweep after it expires.

Doing 4 before 3 is a flag day, where every appliance must switch at once, and a flag day is the
fleet going dark. Re-minting the root does not fail loudly. It succeeds, and every gateway in the
plant drops off together. That looks exactly like a broker outage, and gets diagnosed as one.

**An appliance that was off across the rotation recovers by itself, and takes up to an hour.** It
comes back holding only the old root. If step 4 has already happened, its broker connection fails.
The way back does not go through the broker. The appliance reaches the forge over SSH on a pinned
host key, which a root re-issue does not touch. So the next convergence fetches the bundle, installs
it and restarts Node-RED. Until that pass, the page shows it OFFLINE for the ordinary reason.

**What that path needs is the forge.** An appliance that can reach neither the broker nor the forge
needs a person to visit it. That happens when a site is cut off, a repository archived or a deploy
key revoked. Re-running the install command is how to recover it. This is also why step 3 waits.
Finding out beforehand that four appliances have not converged is much cheaper than finding out
afterwards.

> **A note on why this is gentler than it looks.** `internal-ca.yaml` sets `rotationPolicy: Never`.
> So when cert-manager re-issues the root, it keeps the **same private key**. A chain signed by the
> re-issued root still verifies against the old copy in an appliance's trust store. Verification
> matches on subject and public key, and neither changed. The appliance keeps working until *its own
> copy* expires, which is what the year of `renewBefore` is there to cover. Confirm this against
> your own fleet before relying on it.

### The clock is part of certificate verification

**A certificate is only valid between two dates, so an appliance with a wrong clock cannot verify
anything.** Check the clock first when verification fails for no visible reason:

```bash
timedatectl                       # "System clock synchronized: yes" is the line that matters
openssl s_client -connect <broker>:8883 -showcerts </dev/null | openssl x509 -noout -dates
```

A fresh Ubuntu install whose NTP is blocked by the plant firewall can drift far enough to reject a
perfectly good certificate. This is common, and blocking outside traffic is the whole point of an
air-gapped network. It shows up as a TLS failure at enrolment, or as MQTTS that works in the
workshop and not on the line.

If the plant blocks public NTP, it needs an internal time source, and the appliances need pointing
at it. That is a conversation with whoever runs the network. Have it before commissioning rather
than during.

**And the wrong clock that does not fail is the one to worry about.** A clock out by months breaks
TLS and stops the appliance dead, in front of whoever is holding it. A clock out by *minutes*
verifies every certificate, connects and authenticates. Then it files every reading at a time that
never happened, because devices supply their own metric timestamps and Aber trusts them for
ordering. Nothing about that appliance looks wrong: it is ONLINE, it drops nothing, and every number
it reports is plausible.

Aber measures this without the appliance doing anything. It compares the timestamp on each heartbeat
with the time the heartbeat arrived:

* **Clock offset** on the gateway fleet-health dashboard, **positive meaning the appliance is
  ahead**, which is the direction that corrupts data;
* the **Gateway Clock Skew** alert, at a minute of drift sustained for fifteen;
* past **+5 minutes**, the telemetry is not written at all. It is refused rather than clamped, and
  counted per gateway by `aber_ingestion_timestamps_rejected_total{edge_node, reason="too_new"}`.
  The backward tolerance is a full day for a live reading, and seven days for one an appliance
  replays after an outage ([late data after an outage](../help/site/remote-gateways.md#late-data-after-an-outage)).

**Nothing on the platform corrects it, deliberately.** Rewriting a device's timestamps centrally would
swap a visible clock fault for an invisible one. It would also destroy the only evidence that the
appliance is wrong. The fix is always time synchronisation on the appliance.

#### Four questions about the clock, answered

**Should an appliance with a bad clock publish at all?** Yes, and Aber decides what to keep. The
appliance does not gate itself, because a gate on the box would have to trust the clock it doubts.
An appliance that stopped publishing on its own suspicion would take itself off the air for the one
fault it cannot measure. Aber keeps what is inside the window and refuses what is outside it. It
counts the refusals per gateway, and alerts at a minute of drift, long before either. So: fail-open
inside five minutes, fail-closed outside, and that stays as it is.

**Is the platform a time source?** No, and it should not become one. A plant with no route to public
NTP names its own server in `platform.yml`'s `chrony_servers`, and the playbook points every
appliance at it. That is a per-gateway setting, changed by pull request like any other. A chrony pod
on Aber would mean UDP 123 through a LoadBalancer. It would also be one more thing every appliance in
the plant depends on Aber for. That makes it a feature request with a real case behind it, not a
default.

**Is an RTC module required?** It is recommended for single-board appliances, not required. Without
one, and without NTP at boot, the clock starts in the past and TLS fails until a time source appears.
The appliance is then dead in a way that is obvious to whoever is holding it, which is the failure to
prefer. `timedatectl` above finds it in one line. Ubuntu's chrony jumps the clock straight to the
right time (`makestep`) rather than slewing it gradually. So the appliance recovers on its own once a
source is reachable.

**Is `TELEMETRY_MAX_FUTURE_SECONDS` right at five minutes?** Yes, on the measurement. The Gateway
Clock Skew alert fires at one minute sustained for fifteen. That gives four minutes of warning before
anything is refused, on a drift that takes hours to build up. Nothing measured on the development
fleet has come near it. Lowering it would trade that warning for refusals. Raising it would widen the
window in which a plausible-looking wrong time is written.

### There is no revocation list, and that is a decision

Nothing in Aber publishes a certificate revocation list (CRL) or answers OCSP, and no client here
checks for one. For a fleet of this size that is the right trade. Revocation infrastructure is a
service in its own right, to run, keep available and distribute. But it has a consequence worth
stating plainly:

**If the root's private key were ever exposed, the only remedy is to mint a new root and repeat the
distribution above for the entire fleet.** There is no faster path. That stays acceptable because the
key never leaves cert-manager's `aber-ca-key-pair` Secret. It is never mounted into an application
pod, and never copied to an appliance: appliances receive `ca.crt` and only `ca.crt`. Treat that
Secret as the most sensitive object in the deployment, because it is the one thing here that cannot
be revoked.

Broker **credentials** are different: they can be revoked immediately (see below).

### An appliance that is lost, stolen or scrapped

**Archiving the gateway is the revocation.** It disables the broker account: the appliance's live
session is dropped at once, and its next connection is refused. Do it the moment hardware goes
missing, not as part of a later tidy-up. The Access Control page shows the account as *Disabled*
once the change has landed.

The broker password is on the appliance in plaintext, in `/data/gateway.env`. That is unavoidable,
since something has to connect. The damage is deliberately limited: the gateway's broker role
confines it to its own edge node. A stolen appliance can publish as **itself** and as nothing else.
It cannot forge another gateway's telemetry, and it cannot read the fleet's.

**Archiving takes the forge too.** The same action removes the appliance's deploy key, so the box can
no longer clone its repository or push to its `appliance` branch. It also puts that repository into
the forge's archive: read-only, badged as archived, with every branch, issue and wiki page kept.
`forge-sweep` does both. Archiving calls it at once, and it retries every fifteen minutes, so an
archive taken while the forge is down still lands. The repository itself is never deleted. Its
wiki is where what you know about that gateway is written down, and deleting it is a decision you
take in the forge. Restoring the gateway reverses both.

Archiving does **not** retrieve the CA copy on that appliance. That certificate is public by nature,
and worth nothing to whoever has the box.

---

## 9. The editor login is local, and why

The appliance's Node-RED uses a **local bcrypt account**, not Supabase SSO. That is a deliberate
difference from Aber's own Node-RED:

* OAuth requires the authorisation server to hold an **exact** `redirect_uri` for each client, and an
  appliance on DHCP has no stable URL. Every shopfloor subnet would fail with `invalid redirect_uri`.
* SSO needs a route to Aber, so the editor would be unreachable exactly when the link is down. That
  is when somebody is standing in front of the box wanting to look at it.

The trade-off is that the password is per appliance and cannot be revoked centrally. So it is
**generated** (never defaulted), shown once, and re-issued rather than recovered. To re-issue it:

```bash
docker compose run --rm bootstrap /bundle/bootstrap.mjs --reset-admin-password
```

The **data path is unaffected.** Editor login is for people. Telemetry authenticates to Mosquitto
with the enrolled `sparkplug_id` over MQTTS. The two kinds of authentication are independent, which is
what makes the local account safe.

---

## 12. The operating system, and the platform playbook

The bundle covers what runs *in* Docker. What runs *under* it is the **platform playbook**, an Ansible
playbook. It covers the packages, the upgrade policy, the clock, Docker itself, and the timer that
keeps all of that converged. It lives in [`forge/gateway-platform/`](../forge/gateway-platform).
It is published into the forge as `platform/gateway-platform`, and tagged `v<version>` once per
platform version.

**The fleet tracks a tag, and the pointer is per gateway.** At enrolment, `platform.yml` on the
gateway's `main` is seeded with the tag current at that moment. Changing it is a pull request in the
gateway's own repository. So a fleet upgrade is one pull request per gateway or a scripted batch, and
a canary is one gateway. Nothing tracks `main` of the platform repository. Only Aber's machine account
can push to `main` there: the playbook is changed in Aber's own repository and reviewed there.

**`ansible-pull`, not Ansible.** The appliance applies the playbook to itself; nothing pushes to
it. It runs `aber-gateway-converge` hourly and after boot, which:

1. reads the tag from the puller's checkout of the gateway's `main`;
2. runs `ansible-pull` against the platform repository at that tag, over SSH. It uses the same
   deploy key and the same pinned host key as the puller. The key is read-only there: it was
   measured to be refused when it pushes;
3. records the outcome in `/data/gitops/converged.json`, which the puller adds to the `appliance`
   branch.

It is outbound only, needs no inventory, heals itself on a timer, and is idempotent by construction.

**What it decides** is in the playbook's README:

* Ubuntu and Ubuntu Server, amd64 and arm64;
* `unattended-upgrades` without automatic reboot, with Docker's packages held out of it;
* Docker from Ubuntu's own archive;
* `chrony` pointed at what `platform.yml` names (`vars.chrony_servers`), or Ubuntu's pool;
* the compose volume bound to `/var/lib/aber-gateway/data`, so the host's converge script can reach
  what `bootstrap.mjs` wrote inside the container.

**The first run is a person's**, or the installer's if the appliance was set up with the command
(§2). The playbook installs the timer that runs it afterwards. To run it by hand:

```bash
sudo apt-get install -y ansible-core
sudo ansible-pull -U ssh://git@<forge>:<port>/platform/gateway-platform.git -C v<version> \
  -i localhost, site.yml
```

`<forge>:<port>` is the address in `platform_ssh_url`, in
`/var/lib/aber-gateway/data/gitops/repository.json`. That expects an enrolled `/data` under `/var/lib/aber-gateway/data`, and the bundle's `.env` at
`/opt/aber-gateway/.env`. Without the `.env`, the playbook sets up the host and reports that the
compose project was not started.

### A playbook of the gateway's own

A gateway whose repository has a **`custom.yml`** at its root runs that playbook too. It runs from
the same checkout, straight after the platform playbook. Every gateway runs the platform playbook;
this is an addition to it, never an alternative. It arrives the way a flow does: a pull request on
`main` that an administrator approves. Use it to install a bespoke adapter for legacy machinery.

It is given that gateway's `platform.yml` variables first, then the paths Aber owns (`aber_state_dir`,
`aber_data_dir`, `aber_compose_dir`, `aber_repo_dir`, `aber_platform_tag`). So it can find what Aber
put where, and cannot move it.

**A broken one is never mistaken for a broken platform.** Its outcome is a separate field in
`converged.json`, which the puller pushes to the `appliance` branch. It is not attempted at all when
the platform run failed. It does fail the convergence's exit status, so
`systemctl status aber-gateway-converge` and the unit's journal show it on the appliance:

```bash
journalctl -u aber-gateway-converge -n 50        # what the last convergence did
jq .custom /var/lib/aber-gateway/data/gitops/converged.json
```

### Two rows in the drawer, and what each is for

The forge reports that push, so the gateway's drawer shows the last convergence without anybody
opening a shell:

| Row | Reads | Means |
| :--- | :--- | :--- |
| **Platform** | `v1.5.0 · converged 40 minutes ago` | the playbook version this appliance is actually on. Different tags across the fleet mean a rollout in progress, which is what the per-gateway pointer is for |
| **Platform** | `v1.5.0 · failed` | `ansible-pull` did not complete. The timer retries within the hour; the appliance's journal says why |
| **Custom** | *(empty)* | this gateway's repository carries no playbook of its own. The ordinary case |
| **Custom** | `converged at a1b2c3d` | its adapter is running, from that commit |
| **Custom** | `failed at a1b2c3d` | its adapter is **not** running |

**A failing adapter turns nothing else amber, and that is the point of the row.** The gateway keeps
publishing its heartbeat and every device behind Node-RED. So it reads ONLINE and its flow is
converged, because it is. The adapter is a container with no heartbeat of its own, and this row is
the only place its absence shows. Check it after any change to a gateway's own playbook.

**A gateway seeded from the example** starts with the adapter's README and compose project already
in its repository. To seed one, use the forge's **Use this template** on
`platform/gateway-custom-example`, before the appliance is commissioned. Enrolment adopts a repository
that already exists, and sets it up the same way as an empty one.

## Related

* [`forge/gateway-platform/appliance/README.md`](../forge/gateway-platform/appliance/README.md) — the copy that
  ships in the bundle
* [`docs/openapi.yaml`](openapi.yaml) — `enroll-gateway` and `gateway-bundle` contracts
* [`deploy/k8s/internal-ca.yaml`](../deploy/k8s/internal-ca.yaml) — the Kubernetes CA
* [`scripts/mosquitto-tls-init.mjs`](../scripts/mosquitto-tls-init.mjs) — the broker CA generator the broker config check builds its TLS fixture with
* [`scripts/mosquitto-provision-gateway.mjs`](../scripts/mosquitto-provision-gateway.mjs) — issuing a
  credential by hand, without the enrolment path

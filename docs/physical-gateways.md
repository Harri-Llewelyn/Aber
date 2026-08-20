# Physical gateways — operator runbook

How a piece of hardware on a shopfloor becomes a gateway this platform trusts, and what to do when
that goes wrong.

A **virtual** gateway is a connector running on the application host: it exists the moment its row
does, and it needs nothing installed. A **physical** gateway runs on its own machine — a Raspberry
Pi, an industrial PC, a spare server in a cabinet — and has to be given an identity, a credential and
a way to verify the broker before it can publish anything. This document is about the second kind.

> **The short version.** Create the gateway in the dashboard with *Virtual* left unchecked, download
> its bundle, copy the folder to the machine, run `docker compose up -d --build`, then
> `docker compose logs bootstrap` to read the editor password. The gateway goes **AWAITING SETUP →
> ENROLLED — NO DATA YET → ONLINE** on its own.

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

1. **Gateways → New Gateway.** Name it after the machine or the cell it serves.
2. **Leave “Mark as Virtual Gateway” unchecked.** The form says which way it is going before you
   save: *“Runs on its own hardware. On save you will be given a bundle to copy to that machine.”*
3. **Save.** The bundle modal opens and **the download starts immediately** — the gateway is
   seconds old, so there is no earlier bundle for this one to invalidate. It is now **AWAITING
   SETUP** (`PENDING_ENROLLMENT`).
4. **Copy the three commands** shown, or use the **Copy Commands** button beside them, and note the
   countdown: the token is good for 30 minutes.

Coming back later — **Gateways → the gateway → Download Setup Bundle** — behaves differently on
purpose. That gateway may already hold a bundle somebody downloaded, so the modal **asks first and
makes you type the gateway's name** before it mints anything. See §6.

Requires **Administrator** or **Shopfloor_Manager** (`gateway:manage`). Operator and Auditor never
see the action, and `gateway-bundle` answers `403` if it is called anyway — no token is minted by
the refusal.

### On the appliance

Copy the whole unpacked folder to the machine, then:

```bash
cd acs-gateway-<name>-<sparkplug_id>
docker compose up -d --build          # ~1 minute; builds on the appliance, see §4
docker compose logs bootstrap         # prints the Node-RED editor password, ONCE
```

Within about a minute the dashboard shows the gateway **ONLINE**.

### Prerequisites on the appliance

* Docker and the Compose plugin.
* A route to the platform's API — the address in `ACS_SUPABASE_URL`, which the server refuses to set
  to anything in-stack (§7).
* A route to the broker on **8883**. Physical gateways use MQTTS exclusively; 1883 stays open for
  in-network services and is not used here.
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
[`templates/physical-gateway/`](../templates/physical-gateway/).

`.env` carries exactly six values, all read by `bootstrap.mjs`:

| Key | Purpose |
| :--- | :--- |
| `ACS_SUPABASE_URL` | the platform, as reachable **from the appliance** |
| `ACS_SUPABASE_ANON_KEY` | gets the request past Kong's `key-auth`; public by construction |
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
counted separately from *offline* on the Overview — a gateway waiting for somebody to carry a bundle
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
`npm run provision:gateways -- --rotate` or re-enrol on purpose.

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
| `MQTT_PUBLIC_HOST` | `enroll-gateway` answers `503` **without consuming the token**. `mosquitto`, `localhost` and `127.0.0.1` are refused. |

`MQTT_PUBLIC_HOST` is also folded into the broker certificate's SAN. Change it and the leaf is
reissued on the next boot of `mosquitto-tls-init` — **the root is untouched, so no appliance has to be
re-enrolled.** A certificate that does not name the address gateways dial fails verification at every
appliance while in-cluster clients verify perfectly, so the stack reports itself healthy and the fleet
is silently off.

---

## 8. The editor login is local, and why

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

## 9. Adding devices — nothing is pre-registered

The sample flow includes an **▶ ADD YOUR OWN DEVICE** inject. Click it and the device publishes a
Sparkplug `DBIRTH`; it then appears in the dashboard's **quarantine queue** as `UNKNOWN_DEVICE`, and
its data is dropped until an operator approves it.

That is the intended path. There is no device registration step and no API to call from the flow — the
gateway announces, the platform quarantines, a human approves.

The broker confines this gateway to `spBv1.0/+/+/<sparkplug_id>/#`. A message published under any
other edge node is dropped **silently, by design** — it is what stops one gateway forging another's
telemetry.

---

## 10. Flow backups

The appliance's flow lives on a Docker volume on hardware in a plant. It is the only copy, and
`docker compose down -v` or a failed SD card takes the plant's edge logic with it.

**Gateways → select the gateway → Flow backups.** Export `flows.json` from the appliance's editor
(*menu → Export → all flows*) and upload it there.

| Role | Backups |
| :--- | :--- |
| Administrator, Shopfloor_Manager | list, download, upload, delete |
| Auditor | list and download only |
| Operator | no access at all |

Stored in the **private** `gateway-backups` bucket under `<sparkplug_id>/`, a prefix enforced by
row-level security rather than by the uploader. Reads go through a 60-second signed URL; there is no
public URL for this bucket and there must never be one.

**`flows_cred.json` is never backed up.** It is encrypted with a secret that exists only in the
appliance's `.env`, so a copy on the platform would be either useless or dangerous. The uploader
rejects it by *shape*, not by filename — both files sit side by side in `/data` and picking the wrong
one is an easy mistake.

---

## 11. Troubleshooting

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
They are in the quarantine queue awaiting approval (§9). That is the design, not a fault.

---

## Related

* [`templates/physical-gateway/README.md`](../templates/physical-gateway/README.md) — the copy that
  ships in the bundle
* [`docs/openapi.yaml`](openapi.yaml) — `enroll-gateway` and `gateway-bundle` contracts
* [`deploy/k8s/internal-ca.yaml`](../deploy/k8s/internal-ca.yaml) — the Kubernetes CA
* [`scripts/mosquitto-tls-init.mjs`](../scripts/mosquitto-tls-init.mjs) — the Compose CA
* [`scripts/mosquitto-provision-gateway.mjs`](../scripts/mosquitto-provision-gateway.mjs) — issuing a
  credential by hand, without the enrolment path

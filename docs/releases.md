# What a release promises

**The question this answers:** *"If we run this, what are we signing up for?"*

[`upgrades.md`](upgrades.md) is the mechanical half — what survives an upgrade, and why nothing
needs reconfiguring. This is the other half: how long a release is looked after, what the version
number tells you, and how you find out that a release matters to you.

**Read the scale of the project into every answer below.** This is maintained by one person. The
commitments here are the ones that can honestly be kept at that size, written down so a site's IT
function can decide with its eyes open rather than inferring an enterprise support desk that does
not exist.

---

## Supported versions

**The latest minor release, and only that.** A fix — functional or security — lands on the next
release of the current minor line. Nothing is backported to an earlier one.

| Version | Supported |
| :--- | :--- |
| Latest minor (e.g. `1.4.x`) | Yes — fixes land here |
| Anything earlier | No — upgrade to the latest minor |

In practice that is a light obligation, because §*Upgrading between releases* below means any 1.x
goes straight to any later 1.x. There is no upgrade ladder to climb before you can take a fix.

**Known, unfixed CVEs in the third-party images are reported monthly** by the container scan
described in [`testing.md`](testing.md#keeping-the-pinned-versions-current), which deliberately reports
only *fixable* HIGH and CRITICAL findings. A finding there is not a release on its own; it becomes
one when there is a version to move to.

---

## What the version number means

The stack is versioned `MAJOR.MINOR.PATCH`, and the parts mean specific things here rather than
generally. **A breaking change is defined in terms this stack actually has**, so the definition can
be checked against a diff rather than argued about.

### Patch — `1.4.0` → `1.4.1`

Fixes. Schema changes that are purely additive and replay safely onto an existing database. No new
values key is required of you; no existing one changes meaning. Upgrading is `helm upgrade` with
the values file you already have.

### Minor — `1.4.x` → `1.5.0`

New capability. New values keys, each with a default that preserves current behaviour. Additive
schema. A capability that a site has to opt into rather than one that changes underneath it. A
minor release is also where a **deprecation** is announced, never where one takes effect.

### Major — `1.x` → `2.0.0`

Anything a running site would notice as a break. Concretely, any of:

- **A migration that is not replay-safe** on an existing database — one that needs a manual step,
  or that can fail against rows a site already holds.
- **A values key removed or renamed** without a default that keeps the old spelling working.
- **A change to an identifier a site already holds.** These are the expensive ones because they
  reach outside this repository: the `sparkplug_id` derivation, the site's Sparkplug group, the
  `aber.local` semantic namespace that AAS exports and i3X type ids are minted into, a
  `metric_catalog` name, or the `aber_ingestion_*` Prometheus metric prefix that every dashboard and
  alert rule queries.
- **A change to the shape of a topic** the platform publishes or consumes.
- **Dropping support for a Kubernetes version** the previous release supported.
- **A change `helm upgrade` cannot carry**, which moves [the floor](upgrades.md#the-floor-100): a
  renamed chart (its name is in every workload's immutable selector), a PostgreSQL major version,
  or a schema older than the migration chain is verified to converge. The release says so under
  *Action required before upgrading* and moves the floor in `upgrades.md` in the same change.

Anything not on that list is not a major change, whatever it looks like in the diff.

---

## Upgrading between releases

**Any 1.x upgrades directly to any later 1.x.** There is no step ladder and no intermediate version
you must pass through. That is a property of how the schema is applied rather than a promise being
made on top of it: `db-init` replays **every** migration in filename order on every boot, with no
applied-migrations ledger, so arriving from `1.0.0` and arriving from `1.3.2` run exactly the same
files. [`upgrades.md`](upgrades.md#the-database-upgrades-itself) has the
mechanism.

**Nothing below 1.0.0 upgrades to it.** 0.1.0 and any install from a checkout before 1.0 reach it
by reinstalling, and no data is carried across; [`upgrades.md`](upgrades.md#the-floor-100) says
why.

**Skipping minors is supported. Rolling back is not.** The images can be rolled back and the schema
cannot — there are no down-migrations. Take a backup before upgrading if a rollback is a real
possibility for you; [`upgrades.md`](upgrades.md#migrations-are-forward-only) says how, and the
Backups page is the way with no shell.

---

## Deprecation

A setting, an identifier or a behaviour that is going away is **announced in the release notes of
the minor that introduces the replacement**, and removed **no sooner than the next minor** — so
there is at least one full minor release in which both work and the notes say so.

Through that window a deprecated values key keeps working and the rendered `NOTES.txt` says it is
deprecated and what replaces it, so an operator who never reads a release note still meets the
warning at `helm upgrade`.

**Removing something without that window makes the release major**, by the definition above. The
deprecation path is what a minor release buys; skipping it does not make the change smaller.

---

## Finding out whether a release matters to you

**Every `v*` tag gets a GitHub Release, and its notes are written for an operator** rather than
assembled from commit subjects. The headings are fixed, so the first question — "do I have to do
anything?" — is answered by the first section or by its absence:

| Heading | What it holds |
| :--- | :--- |
| **Action required before upgrading** | Anything that is not `helm upgrade`. Absent when there is nothing |
| **Deprecated** | What still works, what replaces it, and the release it goes away in |
| **Fixed** | Defects, each naming the symptom a site would have seen |
| **Added** | New capability, and the values key that turns it on |
| **Images and chart** | The published tags, so a pull can be checked against the release |

[`.github/RELEASE_TEMPLATE.md`](../.github/RELEASE_TEMPLATE.md) is that skeleton. The release
workflow opens the release as a draft from it, with `aber-<version>-sbom.tar.gz` attached: every
image's SBOM and provenance, and the digests the signatures are over. The notes are then written by
hand; nothing here is generated from commits.

**Watch the repository's releases** to be told. On GitHub: *Watch → Custom → Releases*. There is no
mailing list and no announcement channel; adding one nobody reads would be worse than saying so.

---

## Security

[`SECURITY.md`](../SECURITY.md) is the reporting route. Its supported-version window is this
document's — the latest minor — and the two are deliberately not invented separately.

**Every release is signed and carries a bill of materials.** Each image and the chart is signed
keyless by the release workflow, bound to `release.yml` at the tag; each image carries an SPDX SBOM
and SLSA provenance in its registry index. That is what lets a site ask, of a release built before
an advisory existed, whether the advisory applies — without pulling the image. What each is and how
to verify it is in [`SECURITY.md`](../SECURITY.md#what-a-release-carries-and-how-to-check-it).

---

## Related

- [`upgrades.md`](upgrades.md) — what survives an upgrade, and the four places that is not the
  whole truth
- [`testing.md`](testing.md#releases) — what the release workflow builds and checks
- [`../deploy/k8s/README.md`](../deploy/k8s/README.md#publishing-a-release) — publishing one
- [`../SECURITY.md`](../SECURITY.md) — reporting a vulnerability

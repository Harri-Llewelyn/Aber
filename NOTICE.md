# Third-party notices

## Scope of the MIT licence

The MIT licence in [`LICENSE`](LICENSE) covers the work in this repository: the Helm chart, the SQL in [`timescaledb/`](timescaledb/) and
[`supabase/migrations/`](supabase/migrations/), the frontend, the ingestion, playback and i3X
services, the Node-RED flows, the Grafana dashboard definitions, the scripts and the documentation.
The two exceptions are [`sparkplug_b.proto`](#sparkplug_bproto--eclipse-public-license-20) and
[the dashboard's fonts](#outfit-and-jetbrains-mono--sil-open-font-license-11), which keep their own
licences.

It does **not** cover the third-party software this configuration deploys. Those images are pulled
from their own registries at deploy time under their own licences. **This repository redistributes
none of them** — it contains instructions to fetch them, which is a materially different act, and
one that leaves each user's relationship with each upstream vendor directly between the two of them.

Licences do not propagate across a process boundary. Every component below runs in its own
container and is reached over a network protocol — the Postgres wire protocol, MQTT, HTTP. Nothing
here is linked into, statically or dynamically, and nothing here is a derivative work of, any of
them. The MIT grant over this repository's own contents is unaffected by anything in this file.

## `sparkplug_b.proto` — Eclipse Public License 2.0

One of the two third-party pieces in this repository. It is Eclipse Tahu's Sparkplug B payload definition,
copyright Cirrus Link Solutions and others, under EPL-2.0, and its licence header is kept intact.
The MIT licence above does not cover it. It differs from the current Tahu file only in its
compile-instructions comment, which adds the Python command.

The ingestion and i3X images compile it with `protoc` at build time, so both carry code generated
from it; this file, in this repository, is its source. Upstream:
[`github.com/eclipse-tahu/tahu`](https://github.com/eclipse-tahu/tahu), `sparkplug_b/sparkplug_b.proto`.

## Outfit and JetBrains Mono — SIL Open Font License 1.1

The dashboard's two typefaces. Their woff2 files are in
[`frontend/src/assets/fonts/`](frontend/src/assets/fonts/), and the frontend image serves them, so
both the repository and the image redistribute them.

| Font | Copyright | Licence text |
| :--- | :--- | :--- |
| Outfit | 2021 The Outfit Project Authors ([`github.com/Outfitio/Outfit-Fonts`](https://github.com/Outfitio/Outfit-Fonts)) | [`outfit-OFL.txt`](frontend/src/assets/fonts/outfit-OFL.txt) |
| JetBrains Mono | 2020 The JetBrains Mono Project Authors ([`github.com/JetBrains/JetBrainsMono`](https://github.com/JetBrains/JetBrainsMono)) | [`jetbrains-mono-OFL.txt`](frontend/src/assets/fonts/jetbrains-mono-OFL.txt) |

They are Fontsource's variable-weight builds of the latin and latin-ext subsets, copied byte for
byte. Each file carries its copyright and the licence's URL in its own metadata. The fonts' folder has a
README naming where each file came from.

## TimescaleDB — Timescale License

`timescale/timescaledb:2.29.2-pg17` is dual-licensed in a single upstream repository: the core under
Apache 2.0, and the features under `tsl/` under the Timescale License, which is source-available
rather than OSI-approved open source.

**This deployment runs under the Timescale License.** That is not an inference — the running server
reports it:

```
SHOW timescaledb.license  →  timescale
```

This is deliberate and it is not avoidable here. Compression, continuous aggregates, retention
policies and `time_bucket_gapfill`/`locf` are all Timescale-Licensed features, and all four are
load-bearing:

| Feature | Where |
| :--- | :--- |
| Columnar compression, `add_compression_policy` | [`timescaledb/retention.sql`](timescaledb/retention.sql) |
| Continuous aggregates, `add_continuous_aggregate_policy` | [`timescaledb/aggregates.sql`](timescaledb/aggregates.sql) |
| `add_retention_policy` | [`timescaledb/retention.sql`](timescaledb/retention.sql), [`aggregates.sql`](timescaledb/aggregates.sql) |
| `time_bucket_gapfill`, `locf` | [`timescaledb/aggregates.sql`](timescaledb/aggregates.sql) |

An Apache-only build of TimescaleDB (`timescaledb-apache`, or this extension with
`timescaledb.license = apache`) will not run this schema. Swapping the storage engine for a
permissively-licensed alternative is a rewrite of the rollup and retention machinery, not a
configuration change.

**What the Timescale License permits**, in outline: internal use, commercial use, modification, and
redistribution with the notices intact. Its principal restriction is on offering the software to
third parties as a hosted database service.

> **If you intend to operate this stack as a multi-tenant or hosted service, read the Timescale
> License yourself and take your own advice.** That use sits in the area the licence exists to
> restrict, and nothing in this file is a substitute for reading it or for professional advice.

For the ordinary case — running this at your own site, for your own operations, commercially or
not — the restriction does not engage.

Licence text: [`github.com/timescale/timescaledb`](https://github.com/timescale/timescaledb),
files `LICENSE` and `tsl/LICENSE-TIMESCALE`. Cite the repository rather than the image: **the
published Docker image ships no licence file at all** (a full-filesystem search of
`timescale/timescaledb:2.29.2-pg17` finds only Python's). That is an upstream omission, and it is a
further reason not to republish that image yourself.

## Grafana — AGPL-3.0

`grafana/grafana:13.2.3` is licensed AGPL-3.0, confirmed from `/usr/share/grafana/LICENSE` in the
pinned image. This is the most restrictive licence in the stack — more so than TimescaleDB's, which
is worth stating plainly because it is the opposite of the usual assumption.

The dashboard JSON in [`grafana/provisioning/`](grafana/provisioning/) is original work under this
repository's MIT licence. It is configuration consumed by Grafana, not a derivative of Grafana's
source. Deploying an unmodified Grafana alongside this stack does not engage the AGPL's obligations;
**modifying Grafana itself and offering it over a network would**, including its network clause.

## Other components

Container images generally do not ship their application's licence text, so the table below
distinguishes what was verified from the pinned images from what was not. **The unverified rows are
listed for orientation and are not warranties** — confirm against the upstream project before
relying on any of them.

### Verified from the pinned image

| Component | Licence | Evidence |
| :--- | :--- | :--- |
| `timescale/timescaledb:2.29.2-pg17` | Timescale License (core Apache 2.0) | `SHOW timescaledb.license` → `timescale` |
| pgBackRest 2.57.0, added to that image as `ghcr.io/harri-llewelyn/aber/timescaledb` (`timescaledb/Dockerfile`) | MIT | `apk info -a pgbackrest` → `license: MIT` |
| `grafana/grafana:13.2.3` | AGPL-3.0 | `/usr/share/grafana/LICENSE` |
| `prom/prometheus:v3.15.0` | Apache 2.0 | `/LICENSE` |
| `eclipse-mosquitto:2.0.22` | EPL-2.0 / EDL-1.0 | `/usr/share/licenses/mosquitto/` |

### Not verified from the image — consult upstream

These images ship no application licence file, or no shell to inspect one with. Consult each
project's own repository.

| Component | Project |
| :--- | :--- |
| `supabase/postgres:17.6.1.175` | PostgreSQL and its extensions, packaged by Supabase |
| `postgrest/postgrest:v14.17` | PostgREST |
| `supabase/gotrue:v2.197.0` | Supabase Auth |
| `supabase/realtime:v2.134.10` | Supabase Realtime |
| `supabase/storage-api:v1.74.0` | Supabase Storage |
| `supabase/edge-runtime:v1.77.0` | Supabase Edge Runtime |
| `supabase/postgres-meta:v0.99.0` | Supabase postgres-meta |
| `supabase/studio:2026.09.28-sha-5e59b60` | Supabase Studio |
| `envoyproxy/envoy:v1.39.2` | Envoy Proxy |
| `swaggerapi/swagger-ui:v5.33.0` | Swagger UI |
| `node:24-alpine`, `alpine:3.24` | Node.js, Alpine Linux and their packages |

## Standards and vocabularies

Adopting a standard's vocabulary is not a compliance claim. Locally-minted semantic ids live under
`https://aber.local/semantics/…` precisely so that no identifier asserts an interoperability
that has not been certified. The MTConnect Implementer License, and the equivalent programmes for
the other bodies, are separate from anything granted here. See
[`docs/vocabularies.md`](docs/vocabularies.md).

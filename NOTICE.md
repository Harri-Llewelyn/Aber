# Third-party notices

## Scope of the MIT licence

The MIT licence in [`LICENSE`](LICENSE) covers the work in this repository: the Helm chart, the SQL in [`timescaledb/`](timescaledb/) and
[`supabase/migrations/`](supabase/migrations/), the frontend, the ingestion, playback and i3X
services, the Node-RED flows, the Grafana dashboard definitions, the scripts and the documentation.
The four exceptions are [`sparkplug_b.proto`](#sparkplug_bproto--eclipse-public-license-20),
[the dashboard's fonts](#outfit-and-jetbrains-mono--sil-open-font-license-11),
[the icon glyphs it copies](#the-dashboards-icons--lucide-isc-and-feather-mit) and
[the ASHRAE 223P ontology](#the-ashrae-223p-ontology--apache-license-20), which keep their own
licences. The licence texts in [`licenses/`](licenses/) are copied verbatim from the projects they
belong to. The two written offers of source there (`SOURCE`) are Aber's own.

It does **not** cover the third-party software Aber runs, which is under its own licences. What
happens to that software differs between the repository and a release:

- **The repository redistributes none of it.** It contains instructions to fetch each image from
  its own registry at deploy time. That is a materially different act, and one that leaves each
  user's relationship with each upstream vendor directly between the two of them.
- **A release does redistribute.** It publishes twelve images under `ghcr.io/harri-llewelyn/aber/`,
  and every one is built on an upstream image. Publishing one passes on the upstream software inside
  it, so that software's licence texts travel with it.
  [The images a release publishes](#the-images-a-release-publishes) names each one's base and where
  the texts are.

Licences do not propagate across a process boundary. Every component below runs in its own
container and is reached over a network protocol — the Postgres wire protocol, MQTT, HTTP. In a
published image, Aber's files sit beside the upstream software on one filesystem without being
linked into it. Nothing here is linked into, statically or dynamically, and nothing here is a
derivative work of, any of them. The MIT grant over this repository's own contents is unaffected by
anything in this file.

## The images a release publishes

[`.github/workflows/release.yml`](.github/workflows/release.yml) publishes these with every release.
Where a base does not carry its licence text, the Dockerfile adds it from [`licenses/`](licenses/),
which pins each file by SHA-256 ([`licenses/README.md`](licenses/README.md)). A build never fetches
one.

| Published image | Built on | Licence of the base | The licence text in the published image |
| :--- | :--- | :--- | :--- |
| `aber/timescaledb` | `timescale/timescaledb:2.29.2-pg17` | [Timescale License, core Apache 2.0](#timescaledb--timescale-license); PostgreSQL License | **Added:** `/usr/share/licenses/timescaledb/` (`LICENSE`, `LICENSE-APACHE`, `NOTICE`, `LICENSE-TIMESCALE`) and `/usr/share/licenses/postgresql/COPYRIGHT` |
| `aber/supabase-db`, `aber/db-init`, `aber/backup-service` | `supabase/postgres:17.6.1.175` | PostgreSQL License; [its extensions](#the-extensions-in-supabasepostgres) their own, two of them GPL | **Added:** `/usr/share/licenses/supabase-postgres/LICENSE`, `/usr/share/licenses/postgresql/COPYRIGHT`, the GPL under `/usr/share/licenses/postgis/` and `/usr/share/licenses/pgrouting/` with a written offer of their source (`SOURCE`), and the licences of the copyleft libraries only PostGIS loads under `/usr/share/licenses/geos/`, `sfcgal/`, `cgal/`, `gmp/`, `mpfr/`, `libidn2/` and `libunistring/` |
| `aber/edge-runtime` | `supabase/edge-runtime:v1.77.0`, with a module cache resolved by `denoland/deno:2.1.4` | MIT | **Added:** `/usr/share/licenses/edge-runtime/LICENSE` |
| `aber/swagger-ui` | `swaggerapi/swagger-ui:v5.33.0` | Apache 2.0; nginx BSD-2-Clause | **Added:** `/usr/share/licenses/swagger-ui/` (`LICENSE`, `NOTICE`). nginx's is the base's `/usr/share/licenses/nginx/COPYRIGHT` |
| `aber/node-red` | `nodered/node-red:5.0.7` | Apache 2.0; Node.js MIT | In the base: `/usr/src/node-red/node_modules/node-red/LICENSE` and Node.js's `/usr/local/LICENSE` |
| `aber/gateway-credential` | `eclipse-mosquitto:2.1.2-alpine` | EPL-2.0 or EDL-1.0 | In the base: `/usr/share/licenses/mosquitto/` (`epl-v20`, `edl-v10`) |
| `aber/frontend` | `nginx:alpine`, with the bundle built by `node:24-alpine` | BSD-2-Clause | In the base: `/usr/share/licenses/nginx/COPYRIGHT`. [The fonts](#outfit-and-jetbrains-mono--sil-open-font-license-11) carry their own; [the icons'](#the-dashboards-icons--lucide-isc-and-feather-mit) notices are in the bundle |
| `aber/ingestion`, `aber/i3x-service`, `aber/test-runner` | `python:3.13-slim` (`test-runner` on `aber/ingestion`) | Python Software Foundation License | In the base: `/usr/local/lib/python3.13/LICENSE.txt` |

**The packages a Dockerfile installs from a distribution** (pgBackRest, tini, gosu, Node.js, SQLite,
GNU tar, age, the AWS CLI, protoc) come with that distribution's record of their licence. So does
each base's operating system, which includes GPL-2.0 packages such as BusyBox in the Alpine bases.
A Debian-based image (`edge-runtime` and the three Python images) carries each package's copyright
file under `/usr/share/doc/<package>/`. An Alpine-based image carries no texts: Alpine records each
package's licence in its package database (`apk list -I` prints it), and the sources are in Alpine's
`aports`.

**A guard keeps this list whole.** `scripts/check-image-licences.mjs` fails CI when `values.yaml`
pins an image, a chart template names one or a Dockerfile is built `FROM` one, that this file does
not name. It also fails when a file in `licenses/` differs from its SHA-256.

## `sparkplug_b.proto` — Eclipse Public License 2.0

One of the third-party pieces in this repository. It is Eclipse Tahu's Sparkplug B payload definition,
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

## The dashboard's icons — Lucide (ISC) and Feather (MIT)

[`frontend/src/components/common/Icons.jsx`](frontend/src/components/common/Icons.jsx) draws the
dashboard's icons as inline SVG. Most of its glyphs are copied from two icon sets, element for
element. A few are drawn after one of them, and a few are Aber's own. This was checked by comparing
each glyph with Feather 4.29.2 and with Lucide releases from 0.117.0 to 1.63.0. The MIT licence
above does not cover the copied glyphs.

| Icon set | Copyright | Licence |
| :--- | :--- | :--- |
| Lucide ([`github.com/lucide-icons/lucide`](https://github.com/lucide-icons/lucide)) | 2026 Lucide Icons and Contributors | ISC. The Lucide icons derived from Feather stay under Feather's MIT licence |
| Feather ([`github.com/feathericons/feather`](https://github.com/feathericons/feather), `v4.29.2`) | 2013-2023 Cole Bemis | MIT |

Both licences ask for their notice in every copy. `Icons.jsx` carries both notices in its header,
as a `/*!` legal comment, and the build keeps legal comments (`frontend/vite.config.js`), so the
bundle the frontend image serves carries them too. So do the npm dependencies' `@license` headers.
To check a build, search its JavaScript for the Lucide notice:

```
grep -l "Lucide Icons and Contributors" frontend/dist/assets/*.js
```

`frontend/src/__tests__/legalComments.test.js` fails if the build stops keeping legal comments or
the header loses either notice.

## The ASHRAE 223P ontology — Apache License 2.0

[`scripts/vocabularies/223p-v1.0.0-2026.ttl`](scripts/vocabularies/223p-v1.0.0-2026.ttl) is the
open223 ontology for ASHRAE Standard 223P, release `v1.0.0-2026`, copyright 2026 ASHRAE. The file
declares the Apache License 2.0 itself, and its text is beside it in
[`LICENSE-2.0.txt`](scripts/vocabularies/LICENSE-2.0.txt). It is unmodified. The MIT licence above
does not cover it.

`scripts/generate-ashrae223-vocabulary.mjs` builds the `ashrae223_vocabulary` seed rows from it.
Upstream: [`github.com/open223/defs.open223.info`](https://github.com/open223/defs.open223.info),
`ontologies/223p.ttl`. Upstream no longer serves this release; the folder's
[README](scripts/vocabularies/README.md) says why it is kept here.

## TimescaleDB — Timescale License

`timescale/timescaledb:2.29.2-pg17` is dual-licensed in a single upstream repository: the core under
Apache 2.0, and the features under `tsl/` under the Timescale License, which is source-available
rather than OSI-approved open source. The two build into separate shared objects, and the image
ships both: `timescaledb-2.29.2.so` and `timescaledb-tsl-2.29.2.so`, with those of every release
back to 2.17.0.

**This deployment runs under the Timescale License.** That is not an inference — the running server
reports it:

```
SHOW timescaledb.license  →  timescale
```

This is deliberate and it is not avoidable here. Four Timescale-Licensed features are load-bearing:

| Feature | Aber's calls | Where |
| :--- | :--- | :--- |
| Continuous aggregates | `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)`, `timescaledb.materialized_only`, `add_`/`remove_continuous_aggregate_policy`, `refresh_continuous_aggregate()` | [`timescaledb/aggregates.sql`](timescaledb/aggregates.sql) |
| Columnstore compression | `timescaledb.enable_columnstore` with `segmentby` and `orderby`, `add_`/`remove_columnstore_policy` | [`timescaledb/retention.sql`](timescaledb/retention.sql) on `telemetry`, [`aggregates.sql`](timescaledb/aggregates.sql) on the rollups |
| Retention policies | `add_`/`remove_retention_policy` | [`aggregates.sql`](timescaledb/aggregates.sql) on the rollups. [`retention.sql`](timescaledb/retention.sql) removes `telemetry`'s on every boot |
| User-defined jobs | `add_job` and `alter_job`, and the scheduler running each job | [`retention.sql`](timescaledb/retention.sql) for `telemetry_raw_retention()`, [`aggregates.sql`](timescaledb/aggregates.sql) for `refresh_requested_rollups()` |

Raw retention is a job, not a retention policy. `telemetry_raw_retention()` calls `drop_chunks()`,
which is Apache 2.0, but running it as a job is Timescale-Licensed.

**These are Apache 2.0**, and the SQL calls them too:

- `create_hypertable` ([`timescaledb/init/001_schema.sql`](timescaledb/init/001_schema.sql)),
  `set_chunk_time_interval` and `drop_chunks` ([`retention.sql`](timescaledb/retention.sql),
  [`cold_archive.sql`](timescaledb/cold_archive.sql), [`aggregates.sql`](timescaledb/aggregates.sql));
- `time_bucket` and `last()` ([`aggregates.sql`](timescaledb/aggregates.sql); the *Stack & Ingestion
  Health* dashboard calls `time_bucket` too);
- `hypertable_detailed_size`, `hypertable_compression_stats` and the `timescaledb_information` views
  ([`timescaledb/storage.sql`](timescaledb/storage.sql), the exporter's
  [`queries.yaml`](deploy/helm/aber/files/timescaledb-exporter/queries.yaml), the maintenance Job).

**Nothing calls `time_bucket_gapfill()` or `locf()`**, which are Timescale-Licensed.
`telemetry_gapfill()` is plain SQL ([`timescaledb/README.md`](timescaledb/README.md)). The load
generator and the restore rehearsal call `compress_chunk()`, also Timescale-Licensed, but neither
runs in a site's install.

**How this was checked**, against upstream at tag `2.29.2`. Each Timescale-Licensed call above reaches
a cross-module function in `src/cross_module_fn.c`. Under the `apache` licence that function raises
"functionality not supported under the current "apache" license", and `tsl/src/init.c` registers
its implementation. The Apache 2.0 calls are declared in `sql/` and implemented outside `tsl/`.

An Apache-only build of TimescaleDB (`timescaledb-apache`, or this extension with
`timescaledb.license = apache`) will not run this schema, whatever the values: `retention.sql` calls
`remove_columnstore_policy` and `remove_retention_policy` on every boot. Swapping the storage engine
for a permissively-licensed alternative is a rewrite of the rollup and retention machinery, not a
configuration change.

**What the Timescale License permits**, in outline: internal use, commercial use, modification, and
redistribution with the notices intact. Its principal restriction is on offering the software to
third parties as a hosted database service.

> **If you intend to operate this stack as a multi-tenant or hosted service, read the Timescale
> License yourself and take your own advice.** That use sits in the area the licence exists to
> restrict, and nothing in this file is a substitute for reading it or for professional advice.

For the ordinary case — running this at your own site, for your own operations, commercially or
not — the restriction does not engage.

**The licence text travels with the image.** The upstream image ships no TimescaleDB licence file: a
full-filesystem search of `timescale/timescaledb:2.29.2-pg17` finds only Python's. So
`timescaledb/Dockerfile` adds `LICENSE`, `LICENSE-APACHE`, `NOTICE` and `tsl/LICENSE-TIMESCALE` from
the `2.29.2` tag, at `/usr/share/licenses/timescaledb/` in `aber/timescaledb`. The source is
[`github.com/timescale/timescaledb`](https://github.com/timescale/timescaledb).

## Grafana and Loki — AGPL-3.0

`grafana/grafana:13.2.3` is licensed AGPL-3.0, confirmed from `/usr/share/grafana/LICENSE` in the
pinned image. **`grafana/loki:3.7.8` is AGPL-3.0 too**, like Grafana: its repository's `LICENSE` at
`v3.7.8` says so. The Loki image carries Debian's generic copy of the AGPL, not Loki's own file.
These are the most restrictive licences in the stack — more so than TimescaleDB's, which is worth
stating plainly because it is the opposite of the usual assumption.

The dashboard JSON in [`grafana/provisioning/`](grafana/provisioning/) is original work under this
repository's MIT licence, and so is the chart's Loki configuration. Each is configuration consumed by
the program, not a derivative of its source. Deploying an unmodified Grafana or Loki alongside this
stack does not engage the AGPL's obligations; **modifying either and offering it over a network
would**, including its network clause. A release publishes neither image.

## The extensions in `supabase/postgres`

`supabase/postgres:17.6.1.175` ships 78 extensions, and three published images carry every one of
them: `aber/supabase-db`, `aber/db-init` and `aber/backup-service`. The list is read from the image's
extension control files. Aber's migrations and seed create six of them: `postgres_fdw`, `pg_cron`,
`pg_net`, `supabase_vault`, `pgjwt` and `pgcrypto`.

**Two are copyleft: PostGIS and pgRouting, both GPL-2.0-or-later.** Aber creates neither, but their
binaries are in all three images, unmodified from `supabase/postgres:17.6.1.175`. Their GPL text
travels with them (`/usr/share/licenses/postgis/`, `/usr/share/licenses/pgrouting/`). So does a
written offer of their source, `SOURCE` in each of those folders
([`licenses/supabase-postgres/postgis/SOURCE`](licenses/supabase-postgres/postgis/SOURCE),
[`licenses/supabase-postgres/pgrouting/SOURCE`](licenses/supabase-postgres/pgrouting/SOURCE)). Each
names where the exact source is:

- the project at the tag below: PostGIS `3.3.7`, with no patches, and pgRouting `v3.4.1`;
- for pgRouting, the one patch the base's build applies for PostgreSQL 17,
  [`nix/ext/pgrouting/pgrouting-3.4.1-pg17.patch`](https://github.com/supabase/postgres/blob/17.6.1.175/nix/ext/pgrouting/pgrouting-3.4.1-pg17.patch);
- the scripts that built them, in [`supabase/postgres`](https://github.com/supabase/postgres/tree/17.6.1.175)
  at `17.6.1.175`, and the [nixpkgs](https://github.com/NixOS/nixpkgs/tree/fb7944c166a3b630f177938e478f0378e64ce108)
  its `flake.lock` pins.

**The source, mirrored.** Aber keeps a copy of the complete corresponding source of PostGIS,
pgRouting and the copyleft libraries below, with the scripts that built them, in a GitHub release of
its own:
[`gpl-sources-supabase-postgres-17.6.1.175-postgis`](https://github.com/Harri-Llewelyn/Aber/releases/tag/gpl-sources-supabase-postgres-17.6.1.175-postgis).
It holds one archive per component and a `SHA256SUMS` file, and covers every Aber image built on
`supabase/postgres:17.6.1.175`. [`licenses/supabase-postgres/sources.json`](licenses/supabase-postgres/sources.json)
pins every archive by SHA-256. `scripts/mirror-gpl-sources.mjs` publishes the release
(`.github/workflows/gpl-sources.yml`), and `release.yml` refuses to publish images until it holds every
archive the lock pins.

**The written offer.** For three years from each Aber release that ships these images, Aber's
maintainer will give anyone who asks a complete copy of the corresponding source. That covers
PostGIS, pgRouting and the copyleft libraries below. The charge is no more than the cost of making
the copy. To ask, use GitHub's
[private vulnerability reporting](https://github.com/Harri-Llewelyn/Aber/security/advisories/new),
the **Security** tab, then **Report a vulnerability**. The form is built for vulnerability reports;
use it for a source request too. Say which image you have and its tag, the Aber release (for
example `ghcr.io/harri-llewelyn/aber/supabase-db`), and that you are asking for the GPL source of
PostGIS or pgRouting. `scripts/check-image-licences.mjs` fails CI when an offer is missing or
unpinned, when an image built on `supabase/postgres` does not copy it, or when it names another base
tag or extension version than the images ship.

**The libraries only PostGIS loads.** PostGIS's modules load the libraries below from the image's
Nix store, and the PostgreSQL server does not. They were read with the image's own glibc loader
(`ld-linux-x86-64.so.2 --list`) on each PostGIS and pgRouting module and on `postgres`, then
subtracting what `postgres` loads. All but five are loaded by `postgis` itself: GDAL, libgeotiff,
Expat and libpq only by `postgis_raster`, and PCRE2 only by `address_standardizer`. pgRouting's
library loads nothing the server does not; it compiles in Boost 1.87.0's graph headers (BSL-1.0).
Each copyleft library's licence is under `/usr/share/licenses/<name>/`, and the offer above covers it.

| Library | Version | Licence | Source |
| :--- | :--- | :--- | :--- |
| GEOS | 3.14.1 | **LGPL-2.1** | [`libgeos/geos`](https://github.com/libgeos/geos) `3.14.1` |
| SFCGAL | 2.2.0 | **LGPL-2.0-or-later**; as built here **GPL-3.0-or-later**, because it compiles in CGAL's GPL packages | [`sfcgal/SFCGAL`](https://gitlab.com/sfcgal/SFCGAL) `v2.2.0` |
| CGAL, compiled into SFCGAL | 6.1 | **GPL-3.0-or-later** for the packages SFCGAL carries (`Nef_3`, `Straight_skeleton_2`, `Minkowski_sum_2`, `Minkowski_sum_3`, `Polygon_mesh_processing`, `Triangulation_2`, `Triangulation_3`, `Alpha_shapes_2`, `Convex_hull_3`, `Polyhedron`, `Surface_mesh`, `Arrangement_on_surface_2`, `Boolean_set_operations_2`, `Polyline_simplification_2`, `Box_intersection_d`, `AABB_tree`); **LGPL-3.0-or-later** for its kernel and support packages (`Kernel_23`, `Polygon`, `Number_types` and others) | [`CGAL/cgal`](https://github.com/CGAL/cgal) `v6.1` |
| GMP | 6.3.0 | **LGPL-3.0-or-later or GPL-2.0-or-later** | [`gmp-6.3.0.tar.xz`](https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz) |
| MPFR | 4.2.2 | **LGPL-3.0-or-later** | [`mpfr/mpfr`](https://gitlab.inria.fr/mpfr/mpfr) `4.2.2` |
| libidn2, through libcurl | 2.3.8 | **GPL-2.0-or-later or LGPL-3.0-or-later** | [`libidn/libidn2`](https://gitlab.com/libidn/libidn2) `v2.3.8` |
| libunistring, through libidn2 | 1.4.1 | **LGPL-3.0-or-later or GPL-2.0-or-later** | [`libunistring-1.4.1.tar.gz`](https://ftp.gnu.org/gnu/libunistring/libunistring-1.4.1.tar.gz) |
| PROJ | 9.7.1 | MIT | [`OSGeo/PROJ`](https://github.com/OSGeo/PROJ) `9.7.1` |
| GDAL | 3.8.5 | MIT | [`OSGeo/gdal`](https://github.com/OSGeo/gdal) `v3.8.5` |
| libgeotiff | 1.7.4 | MIT | [`OSGeo/libgeotiff`](https://github.com/OSGeo/libgeotiff) `1.7.4` |
| libtiff | 4.7.1 | libtiff (BSD-style) | [`libtiff/libtiff`](https://gitlab.com/libtiff/libtiff) `v4.7.1` |
| libjpeg-turbo | 3.1.3 | IJG and BSD-3-Clause | [`libjpeg-turbo/libjpeg-turbo`](https://github.com/libjpeg-turbo/libjpeg-turbo) `3.1.3` |
| libwebp | 1.6.0 | BSD-3-Clause | [`webmproject/libwebp`](https://github.com/webmproject/libwebp) `v1.6.0` |
| libdeflate | 1.25 | MIT | [`ebiggers/libdeflate`](https://github.com/ebiggers/libdeflate) `v1.25` |
| LERC | 4.0.0 | Apache 2.0 | [`Esri/lerc`](https://github.com/Esri/lerc) `v4.0.0` |
| liblzma (XZ Utils) | 5.8.1 | 0BSD | [`tukaani-project/xz`](https://github.com/tukaani-project/xz) `v5.8.1` |
| json-c | 0.18 | MIT | [`json-c/json-c`](https://github.com/json-c/json-c) `json-c-0.18-20240915` |
| protobuf-c | 1.5.2 | BSD-2-Clause | [`protobuf-c/protobuf-c`](https://github.com/protobuf-c/protobuf-c) `v1.5.2` |
| SQLite | 3.51.1 | Public domain | [`sqlite/sqlite`](https://github.com/sqlite/sqlite) `version-3.51.1` |
| curl (libcurl) | 8.17.0 | curl (MIT-style) | [`curl/curl`](https://github.com/curl/curl) `curl-8_17_0` |
| nghttp2 | 1.67.1 | MIT | [`nghttp2/nghttp2`](https://github.com/nghttp2/nghttp2) `v1.67.1` |
| nghttp3 | 1.13.1 | MIT | [`ngtcp2/nghttp3`](https://github.com/ngtcp2/nghttp3) `v1.13.1` |
| ngtcp2 | 1.18.0 | MIT | [`ngtcp2/ngtcp2`](https://github.com/ngtcp2/ngtcp2) `v1.18.0` |
| libssh2 | 1.11.1 | BSD-3-Clause | [`libssh2/libssh2`](https://github.com/libssh2/libssh2) `libssh2-1.11.1` |
| libpsl | 0.21.5 | MIT | [`rockdaboot/libpsl`](https://github.com/rockdaboot/libpsl) `0.21.5` |
| Brotli | 1.2.0 | MIT | [`google/brotli`](https://github.com/google/brotli) `v1.2.0` |
| Boost (`serialization`, `system`, `thread`) | 1.87.0 | BSL-1.0 | [`boostorg/boost`](https://github.com/boostorg/boost) `boost-1.87.0` |
| Expat | 2.7.3 | MIT | [`libexpat/libexpat`](https://github.com/libexpat/libexpat) `R_2_7_3` |
| PCRE2 | 10.46 | BSD-3-Clause with the PCRE2 exception | [`PCRE2Project/pcre2`](https://github.com/PCRE2Project/pcre2) `pcre2-10.46` |
| libpq | 17.6 | PostgreSQL License | [`postgres/postgres`](https://github.com/postgres/postgres) `REL_17_6` |

Each licence is from the project's repository at the version the image ships. Three were read at
a release of the version shipped: `rum` at 1.3.14, `plpgsql_check` at 2.8.0 and `pg_stat_monitor`
at 2.1.0. `pgjwt`, `supautils` and `plan_filter` were read on their default branch, because the
image names no tagged version of them.

| Extension | Version | Licence | Project |
| :--- | :--- | :--- | :--- |
| PostgreSQL's own: `amcheck`, `autoinc`, `bloom`, `btree_gin`, `btree_gist`, `citext`, `cube`, `dblink`, `dict_int`, `dict_xsyn`, `earthdistance`, `file_fdw`, `fuzzystrmatch`, `hstore`, `insert_username`, `intagg`, `intarray`, `isn`, `lo`, `ltree`, `moddatetime`, `pageinspect`, `pg_buffercache`, `pg_freespacemap`, `pg_prewarm`, `pg_stat_statements`, `pg_surgery`, `pg_trgm`, `pg_visibility`, `pg_walinspect`, `pgcrypto`, `pgrowlocks`, `pgstattuple`, `plpgsql`, `postgres_fdw`, `refint`, `seg`, `sslinfo`, `tablefunc`, `tcn`, `tsm_system_rows`, `tsm_system_time`, `unaccent`, `uuid-ossp`, `xml2` | 17.6 | PostgreSQL License | [`postgres/postgres`](https://github.com/postgres/postgres) `REL_17_6` |
| `postgis`, `postgis_raster`, `postgis_sfcgal`, `postgis_tiger_geocoder`, `postgis_topology` | 3.3.7 | **GPL-2.0-or-later** | [`postgis/postgis`](https://github.com/postgis/postgis) `3.3.7` |
| `address_standardizer`, `address_standardizer_data_us` | 3.3.7 | MIT | [`postgis/postgis`](https://github.com/postgis/postgis) `3.3.7`, `extensions/address_standardizer` |
| `pgrouting` | 3.4.1 | **GPL-2.0-or-later**, some parts Boost or MIT | [`pgRouting/pgrouting`](https://github.com/pgRouting/pgrouting) `v3.4.1` |
| `http` | 1.6 | MIT | [`pramsey/pgsql-http`](https://github.com/pramsey/pgsql-http) |
| `hypopg` | 1.4.1 | PostgreSQL License | [`HypoPG/hypopg`](https://github.com/HypoPG/hypopg) |
| `index_advisor` | 0.2.0 | PostgreSQL License | [`supabase/index_advisor`](https://github.com/supabase/index_advisor) |
| `pg_cron` | 1.6.4 | PostgreSQL License | [`citusdata/pg_cron`](https://github.com/citusdata/pg_cron) |
| `pg_graphql` | 1.6.2 | Apache 2.0 | [`supabase/pg_graphql`](https://github.com/supabase/pg_graphql) |
| `pg_hashids` | 1.3.0 | MIT | [`iCyberon/pg_hashids`](https://github.com/iCyberon/pg_hashids) |
| `pg_jsonschema` | 0.3.3 | Apache 2.0 | [`supabase/pg_jsonschema`](https://github.com/supabase/pg_jsonschema) |
| `pg_net` | 0.20.4 | Apache 2.0 | [`supabase/pg_net`](https://github.com/supabase/pg_net) |
| `pg_partman` | 5.3.1 | PostgreSQL License | [`pgpartman/pg_partman`](https://github.com/pgpartman/pg_partman) |
| `pg_repack` | 1.5.2 | BSD-3-Clause | [`reorg/pg_repack`](https://github.com/reorg/pg_repack) |
| `pg_stat_monitor` | 2.1 | PostgreSQL License | [`percona/pg_stat_monitor`](https://github.com/percona/pg_stat_monitor) |
| `pg_tle` | 1.4.0 | Apache 2.0 | [`aws/pg_tle`](https://github.com/aws/pg_tle) |
| `pgaudit` | 17.1 | PostgreSQL License | [`pgaudit/pgaudit`](https://github.com/pgaudit/pgaudit) |
| `pgjwt` | 0.2.0 | MIT | [`michelp/pgjwt`](https://github.com/michelp/pgjwt) |
| `pgmq` | 1.5.1 | PostgreSQL License | [`pgmq/pgmq`](https://github.com/pgmq/pgmq) |
| `pgroonga`, `pgroonga_database` | 3.2.5 | PostgreSQL License | [`pgroonga/pgroonga`](https://github.com/pgroonga/pgroonga) |
| `pgsodium` | 3.1.8 | PostgreSQL License | [`michelp/pgsodium`](https://github.com/michelp/pgsodium) |
| `pgtap` | 1.3.3 | PostgreSQL License | [`theory/pgtap`](https://github.com/theory/pgtap) |
| `plpgsql_check` | 2.8 | MIT | [`okbob/plpgsql_check`](https://github.com/okbob/plpgsql_check) |
| `rum` | 1.3 | PostgreSQL License | [`postgrespro/rum`](https://github.com/postgrespro/rum) |
| `supabase_vault` | 0.3.1 | Apache 2.0 | [`supabase/vault`](https://github.com/supabase/vault) |
| `vector` | 0.8.2 | PostgreSQL License | [`pgvector/pgvector`](https://github.com/pgvector/pgvector) |
| `wal2json` | 2.6 | BSD-3-Clause | [`eulerto/wal2json`](https://github.com/eulerto/wal2json) |
| `wrappers` | 0.6.3 | Apache 2.0 | [`supabase/wrappers`](https://github.com/supabase/wrappers) |

The image also carries server libraries that are not extensions: PostgreSQL's own `auto_explain`,
`auth_delay` and `passwordcheck`; `supautils` (Apache 2.0, [`supabase/supautils`](https://github.com/supabase/supautils));
`safeupdate` 1.4 (ISC, [`eradman/pg-safeupdate`](https://github.com/eradman/pg-safeupdate)); and
`plan_filter` 0.1 (PostgreSQL License, [`pgexperts/pg_plan_filter`](https://github.com/pgexperts/pg_plan_filter)).
The libraries the other extensions link, such as Groonga, libsodium and ICU, come from the image's
Nix store under their own licences, Groonga's the LGPL. This list stops at the extensions and
[the libraries only PostGIS loads](#the-extensions-in-supabasepostgres), above.

## Other components

Container images generally do not ship their application's licence text. The first table below is
what was read in the pinned image itself, and the second what was read in the project's repository
at the pinned tag. **Neither is a warranty** — confirm against the upstream project before relying
on any row.

### Verified from the pinned image

| Component | Licence | Evidence |
| :--- | :--- | :--- |
| `timescale/timescaledb:2.29.2-pg17` | Timescale License (core Apache 2.0) | `SHOW timescaledb.license` → `timescale`. No licence file of its own ([above](#timescaledb--timescale-license)) |
| pgBackRest 2.57.0, added to that image as `ghcr.io/harri-llewelyn/aber/timescaledb` (`timescaledb/Dockerfile`) | MIT | `apk info -a pgbackrest` → `license: MIT` |
| pgBackRest 2.57.0 and tini 0.19.0, added to `supabase/postgres:17.6.1.175` as `ghcr.io/harri-llewelyn/aber/supabase-db` (`supabase/db/Dockerfile`) | MIT | `apk info -a pgbackrest`, `apk info -a tini` → `license: MIT` |
| gosu, added from Alpine to both of those images | Apache 2.0 | `apk info -a gosu` → `license: Apache-2.0` |
| `grafana/grafana:13.2.3` | AGPL-3.0 | `/usr/share/grafana/LICENSE` |
| `prom/prometheus:v3.15.0` | Apache 2.0 | `/LICENSE` |
| `eclipse-mosquitto:2.1.2-alpine` | EPL-2.0 / EDL-1.0 | `/usr/share/licenses/mosquitto/` |
| `nodered/node-red:5.0.7` | Apache 2.0 | `/usr/src/node-red/node_modules/node-red/LICENSE` |
| `nginx:alpine` | BSD-2-Clause | `/usr/share/licenses/nginx/COPYRIGHT` (nginx 1.31.8 when read; the tag moves) |
| `python:3.13-slim` | Python Software Foundation License | `/usr/local/lib/python3.13/LICENSE.txt` (Python 3.13.16 when read; the tag moves) |
| `node:24.21.0-alpine3.24`, `node:24-alpine` | MIT, with Node.js's bundled dependencies' licences in the same file | `/usr/local/LICENSE` |
| `alpine:3.24` | Each package its own: BusyBox and apk-tools GPL-2.0-only, musl MIT, OpenSSL Apache 2.0 | `apk list -I` |

### Checked in the upstream repository

These images ship no application licence file, or no shell to inspect one with. The licence is the
one the project's repository declares at the tag the chart or a Dockerfile pins.

| Component | Licence | Project, at the pinned tag |
| :--- | :--- | :--- |
| `supabase/postgres:17.6.1.175` | PostgreSQL License; [its extensions](#the-extensions-in-supabasepostgres) their own | [`supabase/postgres`](https://github.com/supabase/postgres) `17.6.1.175` |
| `postgrest/postgrest:v14.17` | MIT | [`PostgREST/postgrest`](https://github.com/PostgREST/postgrest) `v14.17` |
| `supabase/gotrue:v2.197.0` | MIT | [`supabase/auth`](https://github.com/supabase/auth) `v2.197.0` |
| `supabase/realtime:v2.134.10` | Apache 2.0 | [`supabase/realtime`](https://github.com/supabase/realtime) `v2.134.10` |
| `supabase/storage-api:v1.74.0` | Apache 2.0 | [`supabase/storage`](https://github.com/supabase/storage) `v1.74.0` |
| `supabase/edge-runtime:v1.77.0` | MIT | [`supabase/edge-runtime`](https://github.com/supabase/edge-runtime) `v1.77.0` |
| `supabase/postgres-meta:v0.99.0` | Apache 2.0 | [`supabase/postgres-meta`](https://github.com/supabase/postgres-meta) `v0.99.0` |
| `supabase/studio:2026.09.28-sha-5e59b60` | Apache 2.0 | [`supabase/supabase`](https://github.com/supabase/supabase), on its default branch: the tag's commit is not in its public history |
| `envoyproxy/envoy:v1.39.2` | Apache 2.0 | [`envoyproxy/envoy`](https://github.com/envoyproxy/envoy) `v1.39.2` |
| `swaggerapi/swagger-ui:v5.33.0` | Apache 2.0 | [`swagger-api/swagger-ui`](https://github.com/swagger-api/swagger-ui) `v5.33.0` |
| `grafana/loki:3.7.8` | **AGPL-3.0** ([above](#grafana-and-loki--agpl-30)) | [`grafana/loki`](https://github.com/grafana/loki) `v3.7.8` |
| `grafana/alloy:v1.20.1` | Apache 2.0 | [`grafana/alloy`](https://github.com/grafana/alloy) `v1.20.1` |
| `gitea/gitea:28.0.0` | MIT | [`go-gitea/gitea`](https://github.com/go-gitea/gitea) `v28.0.0` |
| `quay.io/prometheuscommunity/postgres-exporter:v0.20.1` | Apache 2.0 | [`prometheus-community/postgres_exporter`](https://github.com/prometheus-community/postgres_exporter) `v0.20.1` |
| `jryberg/mosquitto-exporter:v0.7.9` | Apache 2.0 | [`jryberg/mosquitto-exporter`](https://github.com/jryberg/mosquitto-exporter) `v0.7.9` |
| `curlimages/curl:8.22.0` | curl licence (MIT-style); the image's own files MIT | [`curl/curl`](https://github.com/curl/curl) `curl-8_22_0`, [`curl/curl-container`](https://github.com/curl/curl-container) `8.22.0` |
| `denoland/deno:2.1.4` | MIT | [`denoland/deno`](https://github.com/denoland/deno) `v2.1.4`. A build stage only: `aber/edge-runtime` takes the module cache it resolves, not Deno |
| `python:3.12-slim` | Python Software Foundation License | [`python/cpython`](https://github.com/python/cpython). Pinned by digest in `forge/gateway-custom-example/custom/Dockerfile`, which a site builds on its own gateway |

## Standards and vocabularies

Adopting a standard's vocabulary is not a compliance claim. Locally-minted semantic ids live under
`https://aber.local/semantics/…` precisely so that no identifier asserts an interoperability
that has not been certified. The MTConnect Implementer License, and the equivalent programmes for
the other bodies, are separate from anything granted here. See
[`docs/vocabularies.md`](docs/vocabularies.md).

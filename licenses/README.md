# Licence texts the published images carry

A release publishes images built on upstream ones ([`NOTICE.md`](../NOTICE.md), *The images a
release publishes*). Where an upstream image does not carry its own licence text, the Dockerfile
copies it from here. A build never fetches one.

Each folder is one set, laid out as it lands under `/usr/share/licenses/` in the image:

| Folder | Copied by | In the image |
| :--- | :--- | :--- |
| `timescaledb/` | `timescaledb/Dockerfile` | `/usr/share/licenses/timescaledb/`, `/usr/share/licenses/postgresql/` |
| `supabase-postgres/` | `supabase/db/Dockerfile`, `supabase/db-init/Dockerfile`, `backup-service/Dockerfile` | `/usr/share/licenses/supabase-postgres/`, `postgresql/`, one folder for each permissive extension (`pg_cron/`, `vector/` and the rest, below), `postgis/`, `pgrouting/`, and the libraries only PostGIS loads: `geos/`, `sfcgal/`, `cgal/`, `gmp/`, `mpfr/`, `libidn2/`, `libunistring/` |
| `edge-runtime/` | `supabase/functions/Dockerfile` | `/usr/share/licenses/edge-runtime/` |
| `swagger-ui/` | `swagger-ui/Dockerfile` | `/usr/share/licenses/swagger-ui/` |

One file is not a text: [`os-packages.sh`](os-packages.sh), which writes an Alpine-based image's
OS packages' licences (*The OS packages*, below). Every published image on Alpine copies it.

`timescaledb/Dockerfile`, `supabase/db/Dockerfile`, `supabase/db-init/Dockerfile`,
`node-red/Dockerfile` and `frontend/Dockerfile` are built from contexts that do not hold this
folder, so each build passes it as a named context: `--build-context licenses=./licenses`. The
others are built from the repository root and copy `licenses/...` directly.

## The files

Every licence text is byte for byte what upstream serves at the tag, commit or release below. The
two `SOURCE` files, `sources.json` and `os-packages.sh` are Aber's own: the written offer of the
GPL source, the lock of its mirror, and the script that lists the OS packages (below).
[`SHA256SUMS`](SHA256SUMS) pins every file, and `scripts/check-image-licences.mjs` fails CI when a file differs from its pin or
is not pinned.

| File | Upstream, at the tag the image pins |
| :--- | :--- |
| `timescaledb/timescaledb/LICENSE` | [`timescale/timescaledb`](https://github.com/timescale/timescaledb) `2.31.0`, `LICENSE` |
| `timescaledb/timescaledb/LICENSE-APACHE` | the same, `LICENSE-APACHE` |
| `timescaledb/timescaledb/NOTICE` | the same, `NOTICE` |
| `timescaledb/timescaledb/LICENSE-TIMESCALE` | the same, `tsl/LICENSE-TIMESCALE` |
| `timescaledb/postgresql/COPYRIGHT` | [`postgres/postgres`](https://github.com/postgres/postgres) `REL_17_11`, `COPYRIGHT` (the PostgreSQL that `timescale/timescaledb:2.31.0-pg17` runs) |
| `supabase-postgres/supabase-postgres/LICENSE` | [`supabase/postgres`](https://github.com/supabase/postgres) `17.6.1.175`, `LICENSE` |
| `supabase-postgres/postgresql/COPYRIGHT` | [`postgres/postgres`](https://github.com/postgres/postgres) `REL_17_6`, `COPYRIGHT` |
| `supabase-postgres/address_standardizer/COPYING` | [`postgis/postgis`](https://github.com/postgis/postgis) `3.3.7`, `extensions/address_standardizer/COPYING` (MIT) |
| `supabase-postgres/http/LICENSE.md` | [`pramsey/pgsql-http`](https://github.com/pramsey/pgsql-http) `v1.6.1`, `LICENSE.md` (MIT) |
| `supabase-postgres/hypopg/LICENSE` | [`HypoPG/hypopg`](https://github.com/HypoPG/hypopg) `1.4.1`, `LICENSE` (PostgreSQL License) |
| `supabase-postgres/index_advisor/LICENSE` | [`supabase/index_advisor`](https://github.com/supabase/index_advisor) `v0.2.0`, `LICENSE` (PostgreSQL License); the base's build fetches it as `olirice/index_advisor`, which GitHub now serves from there |
| `supabase-postgres/pg_cron/LICENSE` | [`citusdata/pg_cron`](https://github.com/citusdata/pg_cron) `v1.6.4`, `LICENSE` (PostgreSQL License) |
| `supabase-postgres/pg_graphql/LICENSE` | [`supabase/pg_graphql`](https://github.com/supabase/pg_graphql) `v1.6.2`, `LICENSE` (Apache 2.0) |
| `supabase-postgres/pg_hashids/LICENSE` | [`iCyberon/pg_hashids`](https://github.com/iCyberon/pg_hashids) commit `cd0e1b31d52b394a0df64079406a14a4f7387cd6`, `LICENSE` (MIT) |
| `supabase-postgres/pg_jsonschema/LICENSE` | [`supabase/pg_jsonschema`](https://github.com/supabase/pg_jsonschema) `v0.3.3`, `LICENSE` (Apache 2.0) |
| `supabase-postgres/pg_net/LICENSE` | [`supabase/pg_net`](https://github.com/supabase/pg_net) `v0.20.4`, `LICENSE` (Apache 2.0) |
| `supabase-postgres/pg_partman/LICENSE.txt` | [`pgpartman/pg_partman`](https://github.com/pgpartman/pg_partman) `v5.3.1`, `LICENSE.txt` (PostgreSQL License) |
| `supabase-postgres/pg_repack/COPYRIGHT` | [`reorg/pg_repack`](https://github.com/reorg/pg_repack) `ver_1.5.2`, `COPYRIGHT` (BSD-3-Clause) |
| `supabase-postgres/pg_stat_monitor/LICENSE` | [`percona/pg_stat_monitor`](https://github.com/percona/pg_stat_monitor) `2.1.0`, `LICENSE` (PostgreSQL License) |
| `supabase-postgres/pg_tle/LICENSE`, `NOTICE` | [`aws/pg_tle`](https://github.com/aws/pg_tle) `v1.4.0`, the same two files (Apache 2.0, and the notice its §4 asks to travel) |
| `supabase-postgres/pgaudit/LICENSE` | [`pgaudit/pgaudit`](https://github.com/pgaudit/pgaudit) `17.1`, `LICENSE` (the PostgreSQL License, by name; `postgresql/COPYRIGHT` is its text) |
| `supabase-postgres/pgjwt/LICENSE` | [`michelp/pgjwt`](https://github.com/michelp/pgjwt) commit `f3d82fd30151e754e19ce5d6a06c71c20689ce3d`, `LICENSE` (MIT) |
| `supabase-postgres/pgmq/LICENSE` | [`pgmq/pgmq`](https://github.com/pgmq/pgmq) `v1.5.1`, `LICENSE` (PostgreSQL License); fetched as `tembo-io/pgmq`, now served from there |
| `supabase-postgres/pgroonga/COPYING` | [`pgroonga/pgroonga`](https://github.com/pgroonga/pgroonga) `3.2.5`, `COPYING` (PostgreSQL License); the build fetches that release's source archive |
| `supabase-postgres/pgsodium/LICENSE` | [`michelp/pgsodium`](https://github.com/michelp/pgsodium) `v3.1.8`, `LICENSE` (PostgreSQL License) |
| `supabase-postgres/pgtap/README.md` | [`theory/pgtap`](https://github.com/theory/pgtap) `v1.3.3`, `README.md`: the tag has no licence file, nor has the default branch, and the README states the licence (PostgreSQL License) under *Copyright and License* |
| `supabase-postgres/plpgsql_check/LICENSE` | [`okbob/plpgsql_check`](https://github.com/okbob/plpgsql_check) `v2.8.11`, `LICENSE` (MIT) |
| `supabase-postgres/rum/LICENSE` | [`postgrespro/rum`](https://github.com/postgrespro/rum) `1.3.14`, `LICENSE` (PostgreSQL License) |
| `supabase-postgres/supabase_vault/LICENSE` | [`supabase/vault`](https://github.com/supabase/vault) `v0.3.1`, `LICENSE` (Apache 2.0) |
| `supabase-postgres/vector/LICENSE` | [`pgvector/pgvector`](https://github.com/pgvector/pgvector) `v0.8.2`, `LICENSE` (PostgreSQL License) |
| `supabase-postgres/wal2json/LICENSE` | [`eulerto/wal2json`](https://github.com/eulerto/wal2json) `wal2json_2_6`, `LICENSE` (BSD-3-Clause) |
| `supabase-postgres/wrappers/LICENSE` | [`supabase/wrappers`](https://github.com/supabase/wrappers) `v0.6.3`, `LICENSE` (Apache 2.0) |
| `supabase-postgres/supautils/LICENSE` | [`supabase/supautils`](https://github.com/supabase/supautils) `v3.4.3`, `LICENSE` (Apache 2.0) |
| `supabase-postgres/safeupdate/LICENSE` | [`eradman/pg-safeupdate`](https://github.com/eradman/pg-safeupdate) `1.4`, `LICENSE` (ISC) |
| `supabase-postgres/plan_filter/License` | [`pgexperts/pg_plan_filter`](https://github.com/pgexperts/pg_plan_filter) commit `5081a7b5cb890876e67d8e7486b6a64c38c9a492`, `License` (PostgreSQL License) |
| `supabase-postgres/postgis/COPYING` | [`postgis/postgis`](https://github.com/postgis/postgis) `3.3.7`, `COPYING` (GPL-2.0) |
| `supabase-postgres/postgis/LICENSE.TXT` | the same, `LICENSE.TXT` |
| `supabase-postgres/pgrouting/LICENSE` | [`pgRouting/pgrouting`](https://github.com/pgRouting/pgrouting) `v3.4.1`, `LICENSE` (GPL-2.0) |
| `supabase-postgres/postgis/SOURCE`, `supabase-postgres/pgrouting/SOURCE` | Aber's written offer of the source (below) |
| `supabase-postgres/sources.json` | Aber's lock of the mirrored source archives (*The mirror*, below); it lands in the images as `/usr/share/licenses/sources.json` |
| `supabase-postgres/geos/COPYING` | [`libgeos/geos`](https://github.com/libgeos/geos) `3.14.1`, `COPYING` (LGPL-2.1) |
| `supabase-postgres/sfcgal/LICENSE` | [`sfcgal/SFCGAL`](https://gitlab.com/sfcgal/SFCGAL) `v2.2.0`, `LICENSE` (LGPL-2.0) |
| `supabase-postgres/cgal/LICENSE`, `LICENSE.GPL`, `LICENSE.LGPL` | [`CGAL/cgal`](https://github.com/CGAL/cgal) `v6.1`, `Installation/LICENSE`, `Installation/LICENSE.GPL` (GPL-3.0), `Installation/LICENSE.LGPL` (LGPL-3.0) |
| `supabase-postgres/gmp/COPYING.LESSERv3`, `COPYINGv2`, `COPYINGv3` | [`gmp-6.3.0.tar.xz`](https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz), the same three files (LGPL-3.0, GPL-2.0, GPL-3.0) |
| `supabase-postgres/mpfr/COPYING.LESSER`, `COPYING` | [`mpfr/mpfr`](https://gitlab.inria.fr/mpfr/mpfr) `4.2.2`, the same two files (LGPL-3.0, GPL-3.0) |
| `supabase-postgres/libidn2/COPYINGv2`, `COPYING.LESSERv3`, `COPYING`, `COPYING.unicode` | [`libidn/libidn2`](https://gitlab.com/libidn/libidn2) `v2.3.8`, the same four files (GPL-2.0, LGPL-3.0, GPL-3.0, the Unicode data licence) |
| `supabase-postgres/libunistring/COPYING.LIB`, `COPYING` | [`libunistring-1.4.1.tar.gz`](https://ftp.gnu.org/gnu/libunistring/libunistring-1.4.1.tar.gz), the same two files (LGPL-3.0, GPL-3.0) |
| `edge-runtime/edge-runtime/LICENSE` | [`supabase/edge-runtime`](https://github.com/supabase/edge-runtime) `v1.77.4`, `LICENSE` |
| `swagger-ui/swagger-ui/LICENSE` | [`swagger-api/swagger-ui`](https://github.com/swagger-api/swagger-ui) `v5.34.1`, `LICENSE` |
| `swagger-ui/swagger-ui/NOTICE` | the same, `NOTICE` |
| `os-packages.sh` | Aber's own (*The OS packages*, below) |

PostGIS and pgRouting are here because `supabase/postgres` ships both extensions' binaries, under
the GPL, without the licence text. Aber's migrations create neither. GEOS, SFCGAL, CGAL, GMP, MPFR,
libidn2 and libunistring are the copyleft libraries PostGIS loads and the PostgreSQL server does not
([`NOTICE.md`](../NOTICE.md), *The libraries only PostGIS loads*). The base carries none of their
texts either.

The permissive extensions and server libraries are here because their licences ask for the notice
to travel with every copy, and the base carries none of them. Each folder is named after the first
extension its row in `NOTICE.md`'s extension table names. Each text was read at the tag or commit
the base's build fetched, which `supabase/postgres`'s
[`nix/ext/`](https://github.com/supabase/postgres/tree/17.6.1.175/nix/ext) names at the base tag.
PostgreSQL's own extensions are under `postgresql/COPYRIGHT`. `check-image-licences.mjs` fails when
a permissive row in `NOTICE.md` has no pinned folder here, or when the table above does not name the
folder at the row's ref.

## The OS packages

An Alpine package carries no licence text: Alpine records each package's licence in its package
database. So each published image on Alpine writes two files from that database at build time:

- `/usr/share/licenses/os-packages.txt`: every package, with its version, licence and origin, the
  `aports` package that built it.
- `/usr/share/licenses/os-packages-source.txt`: the copyleft ones, with the `aports` commit each was
  built from. It says where their source is, in Alpine's `aports` on the branch of the image's
  Alpine release (`3.24-stable` for Alpine 3.24.4). It carries the written offer `NOTICE.md` makes
  for the GPL extensions, through the same route.

[`os-packages.sh`](os-packages.sh) writes both, with nothing but BusyBox. Each Dockerfile copies it
to `/tmp`, runs it as root after its last `apk` step, and deletes it: a later `apk add` would make
the list wrong. `check-image-licences.mjs` fails when a published Dockerfile whose final stage is
Alpine does not, or when it runs `apk` after the script. A package that did not come from `aports`,
such as nginx's from nginx.org, has `-` for its commit. The two files cover only what `apk` installed:
the Nix store in `supabase/postgres` and the npm packages in Node-RED are not in that database.

## The written offer of the source

GPL-2.0 §3 asks whoever distributes a GPL binary to include its source, or a written offer to
provide it. Publishing the images is distribution, so `postgis/SOURCE` and `pgrouting/SOURCE` travel
beside the licence texts. Each names the exact source, says the binaries come unmodified from the
base, and offers the source for three years from each release that ships them. A request goes
through GitHub's private vulnerability reporting, the route `SECURITY.md` names; the repository
publishes no email address. `postgis/SOURCE` also covers the copyleft libraries above.

`scripts/check-image-licences.mjs` holds each offer to the images: present, pinned, copied by every
Dockerfile built on `supabase/postgres`, and naming that base's tag and the extension version and tag
`NOTICE.md`'s extension table gives.

## The mirror

GPL-3.0 §6(d), which the CGAL packages inside SFCGAL and the LGPL-3.0 libraries carry, asks that the
source be offered from a place the distributor answers for, with clear directions beside the object
code. A link to upstream alone is not that. So Aber mirrors the complete corresponding source to a
GitHub release of its own, one per `supabase/postgres` tag and scope:
`gpl-sources-supabase-postgres-<tag>-postgis`, never a `v*` tag and never the latest release. The
`postgis` scope covers PostGIS, pgRouting and the libraries only PostGIS loads; another set of
sources for the same base takes a scope and a tag of its own. Both `SOURCE` files and `NOTICE.md`
link it, above their written offer, which stands unchanged.

The release holds one archive per component and a `SHA256SUMS` file:

- PostGIS, pgRouting and the seven copyleft libraries, each at the version the image ships;
- the patch the base's build applies to pgRouting, as its own file;
- `supabase/postgres` at the base tag, and the nixpkgs its `flake.lock` pins: the scripts that built
  them.

[`sources.json`](supabase-postgres/sources.json) pins each archive: its component, version, upstream
URL, asset name, SHA-256 and size, with the lock's `scope`. Each archive is the source the binaries
were built from, so it is what the base image's build fetched:

- Seven are the very files: their SHA-256 matches the fixed-output hash in the image's Nix store.
- GEOS, pgRouting and SFCGAL were fetched as the forge's archive of the tag, and nixpkgs as the
  channel archive `flake.lock` names. The Nix hash of those is over the unpacked tree, so the
  archive's own bytes are pinned here. Each one's unpacked tree has the derivation's NAR hash,
  computed from the archive without Nix.
- `supabase/postgres`, the build scripts, is GitHub's archive of the tag, pinned as downloaded.

GitHub's generated archives are not promised byte for byte. If one changes upstream, `--check`
fails, and the release keeps the copy the lock pins.

[`scripts/mirror-gpl-sources.mjs`](../scripts/mirror-gpl-sources.mjs) does the work, and
[`gpl-sources.yml`](../.github/workflows/gpl-sources.yml) runs it with `--publish`. The
repository's releases are immutable, so it uploads to a draft, verifies every digest against the
lock, and only then publishes. A published release can gain no asset and change none: if the lock
changes for a base tag already published, a person decides what replaces the release.
`release.yml`'s pre-flight refuses to publish images until the release holds every archive.
`check-image-licences.mjs` holds the lock to the images: its base is the Dockerfiles', and it holds
every component at the version `NOTICE.md` gives.

## Moving to a newer upstream tag

1. Download the files from the new tag and replace the ones here.
2. Run `sha256sum` over the folder, from inside it, and replace the changed lines in `SHA256SUMS`.
3. Update the table above and the image's row in `NOTICE.md`.
4. For a new `supabase/postgres` tag, update both `SOURCE` files: the base tag, the extension
   versions and tags, the build scripts' tag and the nixpkgs their `flake.lock` pins. Read the
   libraries only PostGIS loads again (`ld-linux-x86-64.so.2 --list` on each module and on
   `postgres`, with the image's own glibc loader), and update `postgis/SOURCE`, `NOTICE.md` and the
   vendored texts to match. Read each permissive extension's tag or commit again from the new tag's
   `nix/ext/` (`versions.json` and the `.nix` beside it), and replace its text and its rows here and
   in `NOTICE.md`.
5. For a new `supabase/postgres` tag, also replace `sources.json`: its `base`, and each archive's
   version, URL, asset name, SHA-256 and size. Run `node scripts/mirror-gpl-sources.mjs --check`,
   which downloads each one and checks it. Once the change merges, run Actions → GPL Sources before
   the first release on the new base.
6. Run `node scripts/check-image-licences.mjs`.

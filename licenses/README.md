# Licence texts the published images carry

A release publishes images built on upstream ones ([`NOTICE.md`](../NOTICE.md), *The images a
release publishes*). Where an upstream image does not carry its own licence text, the Dockerfile
copies it from here. A build never fetches one.

Each folder is one set, laid out as it lands under `/usr/share/licenses/` in the image:

| Folder | Copied by | In the image |
| :--- | :--- | :--- |
| `timescaledb/` | `timescaledb/Dockerfile` | `/usr/share/licenses/timescaledb/`, `/usr/share/licenses/postgresql/` |
| `supabase-postgres/` | `supabase/db/Dockerfile`, `supabase/db-init/Dockerfile`, `backup-service/Dockerfile` | `/usr/share/licenses/supabase-postgres/`, `postgresql/`, `postgis/`, `pgrouting/`, and the libraries only PostGIS loads: `geos/`, `sfcgal/`, `cgal/`, `gmp/`, `mpfr/`, `libidn2/`, `libunistring/` |
| `edge-runtime/` | `supabase/functions/Dockerfile` | `/usr/share/licenses/edge-runtime/` |
| `swagger-ui/` | `swagger-ui/Dockerfile` | `/usr/share/licenses/swagger-ui/` |

`timescaledb/Dockerfile`, `supabase/db/Dockerfile` and `supabase/db-init/Dockerfile` are built from
contexts that do not hold this folder, so each build passes it as a named context:
`--build-context licenses=./licenses`. The other three are built from the repository root and copy
`licenses/...` directly.

## The files

Every licence text is byte for byte what upstream serves at the tag or release below. The two
`SOURCE` files and `sources.json` are Aber's own: the written offer of the GPL source and the lock
of its mirror (below). [`SHA256SUMS`](SHA256SUMS)
pins every file, and `scripts/check-image-licences.mjs` fails CI when a file differs from its pin or
is not pinned.

| File | Upstream, at the tag the image pins |
| :--- | :--- |
| `timescaledb/timescaledb/LICENSE` | [`timescale/timescaledb`](https://github.com/timescale/timescaledb) `2.29.2`, `LICENSE` |
| `timescaledb/timescaledb/LICENSE-APACHE` | the same, `LICENSE-APACHE` |
| `timescaledb/timescaledb/NOTICE` | the same, `NOTICE` |
| `timescaledb/timescaledb/LICENSE-TIMESCALE` | the same, `tsl/LICENSE-TIMESCALE` |
| `timescaledb/postgresql/COPYRIGHT` | [`postgres/postgres`](https://github.com/postgres/postgres) `REL_17_11`, `COPYRIGHT` (the PostgreSQL that `timescale/timescaledb:2.29.2-pg17` runs) |
| `supabase-postgres/supabase-postgres/LICENSE` | [`supabase/postgres`](https://github.com/supabase/postgres) `17.6.1.175`, `LICENSE` |
| `supabase-postgres/postgresql/COPYRIGHT` | [`postgres/postgres`](https://github.com/postgres/postgres) `REL_17_6`, `COPYRIGHT` |
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
| `edge-runtime/edge-runtime/LICENSE` | [`supabase/edge-runtime`](https://github.com/supabase/edge-runtime) `v1.77.0`, `LICENSE` |
| `swagger-ui/swagger-ui/LICENSE` | [`swagger-api/swagger-ui`](https://github.com/swagger-api/swagger-ui) `v5.33.0`, `LICENSE` |
| `swagger-ui/swagger-ui/NOTICE` | the same, `NOTICE` |

PostGIS and pgRouting are here because `supabase/postgres` ships both extensions' binaries, under
the GPL, without the licence text. Aber's migrations create neither. GEOS, SFCGAL, CGAL, GMP, MPFR,
libidn2 and libunistring are the copyleft libraries PostGIS loads and the PostgreSQL server does not
([`NOTICE.md`](../NOTICE.md), *The libraries only PostGIS loads*). The base carries none of their
texts either.

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
GitHub release of its own, one per `supabase/postgres` tag:
`gpl-sources-supabase-postgres-<tag>`, never a `v*` tag and never the latest release. Both `SOURCE`
files and `NOTICE.md` link it, above their written offer, which stands unchanged.

The release holds one archive per component and a `SHA256SUMS` file:

- PostGIS, pgRouting and the seven copyleft libraries, each at the version the image ships;
- the patch the base's build applies to pgRouting, as its own file;
- `supabase/postgres` at the base tag, and the nixpkgs its `flake.lock` pins: the scripts that built
  them.

[`sources.json`](supabase-postgres/sources.json) pins each archive: its component, version, upstream
URL, asset name, SHA-256 and size. Upstream release archives are preferred, because GitHub's
generated archives are not promised byte for byte. Two have no other form (SFCGAL and
`supabase/postgres`), and are pinned as downloaded. Seven of the archives are the very files the
base image's build fetched: their SHA-256 matches the fixed-output hash in its Nix store.

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
   vendored texts to match.
5. For a new `supabase/postgres` tag, also replace `sources.json`: its `base`, and each archive's
   version, URL, asset name, SHA-256 and size. Run `node scripts/mirror-gpl-sources.mjs --check`,
   which downloads each one and checks it. Once the change merges, run Actions → GPL Sources before
   the first release on the new base.
6. Run `node scripts/check-image-licences.mjs`.

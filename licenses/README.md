# Licence texts the published images carry

A release publishes images built on upstream ones ([`NOTICE.md`](../NOTICE.md), *The images a
release publishes*). Where an upstream image does not carry its own licence text, the Dockerfile
copies it from here. A build never fetches one.

Each folder is one set, laid out as it lands under `/usr/share/licenses/` in the image:

| Folder | Copied by | In the image |
| :--- | :--- | :--- |
| `timescaledb/` | `timescaledb/Dockerfile` | `/usr/share/licenses/timescaledb/`, `/usr/share/licenses/postgresql/` |
| `supabase-postgres/` | `supabase/db/Dockerfile`, `supabase/db-init/Dockerfile`, `backup-service/Dockerfile` | `/usr/share/licenses/supabase-postgres/`, `postgresql/`, `postgis/`, `pgrouting/` |
| `edge-runtime/` | `supabase/functions/Dockerfile` | `/usr/share/licenses/edge-runtime/` |
| `swagger-ui/` | `swagger-ui/Dockerfile` | `/usr/share/licenses/swagger-ui/` |

`timescaledb/Dockerfile`, `supabase/db/Dockerfile` and `supabase/db-init/Dockerfile` are built from
contexts that do not hold this folder, so each build passes it as a named context:
`--build-context licenses=./licenses`. The other three are built from the repository root and copy
`licenses/...` directly.

## The files

Every file is byte for byte what upstream serves at the tag below. [`SHA256SUMS`](SHA256SUMS) pins
each one, and `scripts/check-image-licences.mjs` fails CI when a file differs from its pin or is not
pinned.

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
| `edge-runtime/edge-runtime/LICENSE` | [`supabase/edge-runtime`](https://github.com/supabase/edge-runtime) `v1.77.0`, `LICENSE` |
| `swagger-ui/swagger-ui/LICENSE` | [`swagger-api/swagger-ui`](https://github.com/swagger-api/swagger-ui) `v5.33.0`, `LICENSE` |
| `swagger-ui/swagger-ui/NOTICE` | the same, `NOTICE` |

PostGIS and pgRouting are here because `supabase/postgres` ships both extensions' binaries, under
the GPL, without the licence text. Aber's migrations create neither.

## Moving to a newer upstream tag

1. Download the files from the new tag and replace the ones here.
2. Run `sha256sum` over the folder, from inside it, and replace the changed lines in `SHA256SUMS`.
3. Update the table above and the image's row in `NOTICE.md`.
4. Run `node scripts/check-image-licences.mjs`.

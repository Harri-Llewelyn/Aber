# The platform database's image

**In short:** the image `supabase-db` runs: the pinned `supabase/postgres` with pgBackRest and
`tini` added, so the platform database can archive its WAL and be restored to a moment. The
operator's runbook is [`deploy/k8s/README.md`](../../deploy/k8s/README.md), *Backing up the platform
database*. This page holds the reasoning and the evidence behind the image and the chart's use of it.

| File | What it is |
| :--- | :--- |
| [`Dockerfile`](Dockerfile) | `FROM supabase/postgres:17.6.1.175`, plus `pgbackrest`, `tini` and Alpine's `gosu` |
| [`pgbackrest/platform-backup.sh`](pgbackrest/platform-backup.sh) | The backup sidecar's schedule, mirrored into the chart by `scripts/sync-helm-chart-files.mjs` |

```bash
docker build -t ghcr.io/harri-llewelyn/aber/supabase-db:$V -f supabase/db/Dockerfile supabase/db
```

## Why an image of our own

**`archive_command` runs inside the server's container**, and so does `restore_command` during
recovery. The pinned `supabase/postgres` ships no archiver: no pgBackRest, no WAL-G, no Barman, only
`pg_basebackup`. So the archiver has to be in the server's image, as it is in the historian's
(`timescaledb/Dockerfile`).

**The chart runs this image whether or not physical backup is on**, as it runs the historian's.
Turning backup on is then a values change and a restart, not a change of image. `supabaseDb.image`
stays the upstream pin: it is what this image is built `FROM`, and the `psql` and `pg_dump` client
the chart's Jobs and init containers run. check-docs-drift check 18 holds this `FROM` to that tag.

**pgBackRest is Alpine's package, at the historian's version.** The base is Alpine 3.23, the same
release the historian's base is on, and both images install `pgbackrest-2.57.0-r0` from its
community repository. One version writes both stanzas of the shared repository. A future base can
move one image to another 2.x before the other. That is safe, because pgBackRest keeps every file
of a stanza under the stanza's own name (`archive/<stanza>`, `backup/<stanza>`), and each stanza is
written only by its own database's pod. The package pulls Alpine's `postgresql18` as a dependency.
The server and every client on `PATH` stay the base's PostgreSQL 17, from its Nix profile, which
comes first on `PATH`.

**`gosu` comes from Alpine, and the base's is removed.** The upstream entrypoint uses it to drop
from root to `postgres`. The base's `/usr/local/bin/gosu` carried a stale Go toolchain, which is
why `backup-service` and `db-init` remove it (#347).

## Why tini is PID 1

Asynchronous `archive-push` forks a process that outlives the `archive_command` that started it.
Orphaned, it is adopted by PID 1. When the postmaster is PID 1 it reaps it, and an exit code other
than 0 or 1 reads to it as a crashed backend: it terminates every connection and runs crash
recovery. The historian found this on its own image (`timescaledb/Dockerfile`).

Measured on this image with a repository the server can read and not write, so that every
asynchronous push fails after `archive.info` was read:

| PID 1 | Three failing pushes |
| :--- | :--- |
| The base image's entrypoint, so the postmaster | `server process (PID 259) exited with exit code 103`, then `terminating any other active server processes`, `all server processes terminated; reinitializing` and `database system was interrupted` |
| `tini` | No crash. `pg_stat_archiver.failed_count` rises, and `last_archived_time` moves again once the repository is writable |

`tini` also passes the stop signal on to the server: the base image's `SIGINT`, a fast shutdown.

## What the chart adds around the image

- **The stanza is `platform`**, in the repository `timescaledb.physicalBackup.repo` describes, so a
  site configures one destination. On `s3` both stanzas share the bucket and the path. On `posix`
  the platform database has a claim of its own (`<release>-platform-backup`), because a
  ReadWriteOnce volume cannot be mounted by both database pods.
- **The spool is an `emptyDir`.** The historian keeps its spool on its data volume beside the data
  directory. Here the data directory is the volume's mount point
  (`supabase/postgres` hard-codes `data_directory`), so a spool there would be inside it. An
  `emptyDir` is enough: asynchronous `archive-push` writes only its acknowledgements to the spool,
  and reads the segments themselves from `pg_wal`. A lost acknowledgement means one segment is pushed
  again, and pgBackRest accepts a segment already in the repository with the same checksum.
- **`hot_standby=on` while backup is on.** The image's `wal-g.conf` sets it off. A server recovering
  to a moment then refuses every connection until it promotes. The startup probe gives the server
  five minutes before the kubelet restarts it, so a long replay would be cut short and started
  again. With `hot_standby` on, the server answers read-only once it is consistent, and the probes
  pass while it replays.
- **`wal_compression` is `supabaseDb.walCompression`**, `lz4` by default as on the historian. It is a
  server flag (`-c`), so `ALTER SYSTEM` cannot override it. Measuring the other setting needs a
  restart with the value changed.
- **The server container keeps six capabilities.** The upstream entrypoint starts as root: it
  `chown`s the data and socket directories (`CHOWN`), walks and `chmod`s directories `postgres`
  already owns (`DAC_OVERRIDE`, `FOWNER`), and `gosu` drops to `postgres` (`SETUID`, `SETGID`).
  `tini` stays root and forwards the stop signal to the server (`KILL`). Measured: the server
  starts on an empty root-owned volume with the first five and `no-new-privileges`, and after the
  drop the postmaster's effective set is empty (`CapEff: 0`). Without `KILL`, `docker stop` ends
  in `[FATAL tini (1)] Unexpected error when forwarding signal: 'Operation not permitted'` and the
  server is killed. With it, the server logs `received fast shutdown request` and exits 0.
- **The sidecar runs as `postgres` (100:101) with no capabilities.** A backup reads the data
  directory, which that user owns, and connects over the shared socket directory as
  `supabase_admin`, the image's superuser, whom its `pg_hba` trusts on the socket. `postgres` is not
  a superuser in this image.

## What records the runs

Migration `0173` gives the platform database the historian's record
(`timescaledb/physical_backup.sql`), under the same names and with the same function bodies:
`physical_backup_runs`, `physical_backup_schedule`, `physical_backup_record()`,
`physical_backup_missed_slot()`, `physical_backup_type()` and `physical_backup_record_schedule()`.
The sidecar's schedule is the historian's, and `scripts/check-mirror-drift.mjs` holds the two copies
of the rules equal, so the Backups page's one copy (`frontend/src/utils/historianBackupSchedule.js`)
is right for both.

- **The sidecar waits for them.** db-init creates them after the server is up, and a backup taken
  before them would be missing from the table the alert reads.
- **The exporter reads the runs as `pg_monitor`.** The table is in `public`, so RLS is on, and a
  policy lets `pg_monitor` read it. `metrics_reader` holds that role. Nothing is granted to `anon`,
  `authenticated` or `service_role`.
- **The Backups page reads `platform_backup_state()`**, Administrator only. It returns the columns
  `historian_backup_state()` returns, without the request, so one rule reads both.
- **No requests table.** The historian's sidecar also takes a differential when the Backups page asks
  for a backup, because the logical dump skips the historian while pgBackRest backs it up. The dump
  never skips the platform database, so **Take a backup** already backs it up.

## A restore carries the Vault key

pgsodium's root key is a file in the data directory (`pgsodium_root.key`, written by the chart's
`pgsodium_getkey.sh`), and pgBackRest backs up every file there. So a physical restore brings the
key back with the rows it encrypts, and `scripts/restore-platform-db.mjs` needs none of the key step
a logical restore needs (`scripts/restore-databases.sh`, step 5). The script checks that Vault
decrypts anyway.

The flip side: the repository holds the root key. On `s3` every file is encrypted with
`REPO_CIPHER_PASS` before it leaves the pod. A `posix` repository holds it in the clear, as the
backup service's volume already does beside each dump.

Measured locally on this image (posix repository, the sidecar's own script): seed a table and a
Vault secret, take a base backup, write a row, mark the moment, write another, empty the data volume,
restore to the mark. The first row came back and the second did not. The secret decrypted to its
plaintext under the restored key, and the server promoted onto timeline 2. On a 23 MB database the
restore took 6 s and recovery 4 s. The cluster rehearsal is
`scripts/rehearse-platform-restore.mjs` ([`test-harness/README.md`](../../test-harness/README.md),
*Restoring the platform database*).

**Realtime's replication slot is not in the backup.** PostgreSQL leaves `pg_replslot` out of a base
backup by design. So the restore script restarts `supabase-realtime`, which makes its slot again.

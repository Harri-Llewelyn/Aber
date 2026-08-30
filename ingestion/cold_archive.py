#!/usr/bin/env python3
"""
Cold telemetry archival — export a chunk, verify it, and only then let it be dropped.

Roadmap item 3. Run on demand or from a scheduler:

    python -m cold_archive --dry-run     # what would be exported, and nothing else
    python -m cold_archive               # export, verify, record; drop nothing
    python -m cold_archive --drop        # ... and drop the chunks that verification cleared

=================================================================================================
WHAT THIS REPLACES, STATED AS IT ACTUALLY IS

`timescaledb/retention.sql` adds a TimescaleDB retention policy that DROPS raw chunks older than
TIMESCALE_RETAIN_FOR. That is a permanent deletion of plant history, run by a background job, with
nothing written down about what went.

This turns `delete` into `move`. The ordering is the entire feature:

    claim -> export -> upload -> VERIFY -> record -> drop

and it is enforced in three independent places, deliberately:

  * `telemetry_archive_manifest` CHECK constraints refuse to RECORD a drop that was not verified;
  * `cold_tier_droppable()` is the only supported source of what may be dropped, so this file
    cannot assemble its own list;
  * `--drop` is opt-in, so the destructive half never happens as a side effect of an export.

=================================================================================================
WHY DROPPING IS A SEPARATE FLAG RATHER THAN THE END OF THE SAME RUN

Because the two halves fail differently. An export that fails costs a retry. A drop that happens
against an object which is not really readable costs the data. Splitting them means the normal
cadence -- export nightly, drop weekly once somebody has seen the catalogue -- is the default
rather than something an operator has to construct.

Chunks stay in BOTH places until then, which is the only safe intermediate state.

=================================================================================================
TWO DATABASES, ON PURPOSE

The manifest and the chunks live on the historian; the settings and the object storage belong to
the platform. There is no transaction spanning both and there cannot be, so every write here is
ordered so that a crash leaves a state the next run can resolve:

  * a claimed row with no object -> re-exported next run (object is overwritten, upsert)
  * an exported row that was never verified -> re-verified next run
  * a verified row not yet dropped -> data in both places, which is safe

The one state that must never exist is `dropped` without a readable object, and that is what the
CHECK constraint and `cold_tier_droppable()` exist to prevent.
"""
import argparse
import io
import os
import sys
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras

# The daemon's own configuration, reused rather than re-declared: this runs in the same image and
# must reach the same historian and the same storage identity. Importing it also means a change to
# the connection logic cannot leave this file behind.
from ingestion import (  # noqa: E402
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_INGESTION_KEY,
    _connect_timescaledb,
)

DEFAULT_TIER_AFTER_DAYS = 90
DEFAULT_BUCKET = "telemetry-archive"


def log(message):
    print(f"[cold-archive] {message}", flush=True)


# -------------------------------------------------------------------------------------------------
# Settings
# -------------------------------------------------------------------------------------------------
def _storage_client():
    """
    A storage client that authenticates AS THE DAEMON.

    Same construction as capture_worker._storage_client(), and for the same reason its docstring
    records at length: `create_client(url, anon).storage` keeps the anon key it was built with, so
    the obvious approach uploads as `anon` and fails against a bucket that admits the ingestion
    principal -- an RLS refusal that names RLS and is really about identity.
    """
    from storage3 import create_client as create_storage_client

    return create_storage_client(
        SUPABASE_URL.rstrip("/") + "/storage/v1/",
        {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": "Bearer " + (SUPABASE_INGESTION_KEY or SUPABASE_ANON_KEY),
        },
        is_async=False,
    )


def read_settings():
    """
    The `archive.*` keys, read from the platform database over PostgREST.

    FALLING BACK RATHER THAN FAILING, which is `0031`'s contract: "An absent row, an unreadable
    table, or a database that has not run 0031 all mean use the compiled-in default." A stack whose
    settings read fails should behave as it did before settings existed -- and here the compiled-in
    default is `enabled = false`, so the failure mode of not being able to read the configuration
    is doing nothing at all.
    """
    settings = {
        "enabled": False,
        "tier_after_days": DEFAULT_TIER_AFTER_DAYS,
        "bucket": DEFAULT_BUCKET,
    }
    try:
        from supabase import create_client

        client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
        client.postgrest.auth(SUPABASE_INGESTION_KEY or SUPABASE_ANON_KEY)
        rows = (
            client.table("system_settings")
            .select("key,value")
            .like("key", "archive.%")
            .execute()
            .data
            or []
        )
        by_key = {r["key"]: r["value"] for r in rows}
        if "archive.enabled" in by_key:
            settings["enabled"] = bool(by_key["archive.enabled"])
        if "archive.tier_after_days" in by_key:
            settings["tier_after_days"] = int(by_key["archive.tier_after_days"])
        if "archive.bucket" in by_key:
            settings["bucket"] = str(by_key["archive.bucket"])
    except Exception as err:  # noqa: BLE001 - see the docstring
        log(f"could not read archive.* settings ({err}); using compiled-in defaults")
    return settings


# -------------------------------------------------------------------------------------------------
# Export
# -------------------------------------------------------------------------------------------------
def object_key_for(chunk_name, range_start):
    """
    `year=YYYY/month=MM/<chunk>.parquet` — Hive-style partitioning, which is not decoration.

    DuckDB, Spark and Arrow all read those directory names as columns, so `WHERE year = 2026` can
    skip whole prefixes without opening a file. That is the property query-in-place depends on, and
    it has to be decided now: the layout is baked into every object the moment one is written, and
    changing it later means either rewriting the archive or teaching every reader two schemes.
    """
    return f"year={range_start.year:04d}/month={range_start.month:02d}/{chunk_name}.parquet"


def export_chunk(conn, chunk_schema, chunk_name):
    """
    Read one chunk into a Parquet buffer, returning (bytes, row_count).

    READ FROM THE CHUNK DIRECTLY rather than from `telemetry` filtered by time. A time filter would
    depend on the planner choosing chunk exclusion, and a chunk boundary that did not line up with
    the predicate would silently export the wrong rows -- either missing some or duplicating rows
    that belong to a neighbour. The chunk is the unit being dropped, so it must also be the unit
    being read.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(f'SELECT * FROM "{chunk_schema}"."{chunk_name}"')
        rows = cur.fetchall()

    if not rows:
        # A chunk with no rows is still a chunk, and it is still occupying a manifest row. Writing
        # an empty Parquet file keeps the catalogue honest -- "this range held nothing" is an answer
        # -- and keeps the verification path uniform rather than special-casing zero.
        table = pa.table({})
    else:
        columns = {key: [r[key] for r in rows] for key in rows[0].keys()}
        table = pa.table(columns)

    buffer = io.BytesIO()
    # ZSTD over the default SNAPPY: telemetry is extremely repetitive down a column (one asset id,
    # one metric name, a slowly-varying float), which is exactly the shape zstd exploits, and these
    # objects are written once and read rarely so decompression speed is the cheap axis to trade.
    pq.write_table(table, buffer, compression="zstd")
    return buffer.getvalue(), len(rows)


def verify_object(storage, bucket, key, expected_rows, expected_bytes):
    """
    Download the object back and confirm it is what was recorded.

    A READ-BACK, NOT A RESPONSE CODE. The upload returning 200 says the request was accepted; it
    does not say the bytes are retrievable, that the bucket kept them, or that RLS will let this
    identity read them again. `verified_at` is the column the CHECK constraint keys the whole drop
    on, so it has to mean something a 200 does not.

    THE ROW COUNT IS RE-READ FROM THE PARQUET FOOTER rather than trusting the length recorded at
    write time. That is what catches a truncated upload: the bytes arrive, the object exists, and
    the footer says a different number.
    """
    import pyarrow.parquet as pq

    payload = storage.from_(bucket).download(key)
    if len(payload) != expected_bytes:
        return False, f"downloaded {len(payload)} bytes, expected {expected_bytes}"

    try:
        parquet = pq.ParquetFile(io.BytesIO(payload))
        actual_rows = parquet.metadata.num_rows
    except Exception as err:  # noqa: BLE001
        return False, f"object is not readable as Parquet: {err}"

    if actual_rows != expected_rows:
        return False, f"object holds {actual_rows} rows, manifest says {expected_rows}"
    return True, None


# -------------------------------------------------------------------------------------------------
# The run
# -------------------------------------------------------------------------------------------------
def archive(conn, storage, bucket, tier_after_days, dry_run):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM public.cold_tier_candidates(%s::interval)",
            (f"{tier_after_days} days",),
        )
        candidates = cur.fetchall()

    if not candidates:
        log(f"no chunks are fully older than {tier_after_days} days; nothing to export")
        return 0

    log(f"{len(candidates)} chunk(s) eligible")
    if dry_run:
        for c in candidates:
            log(f"  would export {c['chunk_name']}  {c['range_start']} .. {c['range_end']}")
        return 0

    exported = 0
    for c in candidates:
        name = c["chunk_name"]
        key = object_key_for(name, c["range_start"])
        try:
            payload, row_count = export_chunk(conn, c["chunk_schema"], name)

            # CLAIMED BEFORE THE UPLOAD, so a crash mid-upload leaves a row an operator can see
            # rather than an orphan object nothing references. The candidate list excludes claimed
            # chunks, so this is also what stops two concurrent runs exporting the same chunk twice.
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.telemetry_archive_manifest
                        (chunk_schema, chunk_name, range_start, range_end, row_count, object_key)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (chunk_schema, chunk_name) DO UPDATE
                       SET row_count = EXCLUDED.row_count,
                           object_key = EXCLUDED.object_key,
                           last_error = NULL
                    """,
                    (c["chunk_schema"], name, c["range_start"], c["range_end"], row_count, key),
                )
            conn.commit()

            # `upsert` because a previous attempt may have uploaded and then failed verification.
            # Refusing to overwrite would strand the chunk: its manifest row already exists, so the
            # candidate list will never offer it again.
            storage.from_(bucket).upload(
                key,
                payload,
                {"content-type": "application/vnd.apache.parquet", "upsert": "true"},
            )

            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE public.telemetry_archive_manifest
                          SET exported_at = now(), object_bytes = %s
                        WHERE chunk_schema = %s AND chunk_name = %s""",
                    (len(payload), c["chunk_schema"], name),
                )
            conn.commit()

            ok, reason = verify_object(storage, bucket, key, row_count, len(payload))
            if not ok:
                raise RuntimeError(f"verification failed: {reason}")

            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE public.telemetry_archive_manifest
                          SET verified_at = now(), last_error = NULL
                        WHERE chunk_schema = %s AND chunk_name = %s""",
                    (c["chunk_schema"], name),
                )
            conn.commit()

            exported += 1
            log(f"  exported and verified {name} -> {key} ({row_count} rows, {len(payload)} bytes)")

        except Exception as err:  # noqa: BLE001
            # RECORDED, NOT RAISED. One unexportable chunk must not stop the rest -- and the row is
            # left behind with its error rather than deleted, because a chunk that has been failing
            # for a week is precisely what an operator needs to see. Clearing `last_error` is how a
            # human asks for a retry.
            conn.rollback()
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE public.telemetry_archive_manifest
                          SET last_error = %s
                        WHERE chunk_schema = %s AND chunk_name = %s""",
                    (str(err)[:500], c["chunk_schema"], name),
                )
            conn.commit()
            log(f"  FAILED {name}: {err}")

    return exported


def drop_verified(conn):
    """
    Drop the chunks whose export has been verified.

    THE WHOLE DECISION IS IN THE DATABASE, and this function deliberately contains none of it.

    An earlier version of this file computed the verified prefix here and called drop_chunks()
    itself. That was wrong twice over. It duplicated a rule that already had a home beside the data
    it protects -- and it could not have worked anyway, because roles.sql revokes DELETE and
    TRUNCATE on telemetry from ingest_writer on purpose: "the two that make append-only true".

    cold_tier_drop_verified() is SECURITY DEFINER, so the daemon may ASK for a drop the manifest
    has already verified while holding no privilege to delete a telemetry row of its own choosing.
    It stamps the manifest and drops the chunks in ONE transaction, so the state this file cannot
    produce is rows gone with no record of where they went.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM public.cold_tier_drop_verified()")
        dropped = cur.fetchall()
    conn.commit()

    if not dropped:
        log("nothing was dropped: no verified chunk is the oldest surviving one.")
        log("drop_chunks works on a time boundary, so a verified chunk sitting behind an")
        log("unarchived older one cannot be removed without taking that one too.")
        return 0

    for row in dropped:
        log(f"  dropped {row['dropped_chunk']}; its rows now exist only as {row['object_key']}")
    return len(dropped)


def main():
    parser = argparse.ArgumentParser(description="Export cold telemetry chunks to Parquet.")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would be exported and change nothing")
    parser.add_argument("--drop", action="store_true",
                        help="also drop chunks whose export has been verified")
    parser.add_argument("--force", action="store_true",
                        help="run even when archive.enabled is off")
    args = parser.parse_args()

    settings = read_settings()
    if not settings["enabled"] and not args.force:
        log("archive.enabled is off; nothing to do.")
        log("Turn it on under Settings > Cold Storage, or pass --force for a one-off run.")
        return 0

    log(f"bucket={settings['bucket']} tier_after_days={settings['tier_after_days']}")

    conn = _connect_timescaledb()
    try:
        storage = _storage_client()
        archive(conn, storage, settings["bucket"], settings["tier_after_days"], args.dry_run)
        if args.drop and not args.dry_run:
            drop_verified(conn)
        elif args.drop:
            log("--drop ignored with --dry-run")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

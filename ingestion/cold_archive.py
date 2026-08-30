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
import csv
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


# -------------------------------------------------------------------------------------------------
# Query in place
# -------------------------------------------------------------------------------------------------
def parse_instant(text, what):
    """
    An ISO date or timestamp from the command line, as an aware datetime.

    PARSED HERE RATHER THAN BOUND AS A STRING, and the reason is a real failure: DuckDB refuses to
    compare TIMESTAMP WITH TIME ZONE against VARCHAR, so passing the text straight through produced
    a `Binder Error ... an explicit cast is required` AFTER the objects had already been downloaded.
    Parsing first turns a mistyped date into an immediate, readable refusal instead of a database
    error at the end of a fetch.

    A BARE DATE MEANS MIDNIGHT UTC. Telemetry is stored in UTC and `--from 2026-04-01` obviously
    means the start of that day; guessing the host's local zone would silently shift a query by
    hours depending on where it was run.
    """
    value = (text or "").strip()
    try:
        # `date` alone has no time part; fromisoformat handles both once the shorthand is expanded.
        parsed = datetime.fromisoformat(value if "T" in value or " " in value else value + "T00:00:00")
    except ValueError:
        raise SystemExit(
            f"[cold-archive] {what} is not an ISO date or timestamp: {text!r}\n"
            f"[cold-archive] expected e.g. 2026-04-01 or 2026-04-01T09:30:00+00:00"
        )
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def objects_covering(conn, start, end):
    """
    The archived objects whose span overlaps [start, end), from the manifest.

    THIS IS WHY `range_start` AND `range_end` ARE STORED, and it is where "query in place" gets its
    economy. A year of archive is a year of objects; a question about one March should read one of
    them. The manifest answers which without opening any, so the pruning happens before a single
    byte is fetched.

    OVERLAP, NOT CONTAINMENT: `range_start < end AND range_end > start`. A chunk covering the last
    week of March and the first of April is relevant to a question about either, and testing
    containment would silently drop exactly the boundary data somebody asking about a month change
    is usually looking for.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """SELECT chunk_name, object_key, range_start, range_end, row_count,
                      verified_at IS NOT NULL AS verified
                 FROM public.telemetry_archive_manifest
                WHERE object_key IS NOT NULL
                  AND range_start < %s
                  AND range_end   > %s
                ORDER BY range_start""",
            (end, start),
        )
        return cur.fetchall()


def query_archive(conn, storage, bucket, start, end, asset=None, metric=None, limit=50, out_csv=None):
    """
    Answer one question from cold storage.

    DOWNLOADED, THEN QUERIED, AND THAT IS A LIMITATION WORTH NAMING rather than hiding. DuckDB can
    range-read Parquet over HTTP and fetch only the row groups a query touches -- but on Compose the
    objects sit behind storage-api with STORAGE_BACKEND=file, not an S3 endpoint DuckDB can address,
    so this pulls each relevant object whole. The manifest pruning above is what keeps that
    reasonable: it is whole OBJECTS, not the whole archive. Pointing storage at real S3 makes this a
    range scan with no change to the SQL below.

    ONLY VERIFIED OBJECTS ARE READ. An `exported` row has an object nothing has read back, and a
    `failed` one may hold a truncated upload. This answers questions about history, where a partial
    result that looks complete is worse than a refusal -- so anything skipped is named.
    """
    import tempfile

    import duckdb

    covering = objects_covering(conn, start, end)
    if not covering:
        log(f"no archived objects cover {start} .. {end}")
        log("Either that span was never archived, or it is still in the hypertable. This command")
        log("reads COLD storage only, and says so rather than returning an empty result set.")
        return 0

    usable = [o for o in covering if o["verified"]]
    for o in (o for o in covering if not o["verified"]):
        log(f"  SKIPPED {o['chunk_name']}: exported but not verified, so it may be incomplete")
    if not usable:
        log("every object covering that span is unverified; refusing to answer from them.")
        return 1

    # WHAT THE ANSWER ACTUALLY COVERS, SAID BEFORE THE ANSWER. A question spanning cold and hot
    # storage gets only the cold half from here, and a result set that looked complete would be the
    # most misleading thing this command could produce.
    covered_from = min(o["range_start"] for o in usable)
    covered_to = max(o["range_end"] for o in usable)
    log(f"{len(usable)} object(s) cover {covered_from} .. {covered_to}")

    with tempfile.TemporaryDirectory(prefix="cold-archive-") as tmp:
        paths = []
        for o in usable:
            payload = storage.from_(bucket).download(o["object_key"])
            path = os.path.join(tmp, o["chunk_name"] + ".parquet")
            with open(path, "wb") as fh:
                fh.write(payload)
            paths.append(path)
            log(f"  fetched {o['object_key']} ({len(payload)} bytes)")

        # PARAMETERISED, INCLUDING THE FILE LIST. `read_parquet` takes a list, and the filters are
        # bound rather than interpolated -- an asset id or metric name arriving from a shell is
        # untrusted text, and this is the only place in the file that builds SQL from an argument.
        clauses = ["time >= ?", "time < ?"]
        params = [paths, start, end]
        if asset:
            clauses.append("asset_id = ?")
            params.append(asset)
        if metric:
            clauses.append("metric_name = ?")
            params.append(metric)
        where = " AND ".join(clauses)

        sql = (
            "SELECT time, asset_id, metric_name, val_double, val_string, val_bool "
            "FROM read_parquet(?) "
            "WHERE " + where + " ORDER BY time"
        )

        db = duckdb.connect()
        try:
            total = db.execute("SELECT count(*) FROM (" + sql + ")", params).fetchone()[0]
            log(f"{total} row(s) match")

            if out_csv:
                # WRITTEN FROM PYTHON RATHER THAN WITH `COPY ... TO`, and not by preference.
                # DuckDB's COPY takes a literal destination and refuses a bound parameter -- so the
                # only way to use it is to interpolate the path into SQL, which is the one thing
                # this function claims not to do with an argument. Streaming it out here keeps that
                # true and costs nothing.
                #
                # FETCHED IN BATCHES, because the whole point of the archive is that a chunk can be
                # large. `fetchall()` on a month of a busy plant would hold it all in memory to
                # write it out a row at a time anyway.
                db.execute(sql, params)
                written = 0
                with open(out_csv, "w", newline="", encoding="utf-8") as fh:
                    writer = csv.writer(fh)
                    writer.writerow(
                        ["time", "asset_id", "metric_name", "val_double", "val_string", "val_bool"]
                    )
                    while True:
                        batch = db.fetchmany(10_000)
                        if not batch:
                            break
                        writer.writerows(batch)
                        written += len(batch)
                log(f"{written} row(s) written to {out_csv}")
                return 0

            rows = db.execute(sql + " LIMIT " + str(int(limit)), params).fetchall()
            if not rows:
                return 0
            print()
            print(f"{'time':<28} {'asset_id':<26} {'metric':<24} value")
            for r in rows:
                value = r[3] if r[3] is not None else (r[4] if r[4] is not None else r[5])
                print(f"{str(r[0]):<28} {str(r[1]):<26} {str(r[2]):<24} {value}")
            if total > len(rows):
                print()
                log(f"showing {len(rows)} of {total}; raise --limit or use --csv for all of them")
        finally:
            db.close()

    return 0


def main():
    parser = argparse.ArgumentParser(description="Export and query cold telemetry.")
    # A POSITIONAL WITH A DEFAULT, so every existing invocation keeps working: `cold_archive`,
    # `cold_archive --drop` and `cold_archive --dry-run` all still mean the export path.
    parser.add_argument("command", nargs="?", default="archive", choices=["archive", "query"],
                        help="archive (default) exports chunks; query reads them back")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would be exported and change nothing")
    parser.add_argument("--drop", action="store_true",
                        help="also drop chunks whose export has been verified")
    parser.add_argument("--force", action="store_true",
                        help="run even when archive.enabled is off")
    parser.add_argument("--from", dest="start", help="query: ISO start of the range, inclusive")
    parser.add_argument("--to", dest="end", help="query: ISO end of the range, exclusive")
    parser.add_argument("--asset", help="query: restrict to one asset_id")
    parser.add_argument("--metric", help="query: restrict to one metric_name")
    parser.add_argument("--limit", type=int, default=50, help="query: rows to print (default 50)")
    parser.add_argument("--csv", dest="out_csv", help="query: write all matching rows to this file")
    args = parser.parse_args()

    settings = read_settings()
    conn = _connect_timescaledb()
    try:
        storage = _storage_client()

        if args.command == "query":
            # NO `archive.enabled` CHECK. That setting governs whether telemetry is EXPORTED and has
            # nothing to say about reading what was already archived. Refusing a traceability
            # question because somebody turned future archiving off would be the setting reaching
            # well past what it means.
            if not args.start or not args.end:
                log("query needs --from and --to, e.g. --from 2026-04-01 --to 2026-05-01")
                return 2
            return query_archive(
                conn, storage, settings["bucket"],
                parse_instant(args.start, "--from"), parse_instant(args.end, "--to"),
                asset=args.asset, metric=args.metric, limit=args.limit, out_csv=args.out_csv,
            )

        if not settings["enabled"] and not args.force:
            log("archive.enabled is off; nothing to do.")
            log("Turn it on under Settings > Cold Storage, or pass --force for a one-off run.")
            return 0

        log(f"bucket={settings['bucket']} tier_after_days={settings['tier_after_days']}")
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

#!/usr/bin/env python3
"""
Cold telemetry archival — export a chunk, verify it, and only then let it be dropped.

Run on demand or from a scheduler:

    python -m cold_archive --dry-run     # what would be exported, and nothing else
    python -m cold_archive               # export, verify, record; drop nothing
    python -m cold_archive --drop        # ... and drop the chunks that verification cleared

THE ORDERING IS THE ENTIRE FEATURE, and nothing here may shorten it:

    claim -> export -> upload -> VERIFY -> record -> drop

It is enforced in three independent places rather than by a careful sequence in this file:
`telemetry_archive_manifest`'s CHECK constraints refuse to RECORD a drop that was not verified;
`cold_tier_droppable()` is the only supported source of what may be dropped, so this file cannot
assemble its own list; and `--drop` is opt-in, so the destructive half never happens as a side
effect of an export. Chunks stay in BOTH places until then, which is the only safe intermediate
state.

THE DESTINATION IS SOMEWHERE ELSE, AND ONLY SOMEWHERE ELSE. Objects go to a configured S3 endpoint:
no filesystem path, no bucket in this cluster, no local fallback. Every object is addressed under
`site=<site_key>/`, which is what makes one bucket safe for several sites and what an IAM policy is
scoped on -- see object_key_for().

TWO DATABASES AND A THIRD PARTY, WITH NO TRANSACTION SPANNING THEM. The manifest and the chunks are
on the historian, the settings belong to the platform, and the objects are at another provider under
a credential this stack cannot mint, rotate or revoke. So every write is ordered so that a crash
leaves a state the next run can resolve:

  * a claimed row with no object -> re-exported next run (object is overwritten, upsert)
  * an exported row that was never verified -> re-verified next run
  * a verified row not yet dropped -> data in both places, which is safe

The one state that must never exist is `dropped` without a readable object, and that is what the
CHECK constraint and `cold_tier_droppable()` exist to prevent.

Related: supabase/README.md -> "Cold telemetry archival" (what this replaces, why dropping is a
         separate flag, why the manifest lives on the historian, and the settings this reads).
"""
import argparse
import base64
import csv
import hashlib
import io
import os
import sys
import time
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
import psycopg2.sql

# The daemon's own configuration, reused rather than re-declared: this runs in the same image and
# must reach the same historian and the same platform identity. Importing it also means a change to
# the connection logic cannot leave this file behind.
from ingestion import (  # noqa: E402
    SUPABASE_URL,
    SUPABASE_GATEWAY_KEY,
    SUPABASE_INGESTION_KEY,
    _connect_timescaledb,
)

DEFAULT_TIER_AFTER_DAYS = 14

# The layout version in every object key. It changes only if the key shape or the exported column
# set has to change incompatibly: new objects go to v=2 and readers of v=1 keep working, so nothing
# already written is ever rewritten.
ARCHIVE_LAYOUT_VERSION = "1"


def log(message):
    print(f"[cold-archive] {message}", flush=True)


# -------------------------------------------------------------------------------------------------
# Settings
# -------------------------------------------------------------------------------------------------
def s3_config():
    """
    The destination, read from the platform database as the daemon's own principal.

    FROM THE DATABASE RATHER THAN THE ENVIRONMENT, because an operator configures this from the
    Cold Storage page (`0134`) and a container reads its environment once, at start. A destination
    in the environment could only be changed by a redeploy, which is what made this feature cost a
    `helm upgrade` to turn on.

    ONE CALL, `cold_archive_destination()`, which is SECURITY DEFINER and returns a row to the
    ingestion principal alone. The endpoint, region, bucket, key id and path style are settings an
    Administrator can see; the secret comes out of the vault and is the one thing that never
    reaches a browser. A caller without that identity gets no row, so a misconfigured key fails as
    "not configured" rather than as a permission error about a function it should not know exists.

    A FOREIGN CREDENTIAL, NOT A DATABASE PRINCIPAL. We cannot mint, rotate or revoke a key at
    another provider -- the vault is where it is kept, not where it is issued.

    EVERY FIELD IS REQUIRED, INCLUDING THE ENDPOINT, which AWS would let us infer from the region.
    An inferred destination is one nobody states, and "somewhere else" is the entire property this
    feature has: the endpoint is written down so that reading the configuration tells you where a
    decade of plant history went.

    FALLING BACK TO NOTHING RATHER THAN FAILING, as read_settings() does: an unreadable database
    means "not configured", and every path that would write refuses on it and says which fields are
    missing.
    """
    empty = {
        "endpoint": "", "region": "", "bucket": "",
        "access_key": "", "secret_key": "", "path_style": False,
    }
    try:
        from supabase import create_client

        client = create_client(SUPABASE_URL, SUPABASE_GATEWAY_KEY)
        client.postgrest.auth(SUPABASE_INGESTION_KEY or SUPABASE_GATEWAY_KEY)
        rows = client.rpc("cold_archive_destination").execute().data or []
    except Exception as err:  # noqa: BLE001 - see the docstring
        log(f"could not read the archive destination ({err}); treating it as unconfigured")
        return empty

    row = (rows[0] if isinstance(rows, list) else rows) or {}
    return {
        "endpoint": (row.get("endpoint") or "").strip(),
        "region": (row.get("region") or "").strip(),
        "bucket": (row.get("bucket") or "").strip(),
        "access_key": (row.get("access_key_id") or "").strip(),
        "secret_key": row.get("secret_key") or "",
        # MinIO and most self-hosted gateways address buckets by path; AWS, R2 and B2 take the
        # virtual-host form. Getting this wrong fails as DNS resolution, which names nothing.
        "path_style": bool(row.get("path_style")),
    }


def unconfigured(config, site_key):
    """
    What is missing before anything can be written, as a list, or [] when the destination is ready.

    ONE REFUSAL FOR EVERY SUBCOMMAND, and it names all of the gaps rather than the first: an
    operator configuring this is usually setting five things at once, and a refusal that reveals
    one missing variable per run costs five runs.
    """
    missing = []
    # Named as the operator sees them on the Cold Storage page, not as the columns behind them: the
    # person reading this refusal is going to go and fill in a form.
    for field, name in (
        ("endpoint", "S3 endpoint"),
        ("region", "S3 region"),
        ("bucket", "S3 bucket"),
        ("access_key", "S3 access key ID"),
        ("secret_key", "the secret access key"),
    ):
        if not (config.get(field) or "").strip():
            missing.append(name)
    # The one field that is NOT set from the page: it is frozen at install because it is the IAM
    # prefix every object is already addressed under (0132).
    if not (site_key or "").strip():
        missing.append("the site key (values.yaml coldArchive.s3.siteKey, fixed at install)")
    return missing


def _s3_client(config):
    """
    A boto3 S3 client for the configured endpoint.

    SIGNATURE V4 AND AN EXPLICIT ADDRESSING STYLE, both stated rather than defaulted. v4 is what
    every current implementation expects and what the checksum headers below are signed under;
    addressing style is the one setting that differs between AWS and a MinIO in another building,
    which is precisely the pair this has to work against unchanged.

    RETRIES ARE THE LIBRARY'S. A remote destination turns each upload into a network operation with
    an outage window, and `standard` mode already backs off on the throttling and 5xx responses
    that a WAN produces. What it deliberately does not retry is a checksum rejection, which is not
    a transient condition.
    """
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=config["endpoint"],
        region_name=config["region"],
        aws_access_key_id=config["access_key"],
        aws_secret_access_key=config["secret_key"],
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if config["path_style"] else "virtual"},
            retries={"max_attempts": 5, "mode": "standard"},
        ),
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
        # No compiled-in default, unlike the two above: the site key addresses this site's objects
        # inside a bucket other sites may share, so a fallback would be a guess at identity. Empty
        # means unconfigured, and every path that would write refuses on it.
        "site_key": "",
        # Whether the values above came from the database. report_armed() acts only on a read.
        "read": False,
    }
    try:
        from supabase import create_client

        client = create_client(SUPABASE_URL, SUPABASE_GATEWAY_KEY)
        client.postgrest.auth(SUPABASE_INGESTION_KEY or SUPABASE_GATEWAY_KEY)
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
        if "archive.site_key" in by_key:
            settings["site_key"] = str(by_key["archive.site_key"] or "")
        settings["read"] = True
    except Exception as err:  # noqa: BLE001 - see the docstring
        log(f"could not read archive.* settings ({err}); using compiled-in defaults")
    return settings


def report_armed(conn, settings, dry_run):
    """
    Tell the historian whether archiving is on. Its retention job reads it: while archiving is on,
    only chunks this archive has verified may be dropped, so an outage grows the volume rather
    than deleting what was never exported.

    Only a setting actually read is reported. An unreadable one would fall back to `enabled =
    false` and switch that protection off, so the last report stands instead.
    """
    if dry_run or not settings.get("read"):
        return
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT public.cold_archive_report_armed(%s)", (settings["enabled"],))
        conn.commit()
    except psycopg2.Error as err:
        conn.rollback()
        log(f"could not report archive.enabled to the historian ({err}); its retention job "
            "keeps the last report")


# -------------------------------------------------------------------------------------------------
# Export
# -------------------------------------------------------------------------------------------------
def _stamp(instant):
    """One instant as `20260302T000000Z`: sortable, filename-safe, and unambiguous about its zone."""
    return instant.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def object_key_for(site_key, range_start, range_end):
    """
    `site=<key>/dataset=telemetry/v=1/year=YYYY/month=MM/<from>-<to>.parquet`

    Hive-style partitioning, which is not decoration: DuckDB, Spark and Arrow all read `key=value`
    directory names as columns, so `WHERE year = 2026` skips whole prefixes without opening a file.

    EACH SEGMENT IS LOAD-BEARING.

      * `site=` is leftmost because an IAM policy scopes on a left-anchored prefix. Anything to its
        left makes a per-site credential impossible to write. It also stops the collision a shared
        bucket invites: chunk numbering is per database, so two fresh installs both start at
        `_hyper_1_1_chunk`, and the upload overwrites without complaint.
      * `dataset=` leaves room for a rollup or a second hypertable without renaming what is written.
      * `v=` is the escape hatch, so an incompatible change never has to be made under pressure.
      * The leaf is the TIME RANGE, not the chunk name. `_hyper_1_42_chunk` is a TimescaleDB
        internal that says nothing to a human and does not survive a restore into a fresh database.
        A range sorts lexically, describes itself, and makes a retry produce the same key -- which
        is what keeps overwriting on retry correct rather than dangerous.

    THE MONTH BOUNDARY, WRITTEN DOWN BECAUSE IT SURPRISES READERS. `year=`/`month=` are derived from
    `range_start`, and chunks are 7 days (`timescaledb/init/001_schema.sql`), so around a dozen
    times a year a chunk straddles a month: one beginning 29 March holds April readings under
    `month=03`. The manifest is the authoritative index; the partitions are a convenience for a
    reader that does not have it, and such a reader must widen by one partition on each side.
    """
    start = range_start.astimezone(timezone.utc)
    return (
        f"site={site_key}/dataset=telemetry/v={ARCHIVE_LAYOUT_VERSION}/"
        f"year={start.year:04d}/month={start.month:02d}/"
        f"{_stamp(range_start)}-{_stamp(range_end)}.parquet"
    )


def site_prefix(site_key):
    """Everything this site has written, and the prefix an IAM policy is scoped on."""
    return f"site={site_key}/"


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
        cur.execute(psycopg2.sql.SQL("SELECT * FROM {}.{}").format(
            psycopg2.sql.Identifier(chunk_schema), psycopg2.sql.Identifier(chunk_name)))
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


class _S3RangeReader(io.RawIOBase):
    """
    A seekable file over an S3 object that fetches only the bytes it is asked for.

    WHAT IT EXISTS FOR. `pq.ParquetFile(f).metadata` seeks to the end and reads the footer, which
    pyarrow does as ONE ranged GET of the last 64 KiB whatever the object weighs -- measured at
    64 KiB to verify a 15.2 MiB object, 0.4% of it, against MinIO. Handed a whole downloaded
    payload it would do the same read against memory, after paying to move the object across a WAN.

    A small object is read whole, because 64 KiB is larger than it is. That is not a special case
    worth avoiding: it is already the cheapest possible read.
    """

    def __init__(self, s3, bucket, key, size):
        self._s3, self._bucket, self._key, self._size = s3, bucket, key, size
        self._pos = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self._pos

    def seek(self, offset, whence=io.SEEK_SET):
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._size}[whence]
        self._pos = max(0, min(base + offset, self._size))
        return self._pos

    def read(self, size=-1):
        if size is None or size < 0:
            size = self._size - self._pos
        size = min(size, self._size - self._pos)
        if size <= 0:
            return b""
        end = self._pos + size - 1
        body = self._s3.get_object(
            Bucket=self._bucket, Key=self._key, Range=f"bytes={self._pos}-{end}"
        )["Body"].read()
        self._pos += len(body)
        return body


def put_object(s3, bucket, key, payload):
    """
    Upload one object and have the store prove it received what was sent.

    `ChecksumSHA256` IS CHECKED BY THE STORE, NOT BY US. S3 recomputes the digest server-side and
    REJECTS the write if it disagrees, so a payload corrupted in flight never becomes an object at
    all. That is strictly more than a 200 could tell us, and it costs one header.

    Returns (etag, checksum) for the manifest. `object_etag` has existed since the table was
    created and has never been populated; this is what it was for.
    """
    # The precomputed digest alone, not `ChecksumAlgorithm` beside it: that parameter asks boto3 to
    # compute one and send it as a trailer, which is a second way of saying the same thing and one
    # more thing for a non-AWS implementation to disagree about.
    digest = base64.b64encode(hashlib.sha256(payload).digest()).decode("ascii")
    response = s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=payload,
        ContentType="application/vnd.apache.parquet",
        ChecksumSHA256=digest,
    )
    return (response.get("ETag") or "").strip('"'), digest


def verify_object(s3, bucket, key, expected_rows, expected_bytes, expected_checksum=None):
    """
    Confirm the stored object is what was recorded, without pulling it back.

    A READ-BACK, NOT A RESPONSE CODE. `verified_at` is the column the CHECK constraint keys the
    whole drop on -- the rows are deleted because this returned true -- so it has to mean something
    an accepted request does not: that the bytes are there, and retrievable, by this identity.

    CHEAPER AND STRICTER THAN THE DOWNLOAD IT REPLACES. A HEAD and one 64 KiB ranged read instead
    of the whole object over a metered link -- measured at 64 KiB to verify 15.2 MiB -- and it
    checks one thing more: the digest the store computed for itself, which catches a corruption the
    old read-back could not distinguish from a good copy.

    THE ROW COUNT IS RE-READ FROM THE PARQUET FOOTER rather than trusting the length recorded at
    write time. That is what catches a truncated upload -- the bytes arrive, the object exists, and
    the footer says a different number.
    """
    import pyarrow.parquet as pq

    try:
        head = s3.head_object(Bucket=bucket, Key=key, ChecksumMode="ENABLED")
    except Exception as err:  # noqa: BLE001
        return False, f"object is not retrievable: {err}"

    actual_bytes = int(head.get("ContentLength", -1))
    if actual_bytes != expected_bytes:
        return False, f"object is {actual_bytes} bytes, expected {expected_bytes}"

    # ABSENT IS NOT A MISMATCH. An S3 implementation that does not return the stored checksum has
    # still validated it on write, and the footer read below is the check that does not depend on
    # the store's feature set. A checksum that IS returned and differs is a hard failure.
    stored = head.get("ChecksumSHA256")
    if expected_checksum and stored and stored != expected_checksum:
        return False, f"stored checksum {stored} does not match the payload's {expected_checksum}"

    try:
        parquet = pq.ParquetFile(_S3RangeReader(s3, bucket, key, actual_bytes))
        actual_rows = parquet.metadata.num_rows
    except Exception as err:  # noqa: BLE001
        return False, f"object is not readable as Parquet: {err}"

    if actual_rows != expected_rows:
        return False, f"object holds {actual_rows} rows, manifest says {expected_rows}"
    return True, None


# -------------------------------------------------------------------------------------------------
# The run
# -------------------------------------------------------------------------------------------------
def archive(conn, s3, bucket, site_key, tier_after_days, dry_run):
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
        key = object_key_for(site_key, c["range_start"], c["range_end"])
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

            # OVERWRITING IS CORRECT HERE, and it is the key shape that makes it so. A previous
            # attempt may have uploaded and then failed verification; refusing to overwrite would
            # strand the chunk, because its manifest row already exists and the candidate list will
            # never offer it again. The key is derived from the chunk's time range, so a retry
            # addresses the same object -- which is what stops "overwrite" meaning another site's
            # data, as a chunk-numbered key in a shared bucket would.
            etag, checksum = put_object(s3, bucket, key, payload)

            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE public.telemetry_archive_manifest
                          SET exported_at = now(), object_bytes = %s, object_etag = %s
                        WHERE chunk_schema = %s AND chunk_name = %s""",
                    (len(payload), etag or None, c["chunk_schema"], name),
                )
            conn.commit()

            ok, reason = verify_object(s3, bucket, key, row_count, len(payload), checksum)
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
    # ASKED FIRST, SO THE "NOTHING HAPPENED" MESSAGE IS THE RIGHT ONE. Both cases return no rows
    # from cold_tier_drop_verified() and they mean opposite things: nothing is waiting, versus
    # something is waiting and is blocked behind an unarchived chunk. Reporting the second when the
    # manifest is simply empty describes a problem that is not happening -- which on a service that
    # logs this every pass is how a real blockage later gets read as normal.
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM public.cold_tier_droppable()")
        waiting = cur.fetchone()[0]

    if not waiting:
        log("no verified chunks are awaiting a drop")
        return 0

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM public.cold_tier_drop_verified()")
        dropped = cur.fetchall()
    conn.commit()

    if not dropped:
        log(f"{waiting} chunk(s) are verified but none was dropped: the oldest surviving chunk is")
        log("not among them. drop_chunks works on a time boundary, so a verified chunk sitting")
        log("behind an unarchived older one cannot be removed without taking that one too.")
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


def query_archive(conn, s3, bucket, start, end, asset=None, metric=None, limit=50, out_csv=None):
    """
    Answer one question from cold storage.

    DOWNLOADED, THEN QUERIED, AND THAT IS A LIMITATION WORTH NAMING rather than hiding. DuckDB's
    httpfs can range-read these objects where they lie and fetch only the row groups a query
    touches; this fetches each relevant object whole and reads it from a temporary directory.
    Issue #228 is that change. The manifest pruning above is what keeps the present behaviour
    reasonable: it is whole OBJECTS, not the whole archive.

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
            payload = s3.get_object(Bucket=bucket, Key=o["object_key"])["Body"].read()
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


# -------------------------------------------------------------------------------------------------
# Audit
# -------------------------------------------------------------------------------------------------
def audit(conn, s3, bucket, site_key):
    """
    Check that every object the manifest claims exists is still fetchable.

    THE FAILURE THIS EXISTS FOR IS A RECONFIGURATION, NOT A BUG. The destination is five variables
    and a credential, and changing any of them -- a bucket renamed, an endpoint repointed at a new
    provider, a site key that somebody edited in the database, a lifecycle rule that expired
    objects nobody meant to expire -- leaves every key looked for where it is not, while the
    manifest still reads `archived` and the raw rows are already gone from the hypertable. The
    catalogue goes on saying everything is fine.

    So the archive needs a way to be ASKED rather than assumed, and this is it. It is also the
    right check after migrating a bucket by hand: keys must land identically, because `object_key`
    is what points at them.

    HEAD, NOT GET. This walks the whole archive, and pulling every object to prove it exists would
    make the audit itself expensive enough to skip -- which on a metered link is how it stops being
    run.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """SELECT chunk_name, object_key, object_bytes, row_count,
                      dropped_at IS NOT NULL AS is_only_copy
                 FROM public.telemetry_archive_manifest
                WHERE object_key IS NOT NULL
                ORDER BY range_start"""
        )
        rows = cur.fetchall()

    manifest_keys = {r["object_key"] for r in rows}

    if not rows:
        # STILL CHECKS FOR ORPHANS. An empty manifest and a bucket full of objects is not "nothing
        # to audit" -- it is the most interesting state the bucket can be in, and returning early
        # here is what let four of them sit unnoticed.
        log("the manifest is empty.")
        return 1 if audit_orphans(s3, bucket, site_key, manifest_keys) else 0

    missing, checked = [], 0
    for r in rows:
        try:
            s3.head_object(Bucket=bucket, Key=r["object_key"])
            checked += 1
        except Exception as err:  # noqa: BLE001
            missing.append((r, str(err)[:160]))

    for r, err in missing:
        marker = "DATA LOST" if r["is_only_copy"] else "object gone"
        log(f"  {marker}: {r['chunk_name']} -> {r['object_key']} ({err})")

    orphans = audit_orphans(s3, bucket, site_key, manifest_keys)

    if not missing:
        log(f"{checked} object(s) present and readable.")
        return 1 if orphans else 0

    lost = [r for r, _ in missing if r["is_only_copy"]]
    log(f"{len(missing)} of {len(rows)} object(s) are unreachable.")
    if lost:
        rows_lost = sum(int(r["row_count"] or 0) for r in lost)
        log(f"{len(lost)} of those are the ONLY copy -- {rows_lost} row(s) of telemetry.")
        log("If the endpoint, the bucket or the site key was recently changed, the objects were")
        log("not migrated: copy them across preserving their keys exactly, then re-run this.")
        log("If the bucket has a lifecycle rule, check that it does not expire this prefix.")
    return 1


def audit_orphans(s3, bucket, site_key, manifest_keys):
    """
    Objects on storage that no manifest row references.

    THE DIRECTION `audit()` DOES NOT LOOK, and the gap was found by an operator opening the bucket
    rather than by any tooling here. audit() walks the manifest and asks storage about each row; an
    object with no row is invisible to it, because there is no row to start from.

    They are not harmless. An orphan is bytes nobody can reach through the catalogue and nobody can
    account for -- and the ones that prompted this were left by a test run whose manifest rows were
    cleaned up while the objects were not, which is exactly how a real one appears: a failed drop, an
    interrupted export, or a manifest restored from a backup older than the storage beside it.

    REPORTED, NEVER DELETED, and now that is the credential's position too rather than this file's
    restraint. The archive identity is scoped to PutObject and GetObject on this site's prefix with
    no DeleteObject (see the policy in supabase/README.md), so an orphan cannot be removed from
    here even by a caller who decided it should be. Naming them is the whole job; deciding is a
    person's, from a console.

    SCOPED TO THIS SITE'S PREFIX. A bucket may hold other sites, and every key outside
    `site=<key>/` belongs to a manifest this database has never seen -- listing them would report
    another plant's archive as this one's orphans.
    """
    prefix = site_prefix(site_key)
    keys = []
    try:
        # A paginator rather than one call: list_objects_v2 returns at most 1000 keys and an
        # archive of any age is larger, so a single page would report every key past the first
        # thousand as an orphan -- the loudest possible false alarm.
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
            keys.extend(obj["Key"] for obj in page.get("Contents", []))
    except Exception as err:  # noqa: BLE001
        log(f"could not list {prefix} to check for orphans ({err}); skipping that half.")
        return 0

    orphans = [k for k in keys if k not in manifest_keys]
    if not orphans:
        return 0

    log(f"{len(orphans)} object(s) on storage that no manifest row references:")
    for k in orphans:
        log(f"  orphan: {k}")
    log("Nothing points at these, so nothing will ever read them. They are NOT deleted here --")
    log("an Administrator can remove them once satisfied they hold nothing wanted.")
    return len(orphans)


# -------------------------------------------------------------------------------------------------
# Restore
# -------------------------------------------------------------------------------------------------
def restore(conn, s3, bucket, chunk_name):
    """
    Put an archived chunk's rows back into the hypertable.

    THE GAP THIS CLOSES. Everything else here moves data one way, and a feature whose premise is
    "your history is safe" has to be able to hand it back -- otherwise the archive is only readable
    through this one CLI, and Grafana, the dashboard and every other consumer stay blind to it
    forever.

    IT LEAVES THE OBJECT IN PLACE AND CLEARS `dropped_at`, which puts the row back in exactly the
    state it held between verification and the drop: data in BOTH places, `verified_at` still set.
    That is not a special case -- it is the safest state in the whole flow, `cold_tier_droppable()`
    already returns it, and `--drop` will therefore remove the chunk again with no further work. The
    round trip is closed rather than one-way-and-then-stuck.

    ON CONFLICT DO NOTHING, because `telemetry`'s primary key is (time, asset_id, metric_name) and a
    partial restore that was interrupted must be safe to run again. It also means restoring a chunk
    whose rows are somehow still present is a no-op rather than a duplicate-key failure.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """SELECT chunk_name, object_key, row_count, dropped_at, verified_at
                 FROM public.telemetry_archive_manifest
                WHERE chunk_name = %s""",
            (chunk_name,),
        )
        row = cur.fetchone()

    if row is None:
        log(f"no manifest row for {chunk_name}")
        return 1
    if row["dropped_at"] is None:
        log(f"{chunk_name} was never dropped; its rows are still in the hypertable.")
        return 0
    if not row["object_key"]:
        log(f"{chunk_name} has no object recorded; nothing to restore from.")
        return 1

    import pyarrow.parquet as pq

    payload = s3.get_object(Bucket=bucket, Key=row["object_key"])["Body"].read()
    table = pq.read_table(io.BytesIO(payload))
    log(f"read {table.num_rows} row(s) from {row['object_key']}")

    records = table.to_pylist()
    with conn.cursor() as cur:
        psycopg2.extras.execute_batch(
            cur,
            """INSERT INTO public.telemetry (time, asset_id, metric_name, val_double, val_string, val_bool)
               VALUES (%(time)s, %(asset_id)s, %(metric_name)s, %(val_double)s, %(val_string)s, %(val_bool)s)
               ON CONFLICT DO NOTHING""",
            records,
            page_size=1000,
        )
        # Back to the state between verification and the drop. The object stays: it is still a
        # verified copy, and deleting it here would trade one single point of failure for another.
        cur.execute(
            """UPDATE public.telemetry_archive_manifest
                  SET dropped_at = NULL
                WHERE chunk_name = %s""",
            (chunk_name,),
        )
    conn.commit()

    log(f"restored {chunk_name}; its rows are in the hypertable AND on cold storage.")
    log("`cold_archive --drop` will remove them again once you are done with them.")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Export, query, audit and restore cold telemetry.")
    # A POSITIONAL WITH A DEFAULT, so every existing invocation keeps working: `cold_archive`,
    # `cold_archive --drop` and `cold_archive --dry-run` all still mean the export path.
    parser.add_argument("command", nargs="?", default="archive",
                        choices=["archive", "query", "audit", "restore"],
                        help="archive (default) exports chunks; query reads them back; audit checks "
                             "every object is still fetchable; restore puts one chunk back")
    parser.add_argument("--chunk", help="restore: the chunk_name to put back")
    # THE SETTING FINALLY MEANS SOMETHING WITH THIS. `archive.enabled` armed a mechanism nothing
    # ran: an operator turned it on, opened the page and saw nothing, because the exporter is a CLI
    # and no scheduler existed. The chart's coldArchive CronJob runs it, so the switch is what decides
    # whether anything happens rather than a note about a command somebody has to remember.
    parser.add_argument("--loop", type=int, metavar="SECONDS",
                        help="archive: keep running, pausing this long between passes")
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
    config = s3_config()

    # There is no local destination to fall back to and deliberately so: an optional remote target
    # is one nobody tests, chosen at install by whoever wants fewest questions, and found worthless
    # on the day it matters. One destination type means one code path, exercised at every site.
    missing = unconfigured(config, settings["site_key"])

    def refuse_unconfigured():
        log("cold telemetry archival is not configured. Missing:")
        for name in missing:
            log(f"  {name}")
        log("Set them on the Cold Storage page as an Administrator. supabase/README.md,")
        log("'Cold telemetry archival', has the bucket policy the credential needs.")
        return 2

    # NOT CHECKED FOR THE ARCHIVE PATH YET, and that distinction is the difference between a
    # useful failure and a failed Job every night. The chart runs the CronJob by default while
    # `archive.enabled` defaults OFF, so an unconfigured destination is the ORDINARY state of a
    # stack that has not turned archiving on -- reporting it as an error would fail the Job at
    # 03:15 on every install that simply does not use the feature. The loop below refuses only
    # once something has actually asked for an export. Reading commands are different: they were
    # asked for explicitly, so there is nowhere to look and saying so is the answer.
    if args.command in ("query", "audit", "restore") and missing:
        return refuse_unconfigured()

    conn = _connect_timescaledb()
    try:
        s3 = None if missing else _s3_client(config)

        if args.command == "query":
            # NO `archive.enabled` CHECK. That setting governs whether telemetry is EXPORTED and has
            # nothing to say about reading what was already archived. Refusing a traceability
            # question because somebody turned future archiving off would be the setting reaching
            # well past what it means.
            if not args.start or not args.end:
                log("query needs --from and --to, e.g. --from 2026-04-01 --to 2026-05-01")
                return 2
            return query_archive(
                conn, s3, config["bucket"],
                parse_instant(args.start, "--from"), parse_instant(args.end, "--to"),
                asset=args.asset, metric=args.metric, limit=args.limit, out_csv=args.out_csv,
            )

        if args.command == "audit":
            # NOT GATED ON `archive.enabled` either, and for a sharper reason than query is: this is
            # the command that tells you whether archived history still exists. Refusing to run it
            # because archiving was switched off would withhold the answer exactly when somebody has
            # turned things off to investigate.
            return audit(conn, s3, config["bucket"], settings["site_key"])

        if args.command == "restore":
            if not args.chunk:
                log("restore needs --chunk, e.g. --chunk _hyper_1_39_chunk")
                log("`cold_archive audit` or the Cold Storage page lists the chunk names.")
                return 2
            return restore(conn, s3, config["bucket"], args.chunk)

        # Read once, outside the loop: the site key is read-only in the database and every object
        # already written is addressed under it, so a pass that picked up a different one would be
        # splitting the archive rather than following a setting.
        site_key = settings["site_key"]

        while True:
            # RE-READ EVERY PASS, so switching the setting off stops the next pass rather than
            # needing the container restarted. The switch on the Cold Storage page is the control.
            settings = read_settings()
            report_armed(conn, settings, args.dry_run)
            if not settings["enabled"] and not args.force:
                if args.loop is None:
                    log("archive.enabled is off; nothing to do.")
                    log("Turn it on from the Cold Storage page, or pass --force for a one-off run.")
                    return 0
                log("archive.enabled is off; waiting.")
            elif missing:
                # Archiving is ON and there is nowhere to put anything. Loud, and it stops: the
                # alternative is a stack that believes it is tiering history while the chunks age
                # towards a retention policy that will drop them.
                return refuse_unconfigured()
            else:
                log(
                    f"destination={config['endpoint']}/{config['bucket']}/{site_prefix(site_key)}"
                    f" tier_after_days={settings['tier_after_days']}"
                )
                archive(
                    conn, s3, config["bucket"], site_key,
                    settings["tier_after_days"], args.dry_run,
                )
                if args.drop and not args.dry_run:
                    drop_verified(conn)
                elif args.drop:
                    log("--drop ignored with --dry-run")

            if args.loop is None:
                return 0
            time.sleep(args.loop)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

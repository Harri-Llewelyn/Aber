"""
Cold telemetry archival — the parts that can be asserted without a stack.

WHAT IS WORTH PINNING HERE, given that the export path itself needs a historian, object storage and
a chunk to be meaningful. Those were exercised end to end by hand and the safety properties live in
SQL, where `timescaledb/cold_archive.sql`'s own self-check asserts them on every boot:

  * dropped requires verified, verified requires exported (CHECK constraints);
  * a correctly ordered row is still accepted, so the guard is not refusing everything.

What is left for a unit test is the object layout -- which is a DECISION rather than a mechanism,
is baked into every object the moment one is written, and cannot be changed later without either
rewriting the archive or teaching every reader two schemes.
"""
import io
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))


@pytest.fixture(scope="module")
def cold_archive():
    """
    Imported lazily and skipped rather than failed when the daemon's config is absent.

    `cold_archive` imports `ingestion`, which reads the environment at module scope. This suite is
    about pure functions; a missing DB_PASSWORD should not turn that into a red test.
    """
    try:
        import cold_archive as module
    except Exception as err:  # noqa: BLE001
        pytest.skip(f"cold_archive is not importable here: {err}")
    return module


@pytest.fixture(scope="module")
def object_key_for(cold_archive):
    return cold_archive.object_key_for


WEEK_START = datetime(2026, 4, 2, tzinfo=timezone.utc)
WEEK_END = datetime(2026, 4, 9, tzinfo=timezone.utc)


def test_key_is_hive_partitioned(object_key_for):
    """
    Every segment of the key, pinned whole, because the layout is baked into each object the moment
    one is written and changing it later means rewriting the archive or teaching readers two
    schemes.

    `key=value` directory names are read as COLUMNS by DuckDB, Spark and Arrow, so `WHERE year =
    2026` skips whole prefixes without opening a file.
    """
    key = object_key_for("broughton-7f3a9c21", WEEK_START, WEEK_END)
    assert key == (
        "site=broughton-7f3a9c21/dataset=telemetry/v=1/"
        "year=2026/month=04/20260402T000000Z-20260409T000000Z.parquet"
    )


def test_the_site_is_the_leftmost_segment(object_key_for):
    """
    An IAM policy scopes on a LEFT-ANCHORED prefix, so anything to the left of the site makes a
    per-site credential impossible to write -- and a per-site credential is what stops one plant's
    compromised gateway reaching another's history in a shared bucket.
    """
    key = object_key_for("broughton-7f3a9c21", WEEK_START, WEEK_END)
    assert key.startswith("site=broughton-7f3a9c21/")


def test_two_sites_do_not_collide(object_key_for):
    """
    THE FAILURE THIS EXISTS FOR, and it is silent and destructive.

    Chunk numbering is per database, so two fresh installs both begin at `_hyper_1_1_chunk` and
    their first exports covered the same week. Pointed at one bucket under the old chunk-named
    layout, site B's upload overwrote site A's object -- while site A's manifest still read
    `verified` and `--drop` had already removed its rows.
    """
    a = object_key_for("broughton-7f3a9c21", WEEK_START, WEEK_END)
    b = object_key_for("llanelli-4b1e8d02", WEEK_START, WEEK_END)
    assert a != b


def test_month_is_zero_padded(object_key_for):
    """
    `month=4` and `month=04` are DIFFERENT PARTITION VALUES to every reader that parses these.

    An archive that wrote both would silently split one month across two partitions, and a query
    filtering on one would return half the data with no error anywhere.
    """
    key = object_key_for(
        "broughton-7f3a9c21",
        datetime(2026, 1, 31, tzinfo=timezone.utc),
        datetime(2026, 2, 7, tzinfo=timezone.utc),
    )
    assert "/month=01/" in key
    assert "/month=1/" not in key


def test_the_partition_follows_the_start_across_a_month_boundary(object_key_for):
    """
    A chunk beginning 29 March holds April readings under `month=03`, and that is deliberate.

    A chunk spans up to seven days and months do not align with it, so this happens routinely. The
    manifest is the authoritative index; the Hive partitions are a convenience for a reader that
    does not have it, and such a reader must widen by one partition on each side. Pinned here so
    the rule is not "fixed" later by someone who meets it as a bug.
    """
    key = object_key_for(
        "broughton-7f3a9c21",
        datetime(2026, 3, 29, tzinfo=timezone.utc),
        datetime(2026, 4, 5, tzinfo=timezone.utc),
    )
    assert "/year=2026/month=03/" in key
    assert "20260329T000000Z-20260405T000000Z" in key


def test_a_retry_addresses_the_same_object(object_key_for):
    """
    The upload overwrites, and the key is what makes that correct rather than dangerous.

    A previous attempt may have uploaded and failed verification; its manifest row exists, so the
    candidate list will never offer the chunk again and refusing to overwrite would strand it. The
    key is derived from the chunk's TIME RANGE, which does not change between attempts -- unlike a
    chunk name, which does not survive a restore into a fresh database.
    """
    first = object_key_for("broughton-7f3a9c21", WEEK_START, WEEK_END)
    second = object_key_for("broughton-7f3a9c21", WEEK_START, WEEK_END)
    assert first == second


def test_the_stamp_is_utc_whatever_zone_it_arrives_in(object_key_for):
    """
    `range_start` comes back from psycopg2 in whatever zone the session carries, and two objects
    naming the same instant differently would break the lexical ordering the leaf name exists for.
    """
    from datetime import timedelta

    bst = timezone(timedelta(hours=1))
    key = object_key_for(
        "broughton-7f3a9c21",
        datetime(2026, 4, 2, 1, 0, tzinfo=bst),
        datetime(2026, 4, 9, 1, 0, tzinfo=bst),
    )
    assert "20260402T000000Z-20260409T000000Z" in key


def test_an_unconfigured_destination_names_every_gap(cold_archive):
    """
    All of them, not the first: an operator configuring this is setting five things at once, and a
    refusal that reveals one missing variable per run costs five runs.
    """
    missing = cold_archive.unconfigured({}, "")
    # NAMED AS THE PAGE NAMES THEM, not as the columns behind them. This refusal ends up in a
    # CronJob log, and an operator matching it against Settings > Cold Storage should not have to
    # translate. check-docs-drift.mjs holds these labels level with the frontend's own list.
    assert "S3 endpoint" in missing
    assert "S3 region" in missing
    assert "S3 bucket" in missing
    assert "S3 access key ID" in missing
    assert "the secret access key" in missing
    assert any("site key" in m for m in missing)


def test_a_complete_destination_is_not_refused(cold_archive):
    """The negative half: a guard that refuses everything would pass the test above and ship dead."""
    complete = {
        "endpoint": "https://s3.eu-west-2.amazonaws.com",
        "region": "eu-west-2",
        "bucket": "plant-history",
        "access_key": "AKIAEXAMPLE",
        "secret_key": "secret",
    }
    assert cold_archive.unconfigured(complete, "broughton-7f3a9c21") == []


def test_a_site_key_alone_is_not_a_destination(cold_archive):
    """
    The key says WHERE IN a bucket, never WHICH bucket. Treating it as sufficient would let a stack
    that had named itself believe it could archive, and fail at 03:15 on a schedule.
    """
    assert cold_archive.unconfigured({}, "broughton-7f3a9c21") != []


def test_parquet_round_trips_the_telemetry_columns():
    """
    The archive is only worth anything if it reads back, so this asserts the format rather than the
    plumbing: every telemetry column survives a write/read cycle, including the two nullable value
    columns that are empty for a numeric metric.

    `val_string` and `val_bool` being all-NULL is the ordinary case -- a float metric fills only
    `val_double` -- and an all-NULL column is exactly where a columnar format's type inference can
    go wrong and produce a file that no longer matches the hypertable it came from.
    """
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")

    table = pa.table({
        "time": [datetime(2026, 4, 2, 9, 42, tzinfo=timezone.utc)],
        "asset_id": ["dev220000000000400080000"],
        "metric_name": ["SpindleSpeed"],
        "val_double": [4000.0],
        "val_string": [None],
        "val_bool": [None],
    })

    buffer = io.BytesIO()
    pq.write_table(table, buffer, compression="zstd")
    payload = buffer.getvalue()

    read_back = pq.read_table(io.BytesIO(payload))
    assert read_back.num_rows == 1
    assert read_back.column_names == [
        "time", "asset_id", "metric_name", "val_double", "val_string", "val_bool"
    ]
    assert read_back.to_pydict()["val_double"] == [4000.0]
    # The footer count is what verify_object() checks a download against, so it has to be readable
    # from the bytes alone rather than from anything the writer remembered.
    assert pq.ParquetFile(io.BytesIO(payload)).metadata.num_rows == 1


@pytest.fixture(scope="module")
def parse_instant():
    try:
        from cold_archive import parse_instant as fn
    except Exception as err:  # noqa: BLE001
        pytest.skip(f"cold_archive is not importable here: {err}")
    return fn


def test_a_bare_date_means_midnight_utc(parse_instant):
    """
    `--from 2026-04-01` obviously means the start of that day, and guessing the HOST's timezone
    would silently shift a query by hours depending on where it was run. Telemetry is stored in UTC.
    """
    parsed = parse_instant("2026-04-01", "--from")
    assert parsed == datetime(2026, 4, 1, tzinfo=timezone.utc)


def test_an_explicit_offset_is_kept(parse_instant):
    """Somebody who says +02:00 means +02:00; re-interpreting it as UTC would move the window."""
    parsed = parse_instant("2026-04-01T09:30:00+02:00", "--from")
    assert parsed.utcoffset().total_seconds() == 7200


def test_a_naive_timestamp_is_read_as_utc(parse_instant):
    # The same reasoning as the bare date: consistent, and consistent with where the data came from.
    assert parse_instant("2026-04-01T09:30:00", "--to").tzinfo is not None
    assert parse_instant("2026-04-01T09:30:00", "--to") == datetime(2026, 4, 1, 9, 30, tzinfo=timezone.utc)


def test_a_mistyped_date_is_refused_before_anything_is_fetched(parse_instant):
    """
    THE FAILURE THIS REPLACES. Binding the raw text straight into DuckDB produced
    `Binder Error ... an explicit cast is required` -- AFTER the objects had been downloaded. A
    parse error has to arrive before the fetch, and name what was expected.
    """
    with pytest.raises(SystemExit) as raised:
        parse_instant("last-april", "--from")
    assert "--from" in str(raised.value)
    assert "ISO date" in str(raised.value)

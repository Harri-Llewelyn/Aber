"""
Cold telemetry archival — the parts that can be asserted without a stack (roadmap item 3).

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
def object_key_for():
    """
    Imported lazily and skipped rather than failed when the daemon's config is absent.

    `cold_archive` imports `ingestion`, which reads the environment at module scope. This suite is
    about a pure function; a missing DB_PASSWORD should not turn that into a red test.
    """
    try:
        from cold_archive import object_key_for as fn
    except Exception as err:  # noqa: BLE001
        pytest.skip(f"cold_archive is not importable here: {err}")
    return fn


def test_key_is_hive_partitioned(object_key_for):
    """
    `year=YYYY/month=MM/` is not decoration -- it is what makes query-in-place possible.

    DuckDB, Spark and Arrow all read those directory names as COLUMNS, so `WHERE year = 2026` skips
    whole prefixes without opening a file. A flat layout would still store the data and would make
    the read side scan everything.
    """
    key = object_key_for("_hyper_1_38_chunk", datetime(2026, 4, 2, tzinfo=timezone.utc))
    assert key == "year=2026/month=04/_hyper_1_38_chunk.parquet"


def test_month_is_zero_padded(object_key_for):
    """
    `month=4` and `month=04` are DIFFERENT PARTITION VALUES to every reader that parses these.

    An archive that wrote both would silently split one month across two partitions, and a query
    filtering on one would return half the data with no error anywhere.
    """
    key = object_key_for("_hyper_1_2_chunk", datetime(2026, 1, 31, tzinfo=timezone.utc))
    assert "month=01/" in key
    assert "month=1/" not in key


def test_key_is_keyed_on_the_chunk_not_the_time(object_key_for):
    """
    Two chunks inside one month must not collide.

    The chunk name is the unit that is exported and dropped, so it is the unit the object is named
    for. Naming objects by month alone would make the second export of a month overwrite the first
    -- and because the exporter uploads with `upsert`, it would do so silently, leaving a manifest
    with two rows pointing at one object holding one of them.
    """
    when = datetime(2026, 4, 2, tzinfo=timezone.utc)
    assert object_key_for("_hyper_1_38_chunk", when) != object_key_for("_hyper_1_39_chunk", when)


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

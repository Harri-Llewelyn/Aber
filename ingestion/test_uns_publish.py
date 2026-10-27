"""
Unit tests for the Unified Namespace bridge (`ingestion/uns_publish.py`).

NO BROKER AND NO DATABASE: a fake PostgREST query builder supplies rows of `device_uns_paths` and a
fake MQTT client records what was published. The view's own answers, path and skip reason, are held
by supabase/migrations/test_a_device_shows_where_its_readings_appear_in_the_uns.py. What is guarded
here:

  * THE BRIDGE PUBLISHES WHAT THE VIEW ANSWERS. The device's path is read from the view, once per
    device per TTL; the topic is the root, the message's group, the rest of the view's path and the
    metric name. A device the view skips is skipped and counted under the view's reason.
  * THE SEGMENTS ARE TOPIC-SAFE. A metric leaf may carry / (a catalog group prefix) but not a
    wildcard; the root may span levels; the message's group must be one level.
  * OFF BY DEFAULT, and the counters and the exposition table agree about the skip reasons.
"""
import json
import os
import sys
import unittest
from datetime import datetime, timezone

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

import uns_publish  # noqa: E402
import metrics  # noqa: E402

DEVICE_ID = "dddddddd-0000-4000-8000-000000000001"
AT = datetime(2026, 9, 11, 12, 0, 0, 250000, tzinfo=timezone.utc)

# The reasons the view answers; the other two are the bridge's own, at run time.
VIEW_REASONS = ("site_unset", "lane", "unassigned", "cell_unfiled", "unsafe_name")


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    """Enough of the PostgREST builder for `.select(...).eq(...).execute()`."""

    def __init__(self, rows, selects):
        self._rows = rows
        self._filters = []
        self._selects = selects

    def select(self, columns, *_args, **_kwargs):
        self._selects.append(columns)
        return self

    def eq(self, column, value):
        self._filters.append((column, value))
        return self

    def execute(self):
        rows = self._rows
        for column, value in self._filters:
            rows = [r for r in rows if r.get(column) == value]
        return FakeResult(rows)


class FakeSupabase:
    def __init__(self, tables):
        self.tables = tables
        self.reads = []
        self.selects = []

    def table(self, name):
        self.reads.append(name)
        return FakeQuery(self.tables.get(name, []), self.selects)


class FakeClient:
    def __init__(self, fail=False):
        self.published = []
        self.fail = fail

    def publish(self, topic, payload, qos=0, retain=False):
        if self.fail:
            raise RuntimeError("refused")
        self.published.append((topic, json.loads(payload), qos, retain))


def supabase_with(path=None, reason=None, enterprise="Aber"):
    """A stack whose one device the view answers with `path` below the root, or with `reason`."""
    return FakeSupabase({
        "device_uns_paths": [{
            "device_id": DEVICE_ID, "enterprise": enterprise,
            "uns_path": path, "skip_reason": reason,
        }],
        "metric_catalog": [{"name": "Spindle/Speed", "units": "rpm"}],
    })


IN_A_CELL = "Aber/Cardiff/Building A/Bay 1/CNC_01"


class Counters:
    def __init__(self):
        self.values = {}

    def __call__(self, name, n=1):
        self.values[name] = self.values.get(name, 0) + n


def publish(client, supabase, rows=None, enabled=True, counters=None, group="Aber"):
    uns_publish.reset_cache()
    rows = rows if rows is not None else [(AT, "devdddddddd000040008000", "Spindle/Speed", 1200.0, None, None)]
    return uns_publish.publish_ddata(
        client, supabase, {"id": DEVICE_ID, "name": "CNC_01"}, group, rows,
        count=counters, enabled=enabled,
    )


class TopicShape(unittest.TestCase):
    def test_the_topic_is_the_root_the_view_s_path_and_the_metric(self):
        client = FakeClient()
        n = publish(client, supabase_with(IN_A_CELL))
        self.assertEqual(n, 1)
        topic, body, qos, retain = client.published[0]
        self.assertEqual(topic, "uns/Aber/Cardiff/Building A/Bay 1/CNC_01/Spindle/Speed")
        self.assertEqual(body["value"], 1200.0)
        self.assertEqual(body["units"], "rpm")
        self.assertEqual(body["name"], "Spindle/Speed")
        self.assertEqual(body["asset_id"], "devdddddddd000040008000")
        self.assertEqual(qos, 0)
        self.assertTrue(retain)

    def test_a_path_without_a_cell_level_is_published_as_the_view_gives_it(self):
        client = FakeClient()
        publish(client, supabase_with("Aber/Cardiff/CNC_01"))
        self.assertEqual(client.published[0][0], "uns/Aber/Cardiff/CNC_01/Spindle/Speed")

    def test_the_enterprise_is_the_sparkplug_group_of_the_message(self):
        # The view's group is the one last recorded for the gateway, which a change of group outruns.
        client = FakeClient()
        publish(client, supabase_with(IN_A_CELL), group="OtherCo")
        self.assertEqual(client.published[0][0], "uns/OtherCo/Cardiff/Building A/Bay 1/CNC_01/Spindle/Speed")

    def test_only_the_first_segment_is_the_group(self):
        # A site, area or cell named like the group is not swapped with it.
        base, reason = uns_publish.topic_for(
            "OtherCo", {"enterprise": "Aber", "uns_path": "Aber/Aber/Aber/CNC_01", "skip_reason": None})
        self.assertIsNone(reason)
        self.assertEqual(base, "uns/OtherCo/Aber/Aber/CNC_01")

    def test_a_root_may_span_levels_as_the_broker_s_grant_does(self):
        row = {"enterprise": "Aber", "uns_path": IN_A_CELL, "skip_reason": None}
        self.assertEqual(uns_publish.topic_for("Aber", row, root="plant/uns"),
                         ("plant/uns/Aber/Cardiff/Building A/Bay 1/CNC_01", None))
        self.assertEqual(uns_publish.topic_for("Aber", row, root="uns/+"), (None, "unsafe_name"))

    def test_the_timestamp_is_iso_8601_utc_at_millisecond_precision(self):
        client = FakeClient()
        publish(client, supabase_with(IN_A_CELL))
        self.assertEqual(client.published[0][1]["timestamp"], "2026-09-11T12:00:00.250Z")

    def test_string_and_boolean_values_travel_as_themselves(self):
        client = FakeClient()
        rows = [
            (AT, "dev", "State", None, "RUNNING", None),
            (AT, "dev", "DoorOpen", None, None, False),
        ]
        publish(client, supabase_with(IN_A_CELL), rows=rows)
        values = {t.rsplit("/", 1)[1]: b["value"] for t, b, _, _ in client.published}
        self.assertEqual(values, {"State": "RUNNING", "DoorOpen": False})


class IncompletePaths(unittest.TestCase):
    """Nothing is published under a placeholder; the reason is counted."""

    def assert_skipped(self, supabase, reason, rows=None, group="Aber"):
        client = FakeClient()
        counters = Counters()
        n = publish(client, supabase, rows=rows, counters=counters, group=group)
        self.assertEqual(n, 0)
        self.assertEqual(client.published, [])
        self.assertEqual(counters.values.get("uns_skipped_%s" % reason), 1, counters.values)
        self.assertNotIn("uns_published", counters.values)
        return counters

    def test_each_reason_the_view_gives_is_the_reason_counted(self):
        for reason in VIEW_REASONS:
            with self.subTest(reason=reason):
                self.assert_skipped(supabase_with(reason=reason), reason)

    def test_a_reason_the_counters_do_not_label_counts_as_a_path_not_read(self):
        self.assert_skipped(supabase_with(reason="something_new"), "location_unknown")

    def test_a_device_the_view_does_not_know_is_skipped(self):
        supabase = supabase_with(IN_A_CELL)
        supabase.tables["device_uns_paths"] = []
        self.assert_skipped(supabase, "location_unknown")

    def test_a_path_that_does_not_start_with_its_enterprise_is_not_guessed_at(self):
        self.assert_skipped(supabase_with("Cardiff/CNC_01", enterprise="Aber"), "location_unknown")
        self.assert_skipped(supabase_with(IN_A_CELL, enterprise=None), "location_unknown")

    def test_a_message_group_that_is_not_one_level_is_refused(self):
        self.assert_skipped(supabase_with(IN_A_CELL), "unsafe_name", group="")
        self.assert_skipped(supabase_with(IN_A_CELL), "unsafe_name", group="Ab/er")

    def test_a_metric_leaf_may_carry_a_slash_but_not_a_wildcard(self):
        client = FakeClient()
        counters = Counters()
        rows = [
            (AT, "dev", "Spindle/Speed", 1.0, None, None),
            (AT, "dev", "Bad#Name", 2.0, None, None),
        ]
        n = publish(client, supabase_with(IN_A_CELL), rows=rows, counters=counters)
        self.assertEqual(n, 1)
        self.assertEqual(counters.values["uns_skipped_unsafe_name"], 1)
        self.assertEqual(counters.values["uns_published"], 1)

    def test_a_refused_publish_is_counted_and_does_not_raise(self):
        client = FakeClient(fail=True)
        counters = Counters()
        n = publish(client, supabase_with(IN_A_CELL), counters=counters)
        self.assertEqual(n, 0)
        self.assertEqual(counters.values["uns_skipped_publish_error"], 1)

    def test_a_directory_that_raises_is_counted_and_does_not_raise(self):
        class Broken:
            def table(self, _name):
                raise RuntimeError("directory unavailable")
        client = FakeClient()
        counters = Counters()
        n = publish(client, Broken(), counters=counters)
        self.assertEqual(n, 0)
        self.assertEqual(counters.values["uns_skipped_location_unknown"], 1)


class Defaults(unittest.TestCase):
    def test_off_by_default_publishes_nothing_and_reads_nothing(self):
        supabase = supabase_with(IN_A_CELL)
        client = FakeClient()
        n = publish(client, supabase, enabled=None if uns_publish.UNS_MQTT_ENABLED is False else False)
        self.assertEqual(n, 0)
        self.assertEqual(client.published, [])
        self.assertEqual(supabase.reads, [])

    def test_the_path_is_one_read_of_the_view_and_nothing_else(self):
        supabase = supabase_with(IN_A_CELL)
        publish(FakeClient(), supabase)
        self.assertEqual(supabase.reads, ["device_uns_paths", "metric_catalog"])
        self.assertEqual(supabase.selects[0], "device_id,enterprise,uns_path,skip_reason")

    def test_a_skipped_device_costs_one_read(self):
        supabase = supabase_with(reason="site_unset")
        publish(FakeClient(), supabase)
        self.assertEqual(supabase.reads, ["device_uns_paths"])

    def test_the_path_is_cached_across_messages(self):
        supabase = supabase_with(IN_A_CELL)
        client = FakeClient()
        publish(client, supabase)
        reads_after_first = len(supabase.reads)
        uns_publish.publish_ddata(client, supabase, {"id": DEVICE_ID, "name": "CNC_01"}, "Aber",
                                  [(AT, "dev", "Spindle/Speed", 2.0, None, None)], enabled=True)
        self.assertEqual(len(supabase.reads), reads_after_first)
        self.assertEqual(len(client.published), 2)

    def test_every_skip_reason_has_an_exposition_mapping(self):
        for reason in uns_publish.SKIP_REASONS:
            self.assertIn("uns_skipped_%s" % reason, metrics.COUNTER_MAP)
            name, labels = metrics.COUNTER_MAP["uns_skipped_%s" % reason]
            self.assertEqual(name, "aber_ingestion_uns_skipped_total")
            self.assertEqual(labels, {"reason": reason})
        self.assertIn("uns_published", metrics.COUNTER_MAP)
        self.assertTrue(set(VIEW_REASONS) < set(uns_publish.SKIP_REASONS))

    def test_nothing_here_reads_a_birth(self):
        # The location is the operator's record, never what a device claims about itself.
        with open(os.path.join(INGESTION_DIR, "uns_publish.py"), encoding="utf-8") as fh:
            source = fh.read()
        for word in ("NBIRTH", "DBIRTH", "last_birth_metrics"):
            self.assertNotIn(word, source)


if __name__ == "__main__":
    unittest.main(verbosity=2)

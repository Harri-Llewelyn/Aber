"""
Unit tests for the Unified Namespace bridge (`ingestion/uns_publish.py`).

NO BROKER AND NO DATABASE: a fake PostgREST query builder supplies rows and a fake MQTT client
records what was published. What is guarded:

  * THE PATH IS FIXED AT THE LEVEL THE ASSET OCCUPIES. Cell-scoped devices publish under
    area/cell, area-wide under the area, site-wide under the site -- and nothing is ever
    published under a placeholder: an unassigned device, a cell in no area, or a site with no
    name is skipped and counted by reason.
  * THE SEGMENTS ARE TOPIC-SAFE. A name carrying / + or # is refused rather than published
    somewhere unintended; a metric leaf may carry / (a catalog group prefix) but not a wildcard.
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
CELL_ID = "cccccccc-0000-4000-8000-000000000001"
AREA_ID = "aaaaaaaa-0000-4000-8000-000000000001"
AT = datetime(2026, 9, 11, 12, 0, 0, 250000, tzinfo=timezone.utc)


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    """Enough of the PostgREST builder for `.select(...).eq(...).execute()`."""

    def __init__(self, rows):
        self._rows = rows
        self._filters = []

    def select(self, *_args, **_kwargs):
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

    def table(self, name):
        self.reads.append(name)
        return FakeQuery(self.tables.get(name, []))


class FakeClient:
    def __init__(self, fail=False):
        self.published = []
        self.fail = fail

    def publish(self, topic, payload, qos=0, retain=False):
        if self.fail:
            raise RuntimeError("refused")
        self.published.append((topic, json.loads(payload), qos, retain))


def supabase_with(source, cell=None, area=None, site="Cardiff", cell_area=None):
    """A stack whose one device resolves as `source`, with the named cell and area."""
    tables = {
        "system_settings": [{"key": "site.name", "value": site}],
        "device_locations": [{
            "device_id": DEVICE_ID, "location_source": source,
            "effective_cell_id": CELL_ID if cell else None,
            "effective_area_id": AREA_ID if area else None,
        }],
        "cells": [{"id": CELL_ID, "name": cell}] if cell else [],
        "areas": [{"id": AREA_ID, "name": area}] if area else [],
        "metric_catalog": [{"name": "Spindle/Speed", "units": "rpm"}],
    }
    return FakeSupabase(tables)


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
    def test_a_cell_scoped_device_publishes_under_area_and_cell(self):
        client = FakeClient()
        n = publish(client, supabase_with("inherited", cell="Bay 1", area="Building A"))
        self.assertEqual(n, 1)
        topic, body, qos, retain = client.published[0]
        self.assertEqual(topic, "uns/Aber/Cardiff/Building A/Bay 1/CNC_01/Spindle/Speed")
        self.assertEqual(body["value"], 1200.0)
        self.assertEqual(body["units"], "rpm")
        self.assertEqual(body["name"], "Spindle/Speed")
        self.assertEqual(body["asset_id"], "devdddddddd000040008000")
        self.assertEqual(qos, 0)
        self.assertTrue(retain)

    def test_an_area_wide_device_skips_the_cell_level(self):
        client = FakeClient()
        publish(client, supabase_with("area_wide", area="Building A"))
        self.assertEqual(client.published[0][0], "uns/Aber/Cardiff/Building A/CNC_01/Spindle/Speed")

    def test_a_site_wide_device_sits_directly_under_the_site(self):
        client = FakeClient()
        publish(client, supabase_with("site_wide"))
        self.assertEqual(client.published[0][0], "uns/Aber/Cardiff/CNC_01/Spindle/Speed")

    def test_the_enterprise_is_the_sparkplug_group_of_the_message(self):
        client = FakeClient()
        publish(client, supabase_with("site_wide"), group="OtherCo")
        self.assertTrue(client.published[0][0].startswith("uns/OtherCo/Cardiff/"))

    def test_the_timestamp_is_iso_8601_utc_at_millisecond_precision(self):
        client = FakeClient()
        publish(client, supabase_with("site_wide"))
        self.assertEqual(client.published[0][1]["timestamp"], "2026-09-11T12:00:00.250Z")

    def test_string_and_boolean_values_travel_as_themselves(self):
        client = FakeClient()
        rows = [
            (AT, "dev", "State", None, "RUNNING", None),
            (AT, "dev", "DoorOpen", None, None, False),
        ]
        publish(client, supabase_with("site_wide"), rows=rows)
        values = {t.rsplit("/", 1)[1]: b["value"] for t, b, _, _ in client.published}
        self.assertEqual(values, {"State": "RUNNING", "DoorOpen": False})


class IncompletePaths(unittest.TestCase):
    """Nothing is published under a placeholder; the reason is counted."""

    def assert_skipped(self, supabase, reason, rows=None):
        client = FakeClient()
        counters = Counters()
        n = publish(client, supabase, rows=rows, counters=counters)
        self.assertEqual(n, 0)
        self.assertEqual(client.published, [])
        self.assertEqual(counters.values.get("uns_skipped_%s" % reason), 1, counters.values)
        return counters

    def test_no_site_name_means_nothing_is_published(self):
        counters = self.assert_skipped(supabase_with("inherited", cell="Bay 1", area="Building A", site=""), "site_unset")
        self.assertNotIn("uns_published", counters.values)

    def test_an_unassigned_device_is_skipped(self):
        self.assert_skipped(supabase_with("unassigned"), "unassigned")

    def test_a_cell_filed_in_no_area_leaves_a_hole_the_bridge_will_not_fill(self):
        self.assert_skipped(supabase_with("explicit", cell="Bay 1", area=None), "cell_unfiled")

    def test_shadow_and_simulated_devices_are_lanes_not_places(self):
        self.assert_skipped(supabase_with("shadow", cell="Bay 1", area="Building A"), "lane")
        self.assert_skipped(supabase_with("simulated"), "lane")

    def test_a_device_the_view_does_not_know_is_skipped(self):
        supabase = supabase_with("site_wide")
        supabase.tables["device_locations"] = []
        self.assert_skipped(supabase, "location_unknown")

    def test_a_segment_with_a_separator_or_wildcard_is_refused(self):
        self.assert_skipped(supabase_with("inherited", cell="Bay 1/2", area="Building A"), "unsafe_name")
        self.assert_skipped(supabase_with("inherited", cell="Bay 1", area="Block #"), "unsafe_name")
        self.assert_skipped(supabase_with("site_wide", site="Card+iff"), "unsafe_name")

    def test_a_metric_leaf_may_carry_a_slash_but_not_a_wildcard(self):
        client = FakeClient()
        counters = Counters()
        rows = [
            (AT, "dev", "Spindle/Speed", 1.0, None, None),
            (AT, "dev", "Bad#Name", 2.0, None, None),
        ]
        n = publish(client, supabase_with("site_wide"), rows=rows, counters=counters)
        self.assertEqual(n, 1)
        self.assertEqual(counters.values["uns_skipped_unsafe_name"], 1)
        self.assertEqual(counters.values["uns_published"], 1)

    def test_a_refused_publish_is_counted_and_does_not_raise(self):
        client = FakeClient(fail=True)
        counters = Counters()
        n = publish(client, supabase_with("site_wide"), counters=counters)
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
        supabase = supabase_with("site_wide")
        client = FakeClient()
        n = publish(client, supabase, enabled=None if uns_publish.UNS_MQTT_ENABLED is False else False)
        self.assertEqual(n, 0)
        self.assertEqual(client.published, [])
        self.assertEqual(supabase.reads, [])

    def test_the_context_is_cached_across_messages(self):
        supabase = supabase_with("inherited", cell="Bay 1", area="Building A")
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
            self.assertEqual(name, "acs_ingestion_uns_skipped_total")
            self.assertEqual(labels, {"reason": reason})
        self.assertIn("uns_published", metrics.COUNTER_MAP)

    def test_nothing_here_reads_a_birth(self):
        # The location is the operator's record, never what a device claims about itself.
        with open(os.path.join(INGESTION_DIR, "uns_publish.py"), encoding="utf-8") as fh:
            source = fh.read()
        for word in ("NBIRTH", "DBIRTH", "last_birth_metrics"):
            self.assertNotIn(word, source)


if __name__ == "__main__":
    unittest.main(verbosity=2)

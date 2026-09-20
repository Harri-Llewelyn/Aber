"""
Unit tests for the load generator's arithmetic -- the parts that decide what a run REPORTS.

A load run is expensive and unrepeatable: the stack it measured has moved on by the time anyone
reads the number. So the reduction from raw counters to a verdict is the part that has to be right
first, and it is the part that needs no broker to check.

Two of these guard a conclusion that would otherwise be wrong in a believable direction:

  * A QUANTILE OVER CUMULATIVE BUCKETS MUST USE THE DELTA. Prometheus histogram buckets are
    cumulative since process start, so a quantile taken over the raw buckets answers for every
    write the daemon has ever made -- which, after a long ramp, is dominated by the early cheap
    steps and reports a healthy p95 for a step that was not healthy.
  * SATURATION AND A SLOW GENERATOR LOOK ALIKE from the published rate alone. Both fall short of
    target. Only the queue tells them apart, and reporting the wrong one inverts the conclusion of
    the whole exercise: "the stack broke here" versus "we could not push it that hard".

Stubbing follows ingestion/test_entity_cache.py: the generator's heavy imports are replaced before
it is loaded, since none of them are reachable from the code under test.
"""
import os
import sys
import types
import unittest

HARNESS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HARNESS_DIR)


def _stub(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules.setdefault(name, module)
    if "." in name:
        parent, _, leaf = name.rpartition(".")
        if parent in sys.modules:
            setattr(sys.modules[parent], leaf, sys.modules[name])
    return module


class _Client:
    """Enough of paho's Client to construct a Publisher; nothing here publishes."""

    def __init__(self, *args, **kwargs):
        pass


_stub("sparkplug_b_pb2", Payload=object)
_stub("paho")
_stub("paho.mqtt")
_stub("paho.mqtt.client", Client=_Client, MQTTv5=5, MQTT_ERR_SUCCESS=0)

import load_generator  # noqa: E402  (must follow the stubs above)


def step(**overrides):
    """One plan step's result, with everything a verdict reads present and benign."""
    base = {
        "target_rate": 100.0, "published_per_second": 100.0, "written_per_second": 100.0,
        "queue_depth_start": 0, "queue_depth_end": 0,
        "dropped": {}, "saturated": False, "generator_limited": False,
    }
    base.update(overrides)
    return base


class PlanTest(unittest.TestCase):
    def test_a_plan_is_rate_by_seconds(self):
        self.assertEqual(load_generator.parse_plan("100x90,250x60"), [(100.0, 90.0), (250.0, 60.0)])

    def test_whitespace_and_a_trailing_comma_are_tolerated(self):
        self.assertEqual(load_generator.parse_plan(" 100x90 , 250x60 , "),
                         [(100.0, 90.0), (250.0, 60.0)])

    def test_a_step_that_is_not_rate_by_seconds_is_refused(self):
        """Refused rather than skipped: a plan silently missing a step reports the wrong knee."""
        with self.assertRaises(SystemExit):
            load_generator.parse_plan("100x90,fast")

    def test_an_empty_plan_is_refused(self):
        with self.assertRaises(SystemExit):
            load_generator.parse_plan("   ")


class ExpositionTest(unittest.TestCase):
    TEXT = "\n".join([
        "# HELP aber_ingestion_up The daemon is running.",
        "# TYPE aber_ingestion_up gauge",
        "aber_ingestion_up 1.0",
        "aber_ingestion_write_queue_depth 42.0",
        'aber_ingestion_messages_total{msg_type="DDATA"} 900.0',
        'aber_ingestion_messages_total{msg_type="DBIRTH"} 12.0',
        'aber_ingestion_messages_dropped_total{reason="write_queue_full"} 7.0',
        'aber_ingestion_messages_dropped_total{reason="gateway_binding"} 3.0',
        'aber_ingestion_write_seconds_bucket{le="0.005"} 10.0',
        'aber_ingestion_write_seconds_bucket{le="0.01"} 25.0',
        'aber_ingestion_write_seconds_bucket{le="+Inf"} 30.0',
        "aber_ingestion_write_seconds_count 30.0",
        "aber_ingestion_write_seconds_sum 0.21",
    ])

    def setUp(self):
        self.sample = load_generator.parse_exposition(self.TEXT, at=1000.0)

    def test_comments_are_not_series(self):
        self.assertEqual(self.sample.get("# HELP"), 0.0)
        self.assertEqual(self.sample.get("aber_ingestion_up"), 1.0)

    def test_a_missing_series_reads_zero_rather_than_raising(self):
        """A counter the daemon has never incremented is absent from the exposition entirely."""
        self.assertEqual(self.sample.get("aber_ingestion_never_happened_total"), 0.0)

    def test_ddata_is_taken_from_the_labelled_message_counter(self):
        self.assertEqual(self.sample.received_ddata(), 900.0)

    def test_drops_are_summed_across_reasons_and_readable_one_by_one(self):
        self.assertEqual(self.sample.dropped_total(), 10.0)
        self.assertEqual(self.sample.dropped_by_reason()["write_queue_full"], 7.0)

    def test_the_infinity_bucket_is_a_bound_and_not_a_name(self):
        buckets = self.sample.write_buckets()
        self.assertEqual(buckets[0.005], 10.0)
        self.assertEqual(buckets[float("inf")], 30.0)


class QuantileTest(unittest.TestCase):
    """The quantile is over the writes made BETWEEN two samples, not since the daemon started."""

    @staticmethod
    def sample(buckets):
        lines = [f'aber_ingestion_write_seconds_bucket{{le="{bound}"}} {count}'
                 for bound, count in buckets]
        return load_generator.parse_exposition("\n".join(lines), at=0.0)

    def test_the_quantile_reads_the_step_and_not_the_run_so_far(self):
        # 1000 cheap writes before the step; in the step, 100 writes of which 90 were slow.
        before = self.sample([("0.005", 1000), ("0.05", 1000), ("+Inf", 1000)])
        after = self.sample([("0.005", 1010), ("0.05", 1100), ("+Inf", 1100)])
        self.assertEqual(
            load_generator.quantile_from_buckets(before.write_buckets(), after.write_buckets(), 0.95),
            0.05,
        )

    def test_the_same_pair_read_cumulatively_would_have_answered_the_cheap_bucket(self):
        """Why the delta matters: the absolute buckets say 0.005, which is the wrong answer."""
        after = self.sample([("0.005", 1010), ("0.05", 1100), ("+Inf", 1100)])
        empty = load_generator.parse_exposition("", at=0.0).write_buckets()
        self.assertEqual(
            load_generator.quantile_from_buckets(empty, after.write_buckets(), 0.95), 0.05
        )

    def test_a_step_that_wrote_nothing_has_no_quantile(self):
        """None, not zero: no write is not a fast write, and a table must be able to say so."""
        buckets = self.sample([("0.005", 5), ("+Inf", 5)]).write_buckets()
        self.assertIsNone(load_generator.quantile_from_buckets(buckets, buckets, 0.95))


class PacingTest(unittest.TestCase):
    """
    A publisher that fell behind must not repay the debt as a burst: catching up measures neither
    the target rate nor the limit, and it would hide the shortfall that IS the finding.
    """

    def test_nothing_is_due_before_the_first_interval(self):
        self.assertEqual(load_generator.pace(0.001, 100, 0), (0, 0))

    def test_what_is_due_is_the_elapsed_time_times_the_rate(self):
        self.assertEqual(load_generator.pace(0.5, 100, 0), (50, 0))
        self.assertEqual(load_generator.pace(0.5, 100, 40), (10, 0))

    def test_a_backlog_inside_one_second_is_still_repaid(self):
        """Ordinary jitter -- a scheduler hiccup, a 20 ms scrape -- is caught up, not abandoned."""
        self.assertEqual(load_generator.pace(1.0, 100, 20), (80, 0))

    def test_a_backlog_older_than_a_second_is_abandoned_rather_than_burst(self):
        due, abandoned = load_generator.pace(10.0, 100, 0)
        self.assertEqual(due, 100)
        self.assertEqual(abandoned, 900)

    def test_an_abandoned_backlog_is_counted_so_the_shortfall_is_visible(self):
        """The count is what turns "we could not push it that hard" into a number in the report."""
        self.assertEqual(sum(load_generator.pace(10.0, 100, 0)), 1000)

    def test_a_publisher_that_is_ahead_is_never_asked_for_a_negative_number(self):
        self.assertEqual(load_generator.pace(0.5, 100, 60), (0, 0))


class VerdictTest(unittest.TestCase):
    def test_a_growing_queue_names_the_writer_and_the_rate(self):
        result = load_generator.verdict([
            step(target_rate=100, written_per_second=100),
            step(target_rate=500, written_per_second=300, saturated=True,
                 queue_depth_start=10, queue_depth_end=4000),
        ])
        self.assertIn("500", result)
        self.assertIn("queue grew", result)
        self.assertIn("100 msg/s", result)

    def test_a_shortfall_with_a_flat_queue_is_reported_as_this_generator_s_limit(self):
        """The honest answer when the stack never gave way: the harness ran out first."""
        result = load_generator.verdict([
            step(target_rate=100, written_per_second=100),
            step(target_rate=2000, published_per_second=1200, written_per_second=1200,
                 generator_limited=True),
        ])
        self.assertIn("generator's and not the stack's", result)

    def test_saturation_is_reported_ahead_of_a_shortfall(self):
        """Both are true above the knee; only the first one answers what gave way."""
        result = load_generator.verdict([
            step(target_rate=500, saturated=True, queue_depth_end=9000),
            step(target_rate=1000, generator_limited=True),
        ])
        self.assertIn("queue grew", result)

    def test_a_drop_is_reported_with_its_reason(self):
        result = load_generator.verdict([
            step(target_rate=800, dropped={"write_queue_full": 120}),
        ])
        self.assertIn("write_queue_full", result)

    def test_a_plan_the_stack_absorbed_says_so(self):
        result = load_generator.verdict([step(target_rate=100, written_per_second=100)])
        self.assertIn("sustained every step", result)

    def test_the_highest_sustained_rate_ignores_the_steps_that_failed(self):
        result = load_generator.verdict([
            step(target_rate=100, written_per_second=99),
            step(target_rate=500, written_per_second=480),
            step(target_rate=1000, written_per_second=505, saturated=True),
        ])
        self.assertIn("480 msg/s", result)


class TimestampTest(unittest.TestCase):
    """
    Telemetry is keyed (time, asset_id, metric_name) ON CONFLICT DO NOTHING, so two messages for
    one device in the same millisecond lose the second one's rows -- silently, and the write path
    still counts them. A generator that let that happen would under-report its own storage figures.
    """

    def publisher(self):
        return load_generator.Publisher(
            {"sparkplug_id": "gwy000000000000000000001", "name": "LOADGEN_Gateway_001"},
            [{"sparkplug_id": "dev000000000000000000001", "name": "LOADGEN_Device_0001"}],
            load_generator.METRIC_NAMES[:3],
            "Aber",
        )

    def test_one_device_never_gets_the_same_millisecond_twice(self):
        publisher = self.publisher()
        stamps = [publisher._next_ms("dev000000000000000000001") for _ in range(500)]
        self.assertEqual(len(set(stamps)), len(stamps))

    def test_the_stamps_only_move_forwards(self):
        publisher = self.publisher()
        stamps = [publisher._next_ms("dev000000000000000000001") for _ in range(50)]
        self.assertEqual(stamps, sorted(stamps))

    def test_one_device_s_bumped_stamps_do_not_push_another_device_forwards(self):
        """The key includes the asset, so only a device's own repeats are a collision."""
        publisher = self.publisher()
        for _ in range(200):
            publisher._next_ms("dev-a")
        self.assertLess(publisher._next_ms("dev-b"), publisher._last_ms["dev-a"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

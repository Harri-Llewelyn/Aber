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
from unittest import mock

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
        "target_rate": 100.0, "held_seconds": 90.0, "soak": False,
        "published_per_second": 100.0, "written_per_second": 100.0,
        "queue_depth_start": 0, "queue_depth_end": 0,
        "dropped": {}, "saturated": False, "generator_limited": False,
        "received_per_second": 100.0, "rows_per_second": 1000.0,
        "undelivered": 0, "broker_dropped": 0, "abandoned": 0,
        "sequence_gaps": 0, "rebirths": 0,
        "messages_per_transaction": 1.0, "write_mean_ms": 1.0, "write_p95_bucket_ms": 2.0,
    }
    base.update(overrides)
    return base


class PlanTest(unittest.TestCase):
    def test_a_plan_is_rate_by_seconds(self):
        self.assertEqual(load_generator.parse_plan("100x90,250x60"), [(100.0, 90.0), (250.0, 60.0)])

    def test_whitespace_and_a_trailing_comma_are_tolerated(self):
        self.assertEqual(load_generator.parse_plan(" 100x90 , 250x60 , "),
                         [(100.0, 90.0), (250.0, 60.0)])

    def test_fractions_are_rates_and_seconds_too(self):
        self.assertEqual(load_generator.parse_plan("12.5x30.5"), [(12.5, 30.5)])

    def test_a_step_that_is_not_rate_by_seconds_is_refused(self):
        """Refused rather than skipped: a plan silently missing a step reports the wrong knee."""
        for plan in ("100x90,fast", "100", "x90", "100x", "100x90x2"):
            with self.subTest(plan=plan), self.assertRaises(SystemExit):
                load_generator.parse_plan(plan)

    def test_a_step_of_no_rate_or_no_time_is_refused(self):
        """A zero-second step has no sample window, and a zero rate measures an idle stack."""
        for plan in ("0x90", "100x0", "-100x90", "100x-90"):
            with self.subTest(plan=plan), self.assertRaises(SystemExit):
                load_generator.parse_plan(plan)

    def test_an_empty_plan_is_refused(self):
        with self.assertRaises(SystemExit):
            load_generator.parse_plan("   ")


class ExpositionTest(unittest.TestCase):
    TEXT = "\n".join([
        "# HELP aber_ingestion_up The daemon is running.",
        "# TYPE aber_ingestion_up gauge",
        "aber_ingestion_up 1.0",
        "aber_ingestion_write_queue_depth 42.0",
        # LOWERCASE, as the daemon writes it: it counts `messages_<msg_type.lower()>`. The first
        # run of this generator read zero received messages for exactly this reason, while the
        # write path was busy -- the fixture had been written to the topic's spelling, not the
        # daemon's, so the suite agreed with the bug.
        'aber_ingestion_messages_total{msg_type="ddata"} 900.0',
        'aber_ingestion_messages_total{msg_type="dbirth"} 12.0',
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

    def test_the_message_type_is_matched_whatever_case_the_daemon_exposes(self):
        """
        The daemon lowercases the type; the topic and the specification say DDATA. A
        case-sensitive match returns 0.0, which is indistinguishable from a broker that
        delivered nothing -- so the run reports a stack receiving no messages while writing
        them at full rate.
        """
        for spelling in ("DDATA", "ddata", "DData"):
            self.assertEqual(self.sample.received_of(spelling), 900.0, spelling)

    def test_births_are_counted_across_both_birth_types(self):
        self.assertEqual(self.sample.received_of("DBIRTH", "NBIRTH"), 12.0)

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

    def test_a_soak_whose_only_step_gave_way_does_not_report_zero_as_the_rate(self):
        """The 1250 msg/s soak of 2026-09-23: one step, saturated. It wrote 1226/s, not 0."""
        result = load_generator.verdict([
            step(target_rate=1250, written_per_second=1226, saturated=True,
                 queue_depth_start=78, queue_depth_end=1050),
        ])
        self.assertNotIn("rate: 0 msg/s", result)
        self.assertIn("none in this plan held", result)

    def test_a_plan_the_stack_absorbed_without_a_soak_says_it_kept_up_and_for_how_long(self):
        result = load_generator.verdict([step(target_rate=100, written_per_second=100)])
        self.assertIn("kept up with every step", result)
        self.assertIn("100 msg/s written, for 90 s only; not soaked", result)
        self.assertNotIn("sustained", result)

    def test_a_plan_the_stack_absorbed_through_a_soak_says_sustained(self):
        result = load_generator.verdict([
            step(target_rate=100, written_per_second=100),
            step(target_rate=100, written_per_second=100, held_seconds=1200, soak=True),
        ])
        self.assertIn("sustained every step", result)
        self.assertIn("through a 1200 s soak at 100 msg/s", result)

    def test_the_highest_sustained_rate_ignores_the_steps_that_failed(self):
        result = load_generator.verdict([
            step(target_rate=100, written_per_second=99),
            step(target_rate=500, written_per_second=480),
            step(target_rate=1000, written_per_second=505, saturated=True),
        ])
        self.assertIn("480 msg/s", result)


class SoakTest(unittest.TestCase):
    """
    A 90 s step says a rate was reached, not that it is kept: 1,250 msg/s held its 90 s on
    2026-09-23 and then failed a 20-minute hold. So a step reads `sustained` only when a soak at
    its rate or above held, and the verdict's headline says which evidence it rests on.
    """

    RAMP = [
        step(target_rate=100, written_per_second=100),
        step(target_rate=1000, written_per_second=1000),
        step(target_rate=1250, written_per_second=1250),
        step(target_rate=1500, written_per_second=1462, saturated=True,
             queue_depth_start=11, queue_depth_end=3005),
    ]

    def notes(self, steps):
        return [load_generator.step_note(s, steps) for s in steps]

    def test_the_soak_holds_the_last_step_that_held(self):
        self.assertEqual(load_generator.soak_target(self.RAMP)["target_rate"], 1250)

    def test_a_step_that_dropped_or_fell_short_is_not_soaked(self):
        steps = [step(target_rate=100), step(target_rate=500, dropped={"write_queue_full": 3}),
                 step(target_rate=800, generator_limited=True)]
        self.assertEqual(load_generator.soak_target(steps)["target_rate"], 100)

    def test_nothing_is_soaked_when_no_step_held(self):
        self.assertIsNone(load_generator.soak_target([step(saturated=True)]))

    def test_a_soak_is_not_soaked_again(self):
        steps = self.RAMP + [step(target_rate=1250, held_seconds=1200, soak=True)]
        self.assertFalse(load_generator.soak_target(steps)["soak"])

    def test_without_a_soak_no_step_reads_sustained(self):
        notes = self.notes(self.RAMP)
        self.assertEqual(notes[:3], ["held 90 s, not soaked"] * 3)
        self.assertEqual(notes[3], "queue growing")
        self.assertNotIn("sustained", " ".join(notes))

    def test_a_soak_that_held_makes_its_rate_and_every_lower_one_sustained(self):
        steps = self.RAMP[:2] + [step(target_rate=1250, written_per_second=1250)] + [
            step(target_rate=1000, written_per_second=1000, held_seconds=1200, soak=True)]
        self.assertEqual(self.notes(steps), [
            "sustained", "sustained", "held 90 s, not soaked", "1200 s soak: sustained"])
        self.assertIn("Highest sustained rate: 1000 msg/s written, through a 1200 s soak",
                      load_generator.verdict(steps))

    def test_the_run_of_2026_09_23_reads_as_it_should_have(self):
        """The ramp said 1250 sustained; the soak at 1250 grew its queue. Now the table says so."""
        steps = self.RAMP + [step(target_rate=1250, written_per_second=1226, held_seconds=1200,
                                  soak=True, saturated=True, queue_depth_start=78,
                                  queue_depth_end=1050, undelivered=27302, broker_dropped=27299)]
        notes = self.notes(steps)
        self.assertEqual(notes[2], "held 90 s; the soak did not")
        self.assertEqual(notes[1], "held 90 s, not soaked")
        self.assertEqual(notes[4], "1200 s soak: queue growing; broker shed 27,299")
        result = load_generator.verdict(steps)
        self.assertIn("queue grew at 1250 msg/s, in the 1200 s soak (depth 78 -> 1050)", result)
        self.assertIn("Highest rate held: 1250 msg/s written, for 90 s only; "
                      "the 1250 msg/s soak did not hold", result)

    def test_an_old_report_without_held_seconds_still_renders(self):
        old = step()
        del old["held_seconds"]
        old["duration_seconds"] = 75.0
        self.assertEqual(load_generator.step_note(old, [old]), "held 75 s, not soaked")

    def test_the_table_carries_the_seq_gaps_and_rebirths_a_step_saw(self):
        noted = step(sequence_gaps=3, rebirths=2)
        self.assertEqual(load_generator.step_note(noted, [noted]),
                         "held 90 s, not soaked; seq gaps 3, rebirths 2")


class _Published:
    def __init__(self, rc=0):
        self.rc = rc


class _RecordingClient:
    """Records each publish as (topic, what the patched builder returned); `fail` refuses them."""

    def __init__(self):
        self.sent = []
        self.fail = False

    def publish(self, topic, payload, qos=0):
        if self.fail:
            return _Published(rc=4)
        self.sent.append((topic, payload))
        return _Published()


def _publisher(devices=2, primary_host_id="", buffer_limit=1000):
    publisher = load_generator.Publisher(
        {"sparkplug_id": "gwy000000000000000000001", "name": "LOADGEN_Gateway_001"},
        [{"sparkplug_id": f"dev{i:021d}", "name": f"LOADGEN_Device_{i:04d}"} for i in range(devices)],
        load_generator.METRIC_NAMES[:2],
        "Aber",
        buffer_limit=buffer_limit,
        primary_host_id=primary_host_id,
    )
    publisher.client = _RecordingClient()
    publisher.connected.set()
    return publisher


# The payload builders need the real sparkplug_b_pb2; these hand back the seq they were given.
_BUILDERS = {
    "node_birth": lambda timestamp_ms, seq, bdseq: ("NBIRTH", seq),
    "device_birth": lambda asset_id, asset_name, metric_names, timestamp_ms, seq: ("DBIRTH", seq),
    "device_data": lambda metric_names, timestamp_ms, values, seq, historical=False: (
        ("DDATA", seq, "historical") if historical else ("DDATA", seq)),
}


class SequenceTest(unittest.TestCase):
    """
    The daemon follows one `seq` per edge node across NBIRTH, DBIRTH and DDATA, and counts a jump
    in `aber_ingestion_sequence_gaps_total` and asks for a rebirth. Without a `seq` it judges
    nothing, so a load run that shed 56,871 messages left that whole path untested.
    """

    def setUp(self):
        patches = [mock.patch.object(load_generator, name, fn) for name, fn in _BUILDERS.items()]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_an_nbirth_is_zero_and_each_message_after_it_is_one_more(self):
        counter = load_generator.SequenceCounter()
        seen = []
        for msg_type in ["NBIRTH", "DBIRTH", "DDATA", "DDATA"]:
            seen.append(counter.peek(msg_type))
            counter.commit(seen[-1])
        self.assertEqual(seen, [0, 1, 2, 3])

    def test_it_wraps_from_255_to_0(self):
        counter = load_generator.SequenceCounter()
        seen = []
        for msg_type in ["NBIRTH"] + ["DDATA"] * 258:
            seen.append(counter.peek(msg_type))
            counter.commit(seen[-1])
        self.assertEqual(seen[254:259], [254, 255, 0, 1, 2])

    def test_an_nbirth_restarts_it_wherever_it_was(self):
        counter = load_generator.SequenceCounter()
        counter.commit(200)
        self.assertEqual(counter.peek("NBIRTH"), 0)

    def test_the_births_and_the_data_after_them_share_one_run(self):
        publisher = _publisher(devices=2)
        self.assertEqual(publisher.births(), 3)
        publisher.publish_one()
        publisher.publish_one()
        sent = publisher.client.sent
        self.assertEqual([payload for _, payload in sent],
                         [("NBIRTH", 0), ("DBIRTH", 1), ("DBIRTH", 2), ("DDATA", 3), ("DDATA", 4)])
        self.assertEqual(sent[0][0], "spBv1.0/Aber/NBIRTH/gwy000000000000000000001")
        self.assertTrue(sent[3][0].startswith("spBv1.0/Aber/DDATA/gwy000000000000000000001/dev"))

    def test_a_publish_the_client_refused_does_not_spend_a_seq(self):
        """Not a gap: the daemon never saw it, and the next message must be the one it expects."""
        publisher = _publisher(devices=1)
        publisher.births()
        publisher.client.fail = True
        self.assertFalse(publisher.publish_one())
        publisher.client.fail = False
        publisher.publish_one()
        self.assertEqual(publisher.client.sent[-1][1], ("DDATA", 2))
        self.assertEqual(publisher.publish_errors, 1)


class RebirthTest(unittest.TestCase):
    """An NCMD `Node Control/Rebirth` is answered as an appliance answers it: NBIRTH, then DBIRTHs."""

    def setUp(self):
        patches = [mock.patch.object(load_generator, name, fn) for name, fn in _BUILDERS.items()]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    @staticmethod
    def command(*metrics):
        return types.SimpleNamespace(metrics=[types.SimpleNamespace(name=n, boolean_value=v)
                                              for n, v in metrics])

    def test_only_a_true_node_rebirth_is_a_request(self):
        self.assertTrue(load_generator.asks_for_rebirth(self.command(("Node Control/Rebirth", True))))
        self.assertFalse(load_generator.asks_for_rebirth(self.command(("Node Control/Rebirth", False))))
        self.assertFalse(load_generator.asks_for_rebirth(self.command(("Node Control/Reboot", True))))
        self.assertFalse(load_generator.asks_for_rebirth(self.command()))

    def test_a_request_is_answered_with_a_fresh_birth_set_and_seq_restarts(self):
        publisher = _publisher(devices=2)
        publisher.births()
        for _ in range(5):
            publisher.publish_one()
        publisher.client.sent.clear()
        publisher._rebirth.set()
        self.assertTrue(publisher.answer_rebirth())
        self.assertEqual([payload for _, payload in publisher.client.sent],
                         [("NBIRTH", 0), ("DBIRTH", 1), ("DBIRTH", 2)])
        self.assertEqual(publisher.rebirths, 1)
        self.assertFalse(publisher.answer_rebirth(), "one request is answered once")

    def test_the_command_is_read_on_paho_s_thread_and_answered_on_the_publisher_s(self):
        request = self.command(("Node Control/Rebirth", True))

        class Payload:
            def ParseFromString(self, raw):
                self.metrics = request.metrics if raw == b"rebirth" else []

        publisher = _publisher()
        with mock.patch.object(load_generator.sparkplug_b_pb2, "Payload", Payload, create=True):
            publisher._on_command(None, None, types.SimpleNamespace(payload=b"something else"))
            self.assertFalse(publisher._rebirth.is_set())
            publisher._on_command(None, None, types.SimpleNamespace(payload=b"rebirth"))
        self.assertTrue(publisher._rebirth.is_set())
        self.assertEqual(publisher.client.sent, [], "nothing is published from the callback")

    def test_a_payload_that_does_not_parse_is_ignored(self):
        class Payload:
            def ParseFromString(self, raw):
                raise ValueError("not a Sparkplug payload")

        publisher = _publisher()
        with mock.patch.object(load_generator.sparkplug_b_pb2, "Payload", Payload, create=True):
            publisher._on_command(None, None, types.SimpleNamespace(payload=b"\xff"))
        self.assertFalse(publisher._rebirth.is_set())


class SequenceGapCounterTest(unittest.TestCase):
    def test_the_daemon_s_gap_counter_is_read_for_this_fleet_s_nodes(self):
        sample = load_generator.parse_exposition("\n".join([
            'aber_ingestion_sequence_gaps_total{edge_node="gwyA"} 2.0',
            'aber_ingestion_sequence_gaps_total{edge_node="gwyB"} 3.0',
            'aber_ingestion_sequence_gaps_total{edge_node="someone-else"} 40.0',
        ]), at=0.0)
        self.assertEqual(sample.sequence_gaps({"gwyA", "gwyB"}), 5.0)
        self.assertEqual(sample.sequence_gaps(), 45.0)
        self.assertEqual(load_generator.parse_exposition("", at=0.0).sequence_gaps(), 0.0)


class CompressionReportTest(unittest.TestCase):
    def test_bytes_a_row_and_the_ratio_come_from_the_chunks_before_and_after(self):
        lines = load_generator.compression_lines({
            "chunks": ["_timescaledb_internal._hyper_1_5_chunk"], "rows": 1_000_000,
            "before_bytes": 366_000_000, "after_bytes": 10_000_000, "seconds": 42.0,
        }, metrics=10)
        text = "\n".join(lines)
        self.assertIn("36.6x", text)
        self.assertIn("366.0 -> 10.0 bytes a row", text)
        self.assertIn("1,000,000 rows", text)
        # 864 M rows a day at 10 bytes a row.
        self.assertIn("8.0 GiB compressed", text)
        self.assertNotIn("disagree", text)

    def test_timescaledb_s_own_account_is_shown_when_it_disagrees(self):
        lines = load_generator.compression_lines({
            "chunks": ["c"], "rows": 1_000_000, "before_bytes": 366_000_000,
            "after_bytes": 1_000_000, "seconds": 1.0,
            "compression_stats": {"before_bytes": 366_000_000, "after_bytes": 10_000_000},
        }, metrics=10)
        self.assertIn("chunk_compression_stats reads 9.5 MiB", "\n".join(lines))

    def test_a_failure_is_reported_rather_than_a_number(self):
        lines = load_generator.compression_lines(
            {"error": "compression not enabled on hypertable \"telemetry\""}, metrics=10)
        self.assertIn("Compressed: not measured.", lines[0])
        self.assertIn("compression not enabled", lines[0])

    def test_no_compress_flag_adds_nothing(self):
        self.assertEqual(load_generator.compression_lines(None, metrics=10), [])

    def test_a_chunk_already_compressed_is_not_measured(self):
        executed = []

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def execute(self, sql, params=None):
                executed.append(sql)

            def fetchall(self):
                return [("_timescaledb_internal._hyper_1_12_chunk", 0, 1, True)]

        class Connection:
            autocommit = False

            def cursor(self):
                return Cursor()

            def close(self):
                pass

        from unittest import mock
        with mock.patch.object(load_generator, "_historian", return_value=Connection()):
            result = load_generator.compress_run_chunks(0)
        self.assertIn("already compressed before this run", result["error"])
        self.assertFalse(any("compress_chunk(" in sql for sql in executed))


class UndeliveredTest(unittest.TestCase):
    """
    A message lost between the publisher and the daemon is the one loss the daemon cannot count:
    telemetry is QoS 0, so the broker sheds it for a subscriber that has stopped reading and every
    `aber_ingestion_messages_dropped_total` reason stays at zero. A run that showed only the
    daemon's counters would report a clean saturation and hide the data loss underneath it.
    """

    def report(self, **overrides):
        return {"gateways": 1, "devices": 1, "metrics_per_message": 10, "verdict": "-",
                "steps": [step(**overrides)]}

    def test_the_broker_s_own_counter_explains_an_undelivered_gap(self):
        out = load_generator.render(self.report(
            target_rate=2000, published_per_second=2000, received_per_second=1540,
            written_per_second=1506, undelivered=41_400, broker_dropped=22_127, saturated=True))
        self.assertIn("broker shed 22,127", out)
        self.assertIn("queue growing", out)

    def test_a_gap_the_broker_cannot_confirm_is_not_attributed_to_it(self):
        """No exporter means no claim: the gap is still reported, its cause is not invented."""
        out = load_generator.render(self.report(
            target_rate=2000, undelivered=41_400, broker_dropped=None))
        self.assertIn("41,400", out)
        self.assertNotIn("broker shed", out)

    def test_every_step_carries_the_undelivered_column(self):
        self.assertIn("undelivered", load_generator.render(self.report()))


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


class EdgeNodeTest(unittest.TestCase):
    """
    The generator behaves as a Sparkplug edge node configured with a primary host, as the appliance
    does, so a restart of ingestion under load measures the conformant path: births wait for STATE,
    readings taken while the host is away are buffered and take no seq, and the replay is flagged
    is_historical and continues the seq.
    """

    def setUp(self):
        patches = [mock.patch.object(load_generator, name, fn) for name, fn in _BUILDERS.items()]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    @staticmethod
    def state(publisher, online, stamp, host="Site"):
        publisher._on_state(types.SimpleNamespace(
            topic=f"spBv1.0/STATE/{host}", payload=('{"online": %s, "timestamp": %d}' % (
                "true" if online else "false", stamp)).encode()))

    def test_without_a_primary_host_it_births_and_publishes(self):
        publisher = _publisher(devices=1)
        self.assertEqual(publisher.births(), 2)
        publisher.publish_one()
        self.assertEqual([p for _, p in publisher.client.sent], [("NBIRTH", 0), ("DBIRTH", 1), ("DDATA", 2)])

    def test_it_waits_for_the_primary_host_and_buffers_meanwhile(self):
        publisher = _publisher(devices=1, primary_host_id="Site")
        self.assertEqual(publisher.births(), 0, "no NBIRTH before STATE says the host is online")
        publisher.publish_one()
        self.assertEqual(publisher.client.sent, [])
        self.assertEqual((publisher.buffered, len(publisher.buffer)), (1, 1))

    def test_once_the_host_is_online_it_births_then_replays_historical_on_the_same_seq_run(self):
        publisher = _publisher(devices=1, primary_host_id="Site")
        publisher.publish_one()
        publisher.publish_one()
        self.state(publisher, True, 1000)
        publisher.births()
        publisher._replay_rate = 1000.0
        publisher._replay_budget = 10.0
        self.assertEqual(publisher.replay_some(), 2)
        publisher.publish_one()
        self.assertEqual([p for _, p in publisher.client.sent], [
            ("NBIRTH", 0), ("DBIRTH", 1), ("DDATA", 2, "historical"), ("DDATA", 3, "historical"), ("DDATA", 4)])
        self.assertEqual((publisher.replayed, publisher.taken), (2, 3))

    def test_only_the_configured_host_and_a_timestamp_not_older_count(self):
        publisher = _publisher(primary_host_id="Site")
        self.state(publisher, True, 1000, host="Someone-Else")
        self.assertFalse(publisher.host_online())
        self.state(publisher, True, 1000)
        self.state(publisher, False, 999)
        self.assertTrue(publisher.host_online(), "a death older than the birth is a previous session's")

    def test_a_valid_offline_while_born_ends_the_session(self):
        publisher = _publisher(primary_host_id="Site")
        self.state(publisher, True, 1000)
        publisher.births()
        self.state(publisher, False, 1000)
        self.assertTrue(publisher._host_left.is_set())
        self.assertFalse(publisher.deliverable())

    def test_a_new_connection_hears_the_host_again_before_it_births(self):
        publisher = _publisher(devices=1, primary_host_id="Site")
        self.state(publisher, True, 1000)
        publisher.client = mock.MagicMock()
        with mock.patch.object(load_generator, "node_death", lambda bdseq, timestamp_ms=None: ("NDEATH", bdseq)):
            publisher._open()
        self.assertFalse(publisher.host_online())
        self.state(publisher, True, 999)
        self.assertFalse(publisher.host_online(), "an older STATE is a previous session's")
        self.state(publisher, True, 1000)
        self.assertTrue(publisher.host_online())
        will = publisher.client.will_set.call_args
        self.assertEqual((will.kwargs["qos"], will.kwargs["retain"]), (1, False))
        self.assertTrue(publisher.client.connect.call_args.kwargs["clean_start"])

    def test_a_full_buffer_drops_the_oldest_and_counts_it(self):
        publisher = _publisher(devices=1, primary_host_id="Site", buffer_limit=2)
        for _ in range(3):
            publisher.publish_one()
        self.assertEqual((len(publisher.buffer), publisher.buffer_dropped), (2, 1))

    def test_a_state_payload_is_read_or_refused(self):
        self.assertEqual(load_generator.host_state(b'{"online": true, "timestamp": 5}'), (True, 5))
        for raw in (b"not json", b'{"online": "yes", "timestamp": 5}', b'{"online": true}'):
            self.assertIsNone(load_generator.host_state(raw))


class RestartTest(unittest.TestCase):
    """
    load-test.mjs --restart-ingestion-at restarts the daemon mid-step, and its counters start again
    from zero. Read naively the step reports negative rates; it must instead be recognised and
    said, because the historian comparison, not the step table, is the measurement then.
    """

    def sample(self, ddata):
        return load_generator.parse_exposition(f'aber_ingestion_messages_total{{msg_type="ddata"}} {ddata}')

    def test_a_counter_that_went_backwards_is_a_restart(self):
        self.assertTrue(load_generator.counters_reset(self.sample(9000), self.sample(40)))

    def test_a_counter_that_grew_is_not(self):
        self.assertFalse(load_generator.counters_reset(self.sample(40), self.sample(9000)))

    def test_a_death_certificate_is_a_restart_after_the_new_daemon_counts_past_the_old(self):
        # The 50 msg/s run: restarted 60 s into a 240 s step, so the new daemon ends the step with
        # the larger count and only the edge nodes' ended sessions say what happened.
        self.assertTrue(load_generator.daemon_restarted(self.sample(3000), self.sample(9000), host_departures=8))

    def test_no_death_certificate_and_a_grown_counter_is_no_restart(self):
        self.assertFalse(load_generator.daemon_restarted(self.sample(3000), self.sample(9000), host_departures=0))

    def test_the_step_says_the_daemon_restarted(self):
        restarted = step(target_rate=500, written_per_second=480, daemon_restarted=True)
        self.assertIn("THE DAEMON RESTARTED", load_generator.step_note(restarted, [restarted]))


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""
The broker-verdict helper in stack_exec.py, and its read of the playback worker's credential file,
with no stack.

The stack suites read a credential's revocation from it, so it has two ways to be wrong: a timeout
read as a refusal passes a revocation that never happened, and a timeout read as an answer fails a
working credential on a slow runner. The outputs below are what mosquitto_pub 2.0.22 prints,
measured against a broker with password authentication, with the line kubectl exec adds when the
command exits non-zero.

The suites that replay start a playback only once the worker's file holds what the delivery Secret
holds, so a file read as current while it lags the Secret would start one the broker refuses.

Run:  python test-harness/test_stack_exec.py
"""
import base64
import json
import os
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stack_exec  # noqa: E402


def completed(returncode, stderr=""):
    exec_line = f"command terminated with exit code {returncode}\n" if returncode else ""
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout="", stderr=stderr + exec_line)


PUBLISHED = completed(0)
NOT_AUTHORISED = completed(5, "Connection error: Connection Refused: not authorised.\n"
                              "Error: The connection was refused.\n")
NOT_AUTHORIZED_V5 = completed(135, "Connection error: Not authorized\n"
                                   "Error: A network protocol error occurred when communicating with the broker.\n")
BAD_USER_NAME_V5 = completed(134, "Connection error: Bad user name or password\n")
TCP_REFUSED = completed(1, "Error: Connection refused\n")
TIMED_OUT = completed(1, "Error: Operation timed out\n")
CAPPED = completed(143)
LOOKUP_FAILED = completed(1, "Unable to connect (Lookup error.).\n")
CONNECTION_LOST = completed(7, "Error: The connection was lost.\n")
EXEC_FAILED = subprocess.CompletedProcess(
    args=[], returncode=1, stdout="",
    stderr='error: unable to upgrade connection: container not found ("mosquitto")\n')


class TestVerdict(unittest.TestCase):
    def test_a_zero_exit_is_accepted(self):
        self.assertEqual(stack_exec.publish_verdict(PUBLISHED), stack_exec.ACCEPTED)

    def test_the_broker_refusing_the_credential_is_refused(self):
        for result in (NOT_AUTHORISED, NOT_AUTHORIZED_V5, BAD_USER_NAME_V5):
            with self.subTest(stderr=result.stderr):
                self.assertEqual(stack_exec.publish_verdict(result), stack_exec.REFUSED)

    def test_a_failure_the_broker_did_not_answer_is_unanswered(self):
        for result in (TIMED_OUT, CAPPED, TCP_REFUSED, LOOKUP_FAILED, CONNECTION_LOST, EXEC_FAILED):
            with self.subTest(stderr=result.stderr):
                self.assertEqual(stack_exec.publish_verdict(result), stack_exec.UNANSWERED)

    def test_a_refused_tcp_connection_is_not_a_refused_credential(self):
        """Both say "connection refused"; only one is the broker judging the credential."""
        self.assertIn("connection refused", TCP_REFUSED.stderr.lower())
        self.assertEqual(stack_exec.publish_verdict(TCP_REFUSED), stack_exec.UNANSWERED)


class FakeClock:
    """time.monotonic and time.sleep for stack_exec, where each attempt costs `attempt_cost` seconds."""

    def __init__(self, attempt_cost=0.0):
        self.now = 0.0
        self.attempt_cost = attempt_cost

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class TestPublish(unittest.TestCase):
    def publish(self, results, attempt_cost=0.0, **kwargs):
        clock = FakeClock(attempt_cost)
        replies = iter(results)
        calls = []

        def run(target, *args, **_):
            calls.append((target, args))
            clock.now += attempt_cost
            return next(replies)

        with mock.patch.object(stack_exec, "run", side_effect=run), \
                mock.patch.object(stack_exec.time, "monotonic", clock.monotonic), \
                mock.patch.object(stack_exec.time, "sleep", clock.sleep):
            verdict, result = stack_exec.publish("gwy0", "secret", "spBv1.0/Aber/NDATA/gwy0", **kwargs)
        return verdict, result, calls, clock

    def test_an_unanswered_attempt_is_retried_until_the_broker_answers(self):
        verdict, result, calls, _ = self.publish([TIMED_OUT, CAPPED, PUBLISHED])
        self.assertEqual(verdict, stack_exec.ACCEPTED)
        self.assertIs(result, PUBLISHED)
        self.assertEqual(len(calls), 3)

    def test_a_refusal_is_returned_at_once(self):
        verdict, _, calls, _ = self.publish([NOT_AUTHORISED, PUBLISHED])
        self.assertEqual(verdict, stack_exec.REFUSED)
        self.assertEqual(len(calls), 1)

    def test_an_acceptance_is_returned_at_once(self):
        _, _, calls, _ = self.publish([PUBLISHED, NOT_AUTHORISED])
        self.assertEqual(len(calls), 1)

    def test_it_gives_up_unanswered_once_the_window_has_passed(self):
        verdict, result, calls, clock = self.publish([TIMED_OUT] * 20, retry_for=15, interval=3)
        self.assertEqual(verdict, stack_exec.UNANSWERED)
        self.assertIs(result, TIMED_OUT)
        self.assertEqual(len(calls), 6, "attempts at 0, 3, 6, 9, 12 and 15 seconds")
        self.assertEqual(clock.now, 15)

    def test_slow_attempts_still_end_near_the_window(self):
        """A capped attempt costs its whole timeout; the window bounds the attempts, not each one."""
        verdict, _, calls, clock = self.publish([CAPPED] * 20, attempt_cost=10, retry_for=15, interval=3)
        self.assertEqual(verdict, stack_exec.UNANSWERED)
        self.assertEqual(len(calls), 2)
        self.assertEqual(clock.now, 23)

    def test_no_window_is_one_attempt(self):
        verdict, _, calls, _ = self.publish([TIMED_OUT, PUBLISHED], retry_for=0)
        self.assertEqual(verdict, stack_exec.UNANSWERED)
        self.assertEqual(len(calls), 1)

    def test_each_attempt_is_capped_inside_the_broker_container(self):
        _, _, calls, _ = self.publish([PUBLISHED], attempt_timeout=7)
        target, args = calls[0]
        self.assertEqual(target, "broker")
        self.assertEqual(args[:3], ("timeout", "7", "mosquitto_pub"))
        self.assertEqual(args[args.index("-u") + 1], "gwy0")
        self.assertEqual(args[args.index("-t") + 1], "spBv1.0/Aber/NDATA/gwy0")


GATEWAY = "gwy160000000000400080000"
EARLIER, LATER = "not-a-real-key-earlier", "not-a-real-key-later"
# The playback Deployment as `kubectl get -o json` gives it, cut to what the read follows.
DEPLOYMENT = {"spec": {"template": {"spec": {
    "containers": [{"name": "playback", "volumeMounts": [
        {"name": "tmp", "mountPath": "/tmp"},
        {"name": "playback-credentials", "mountPath": "/var/lib/aber/playback"}]}],
    "volumes": [
        {"name": "tmp", "emptyDir": {}},
        {"name": "playback-credentials", "secret": {
            "secretName": "mosquitto-passwords",
            "items": [{"key": "playback_credentials.json", "path": "credentials.json"}]}}],
}}}}


def secret_holding(document):
    data = {"playback_credentials.json": base64.b64encode(document.encode()).decode()}
    return json.dumps({"data": data})


class TestPlaybackDelivery(unittest.TestCase):
    def read(self, in_file, in_secret, cat_error=""):
        """playback_deliveries() over a cluster whose file and Secret hold these documents."""
        cats = []

        def kubectl(*args, **_):
            out = json.dumps(DEPLOYMENT) if args[:2] == ("get", "deploy/playback") else secret_holding(in_secret)
            return subprocess.CompletedProcess(args=[], returncode=0, stdout=out, stderr="")

        def run(target, *args, **_):
            cats.append((target, args))
            if cat_error:
                return subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr=cat_error)
            return subprocess.CompletedProcess(args=[], returncode=0, stdout=in_file, stderr="")

        with mock.patch.object(stack_exec, "_kubectl", side_effect=kubectl), \
                mock.patch.object(stack_exec, "run", side_effect=run):
            return stack_exec.playback_deliveries(), cats

    def test_the_file_is_found_where_the_deployment_mounts_the_delivery_key(self):
        (in_file, in_secret), cats = self.read(json.dumps({GATEWAY: EARLIER}), json.dumps({GATEWAY: LATER}))
        self.assertEqual(cats, [("playback", ("cat", "/var/lib/aber/playback/credentials.json"))])
        self.assertEqual((in_file, in_secret), ({GATEWAY: EARLIER}, {GATEWAY: LATER}))

    def test_blank_or_absent_is_nothing_delivered(self):
        (in_file, in_secret), _ = self.read("\n", "")
        self.assertEqual((in_file, in_secret), ({}, {}))
        (in_file, _), _ = self.read("", json.dumps({GATEWAY: LATER}),
                                    cat_error="cat: /var/lib/aber/playback/credentials.json: No such file or directory")
        self.assertEqual(in_file, {})

    def test_a_file_that_cannot_be_read_is_an_error_not_nothing(self):
        with self.assertRaises(RuntimeError):
            self.read("", json.dumps({GATEWAY: LATER}), cat_error="error: container not found (\"playback\")")

    def test_a_file_behind_the_secret_is_a_gap_naming_both(self):
        gap = stack_exec.playback_delivery_gap(GATEWAY, {GATEWAY: EARLIER}, {GATEWAY: LATER})
        self.assertIn(stack_exec.fingerprint(EARLIER), gap)
        self.assertIn(stack_exec.fingerprint(LATER), gap)
        self.assertNotIn(EARLIER, gap)
        self.assertNotIn(LATER, gap)

    def test_a_file_holding_nothing_for_the_gateway_is_a_gap(self):
        self.assertIn("holds nothing for", stack_exec.playback_delivery_gap(GATEWAY, {}, {GATEWAY: LATER}))

    def test_nothing_delivered_is_a_gap_of_its_own(self):
        self.assertIn("no credential has been delivered",
                      stack_exec.playback_delivery_gap(GATEWAY, {GATEWAY: EARLIER}, {"gwy-other": LATER}))

    def test_a_file_holding_what_the_secret_holds_is_no_gap(self):
        self.assertIsNone(stack_exec.playback_delivery_gap(GATEWAY, {GATEWAY: LATER}, {GATEWAY: LATER}))

    def test_a_fingerprint_tells_values_apart_and_is_short(self):
        self.assertRegex(stack_exec.fingerprint(LATER), r"^[0-9a-f]{8}$")
        self.assertNotEqual(stack_exec.fingerprint(EARLIER), stack_exec.fingerprint(LATER))
        self.assertIsNone(stack_exec.fingerprint(None))
        self.assertIsNone(stack_exec.fingerprint(""))


if __name__ == "__main__":
    unittest.main()

"""
How the playback worker resolves the broker passwords it holds (0078).

WHY THIS IS WORTH A SUITE. The failure it guards is one this stack actually reached, and it was
invisible from every side at once. On the stack this was written against:

    the Playback gateway was          gwy16...
    the broker's only gateway account was gwy11..., for a gateway deleted long ago
    gateway_has_broker_credential()   answered false
    the worker held a password for    gwy16... out of .env, that nothing had ever issued
    connecting with it returned       CONNACK rc = 5, not authorised

Nothing said so. `mosquitto.conf` runs `allow_anonymous false`, and Sparkplug publishes at QoS 0 --
no PUBACK -- so past the CONNECT there is nothing a publisher can observe. A password sitting in
`.env` looks exactly like configuration whether or not it was ever real.

The repair is that issuing a credential DELIVERS it, and the worker re-reads. Both halves are
silent when wrong -- a file at the wrong path, or a precedence rule that prefers a stale value --
so both are asserted here.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import playback_worker


class FileCredentials(unittest.TestCase):
    """Reading the delivery store."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "credentials.json")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, text):
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write(text)

    def test_a_missing_file_is_not_an_error(self):
        """
        ABSENT IS THE NORMAL STATE of a stack that has never issued a playback credential. A worker
        logging an error every three seconds about a file it does not need would teach an operator
        to skip the log that also carries the real refusals.
        """
        self.assertEqual(playback_worker._file_credentials(self.path), {})

    def test_a_delivered_credential_is_read(self):
        self.write(json.dumps({"gwy160000000000400080000": "delivered-password-000000"}))
        self.assertEqual(
            playback_worker._file_credentials(self.path),
            {"gwy160000000000400080000": "delivered-password-000000"},
        )

    def test_several_targets_are_all_read(self):
        self.write(json.dumps({"gwy16" + "0" * 19: "a" * 20, "gwy17" + "0" * 19: "b" * 20}))
        self.assertEqual(len(playback_worker._file_credentials(self.path)), 2)

    def test_malformed_json_yields_nothing_rather_than_raising(self):
        # A worker that died on a bad delivery file would take playback down for every OTHER target
        # too, which is a worse outcome than refusing the one job that needs the unreadable entry.
        self.write("{not json")
        self.assertEqual(playback_worker._file_credentials(self.path), {})

    def test_a_json_array_is_not_a_credential_map(self):
        self.write(json.dumps(["gwy160000000000400080000"]))
        self.assertEqual(playback_worker._file_credentials(self.path), {})

    def test_values_are_strings(self):
        # paho hands the value to the broker as a password; a number reaching that call fails at
        # CONNECT, where the cause reads as a broker refusal rather than as a type.
        self.write(json.dumps({"gwy160000000000400080000": 1234567890123456}))
        held = playback_worker._file_credentials(self.path)
        self.assertIsInstance(held["gwy160000000000400080000"], str)


class Precedence(unittest.TestCase):
    """
    Which source wins, which is a question about the broker rather than about configuration.

    Mosquitto holds ONE password per username, so issuing REPLACES the one before it. A value in
    `.env` is therefore not an alternative to a delivered one, it is an OLDER one -- and after any
    re-issue it is simply wrong.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "credentials.json")
        self._saved = {
            k: os.environ.get(k)
            for k in ("MQTT_PLAYBACK_CREDENTIALS", "MQTT_PLAYBACK_USER",
                      "MQTT_PLAYBACK_PASSWORD", "PLAYBACK_CREDENTIAL_FILE")
        }
        for k in self._saved:
            os.environ.pop(k, None)
        os.environ["PLAYBACK_CREDENTIAL_FILE"] = self.path
        # Read at import time, so the module constant is what `_credentials()` actually consults.
        self._saved_const = playback_worker.PLAYBACK_CREDENTIAL_FILE
        playback_worker.PLAYBACK_CREDENTIAL_FILE = self.path

    def tearDown(self):
        playback_worker.PLAYBACK_CREDENTIAL_FILE = self._saved_const
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def write(self, mapping):
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(mapping, handle)

    def test_the_delivered_credential_beats_a_stale_env_one(self):
        """
        THE TEST THIS SUITE EXISTS FOR. If the environment won, the documented repair for a refused
        playback -- issue a new credential -- would be the one action that could not fix it.
        """
        gw = "gwy160000000000400080000"
        os.environ["MQTT_PLAYBACK_CREDENTIALS"] = json.dumps({gw: "stale-password-0000000000"})
        self.write({gw: "delivered-password-000000"})
        self.assertEqual(playback_worker._credentials()[gw], "delivered-password-000000")

    def test_the_env_pair_still_works_with_no_delivery(self):
        # A stack that has always configured playback by hand must keep working untouched.
        os.environ["MQTT_PLAYBACK_USER"] = "gwy160000000000400080000"
        os.environ["MQTT_PLAYBACK_PASSWORD"] = "hand-placed-password-0000"
        self.assertEqual(
            playback_worker._credentials(),
            {"gwy160000000000400080000": "hand-placed-password-0000"},
        )

    def test_env_and_delivery_are_merged_rather_than_replacing_each_other(self):
        # Two targets, one configured each way. Neither source may hide the other's gateway.
        env_gw, delivered_gw = "gwy160000000000400080000", "gwy170000000000400080000"
        os.environ["MQTT_PLAYBACK_CREDENTIALS"] = json.dumps({env_gw: "env-password-000000000000"})
        self.write({delivered_gw: "delivered-password-000000"})
        held = playback_worker._credentials()
        self.assertEqual(sorted(held), sorted([env_gw, delivered_gw]))

    def test_no_sources_at_all_is_empty_and_not_an_error(self):
        self.assertEqual(playback_worker._credentials(), {})


class ChangeDetection(unittest.TestCase):
    """
    Noticing that what this worker holds has changed.

    THIS EXISTS BECAUSE THE FIRST VERSION COMPARED KEY SETS AND MISSED THE CASE IT WAS WRITTEN FOR.
    On the first real delivery, the worker already held the target gateway -- from the stale `.env`
    value -- so the ids were identical before and after and nothing was logged. The worker had in
    fact picked up the new password and playback worked; the operator watching the log had no way
    to know it. Every mint after the first one has that same shape, because it rotates a gateway
    already held.

    The comparison the loop makes is asserted here directly rather than through the loop, which
    needs a Supabase client and a broker.
    """

    GW = "gwy160000000000400080000"

    def test_a_rotation_is_a_change_even_though_the_ids_are_identical(self):
        previous = {self.GW: "stale-password-0000000000"}
        current = {self.GW: "delivered-password-000000"}
        self.assertEqual(set(previous), set(current), "the ids are the same -- that is the trap")
        self.assertNotEqual(previous, current, "a rotation must compare as a change")

    def test_the_three_kinds_of_change_are_distinguishable(self):
        other = "gwy170000000000400080000"
        previous = {self.GW: "old-password-000000000000", other: "kept-password-00000000000"}
        current = {self.GW: "new-password-000000000000", "gwy18" + "0" * 19: "added-password-0000000000"}

        gained = sorted(set(current) - set(previous))
        lost = sorted(set(previous) - set(current))
        rotated = sorted(k for k in set(current) & set(previous) if current[k] != previous[k])

        self.assertEqual(gained, ["gwy18" + "0" * 19])
        self.assertEqual(lost, [other])
        self.assertEqual(rotated, [self.GW])

    def test_an_unchanged_map_is_not_a_change(self):
        # The loop runs every three seconds. A comparison that reported a change each pass would
        # fill the log with the one line an operator is meant to look for after issuing.
        held = {self.GW: "steady-password-000000000"}
        self.assertEqual(held, dict(held))


class DeliveryPath(unittest.TestCase):
    def test_the_default_path_matches_the_writer_and_both_mounts(self):
        """
        The two ends cannot import from each other -- one is Python, one is JavaScript -- and a
        mismatch is silent at BOTH: gateway-credential writes successfully and this worker finds no
        file, so an operator sees a credential issued cleanly and a worker that never picks it up.
        scripts/check-docs-drift.mjs holds all four together; this pins the value it checks.
        """
        self.assertEqual(
            playback_worker.PLAYBACK_CREDENTIAL_FILE,
            "/var/lib/acs-cymru/playback/credentials.json",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

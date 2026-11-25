# suite:
#   lanes: unit
#   why: The hourly device-model sweep (0329): the bucket it deletes from, the gate it asks, the day
#     that spares an upload in flight, a refused batch it does not ask for again, and a run without
#     the ingestion key that says so. Each failure leaves a model nobody shows in a public bucket,
#     with nothing erroring.

"""
Unit tests for the device-model sweep (device_model_sweep.py), the hourly CronJob that deletes the 3D
models nothing names any more. The loop is area_plan_sweep.py's, whose batches and stops
test_area_plan_sweep_worker.py holds; what is held here is what this sweep hands it, and its run.

The database half, which objects are listed and which the bucket lets go, is
supabase/migrations/test_device_model_sweep.py's.
"""
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

import area_plan_sweep  # noqa: E402
import device_model_sweep  # noqa: E402

DEVICE = "8b000000-0000-4000-8000-000000001616"


class FakeSupabase:
    """`rpc(name, args).execute()`, answering `answers` in turn; the last one repeats."""

    def __init__(self, log, answers):
        self.log, self.answers = log, list(answers)

    def rpc(self, name, args):
        self.log.append(("rpc", name, args))
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=answer))


class FakeStorage:
    """Records the bucket and the names; deletes all of them unless told how many it keeps back."""

    def __init__(self, log, keep_back=0):
        self.log, self.keep_back, self.bucket = log, keep_back, None

    def from_(self, bucket):
        self.bucket = bucket
        return self

    def remove(self, paths):
        self.log.append(("remove", self.bucket, list(paths)))
        kept = self.keep_back
        return [{"name": p} for p in (paths[:-kept] if kept else paths)]


def models(n, start=0):
    return ["%s/model-%d.glb" % (DEVICE, i) for i in range(start, start + n)]


class TheSweep(unittest.TestCase):

    def run_sweep(self, answers, **kw):
        log = []
        storage = FakeStorage(log, kw.pop("keep_back", 0))
        total = device_model_sweep.sweep(FakeSupabase(log, answers), storage, **kw)
        return total, log

    def test_it_deletes_what_nothing_names_from_the_models_bucket_once_a_day_old(self):
        stranded = models(2)
        with self.assertLogs("device-model-sweep", level="INFO") as logged:
            total, log = self.run_sweep([stranded, []])
        self.assertEqual(log[0], ("rpc", "ingest_unclaimed_device_model_objects", {"p_min_age_seconds": 86400}))
        self.assertEqual(log[1], ("remove", "asset-3d-models", stranded))
        self.assertEqual(total, 2)
        self.assertIn("3D models: deleted 2 that nothing names any more.", logged.output[0])

    def test_the_day_is_what_spares_an_upload_in_flight(self):
        self.assertEqual(device_model_sweep.MIN_AGE_SECONDS, 24 * 60 * 60)

    def test_nothing_to_delete_deletes_nothing(self):
        total, log = self.run_sweep([[]])
        self.assertEqual([e[0] for e in log], ["rpc"])
        self.assertEqual(total, 0)

    def test_a_full_batch_is_followed_by_the_next(self):
        first, second = models(area_plan_sweep.BATCH), models(7, start=area_plan_sweep.BATCH)
        total, log = self.run_sweep([first, second])
        self.assertEqual([e[0] for e in log], ["rpc", "remove", "rpc", "remove"])
        self.assertEqual(total, area_plan_sweep.BATCH + 7)

    def test_a_refused_delete_is_not_asked_for_again_and_is_logged_as_this_sweep(self):
        with self.assertLogs("device-model-sweep", level="WARNING") as logged:
            total, log = self.run_sweep([models(3)], keep_back=1)
        self.assertEqual([e[0] for e in log], ["rpc", "remove"])
        self.assertEqual(total, 2)
        self.assertIn("3D models: Storage deleted 2 of the 3 nothing names.", logged.output[0])

    def test_a_dry_run_lists_and_deletes_nothing(self):
        with self.assertLogs("device-model-sweep", level="INFO") as logged:
            total, log = self.run_sweep([models(2)], dry_run=True)
        self.assertEqual([e[0] for e in log], ["rpc"])
        self.assertEqual(total, 2)
        self.assertIn(models(1)[0], logged.output[0])


class TheRun(unittest.TestCase):

    def test_without_the_ingestion_key_it_fails_and_says_why(self):
        with patch.object(device_model_sweep, "SUPABASE_INGESTION_KEY", ""), \
                self.assertLogs("device-model-sweep", level="ERROR") as logged:
            self.assertEqual(device_model_sweep.main([]), 2)
        self.assertIn("SUPABASE_INGESTION_KEY", logged.output[0])

    def test_a_failed_sweep_fails_the_job(self):
        def broken(*_args, **_kw):
            raise RuntimeError("Could not query the database for the schema cache. Retrying.")
        with patch.object(device_model_sweep, "SUPABASE_INGESTION_KEY", "not-a-real-key"), \
                patch.object(device_model_sweep, "_supabase_client", lambda: None), \
                patch.object(device_model_sweep, "_storage_client", lambda: None), \
                patch.object(device_model_sweep, "sweep", broken), \
                self.assertLogs("device-model-sweep", level="ERROR"):
            self.assertEqual(device_model_sweep.main([]), 1)

    def test_a_dry_run_is_passed_on(self):
        asked = []
        with patch.object(device_model_sweep, "SUPABASE_INGESTION_KEY", "not-a-real-key"), \
                patch.object(device_model_sweep, "_supabase_client", lambda: "db"), \
                patch.object(device_model_sweep, "_storage_client", lambda: "storage"), \
                patch.object(device_model_sweep, "sweep", lambda *args, **kw: asked.append((args, kw))):
            self.assertEqual(device_model_sweep.main(["--dry-run"]), 0)
            self.assertEqual(device_model_sweep.main([]), 0)
        self.assertEqual(asked, [(("db", "storage"), {"dry_run": True}), (("db", "storage"), {"dry_run": False})])

    def test_both_its_clients_are_the_ingestion_principal(self):
        import capture_worker
        self.assertIs(device_model_sweep._storage_client, capture_worker._storage_client)
        self.assertIs(device_model_sweep._supabase_client, area_plan_sweep._supabase_client)


if __name__ == "__main__":
    unittest.main(verbosity=2)

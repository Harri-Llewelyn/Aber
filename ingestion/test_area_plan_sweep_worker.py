"""
Unit tests for the area-plan sweep (area_plan_sweep.py), the hourly CronJob that deletes the plans
no area names any more.

What a failure here looks like in production, and why each is silent:

  * the wrong bucket, or a delete in SQL: the plan of every purged area stays in the bucket,
    readable by every signed-in role, and nothing errors;
  * no batching: a stack with more than 500 stranded plans is cleared 500 an hour, or never, once
    a refused batch is asked for again and again;
  * a run without the ingestion key: every call is anon's and refused, and the Job's log is the
    only place that could say why.

The database half, which objects are listed and which the bucket lets go, is
supabase/migrations/test_area_plan_sweep.py's.
"""
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

import area_plan_sweep  # noqa: E402


class FakeSupabase:
    """`rpc(name, args).execute()`. Each call takes the next answer; the last one repeats."""

    def __init__(self, log, answers):
        self.log, self.answers = log, list(answers)

    def rpc(self, name, args):
        self.log.append(("rpc", name, args))
        item = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]

        def execute():
            if isinstance(item, Exception):
                raise item
            return SimpleNamespace(data=item)
        return SimpleNamespace(execute=execute)


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


def plans(n, start=0):
    return ["8a000000-0000-4000-8000-%012d/plan-%d.svg" % (i, i) for i in range(start, start + n)]


class TheSweep(unittest.TestCase):

    def run_sweep(self, answers, **kw):
        log = []
        storage = FakeStorage(log, kw.pop("keep_back", 0))
        total = area_plan_sweep.sweep(FakeSupabase(log, answers), storage, **kw)
        return total, log

    def test_it_deletes_what_no_area_names_from_the_area_plans_bucket(self):
        stranded = plans(2)
        total, log = self.run_sweep([stranded, []])
        self.assertEqual(log[0], ("rpc", "ingest_unclaimed_area_plan_objects", {"p_min_age_seconds": 3600}))
        self.assertEqual(log[1], ("remove", "area-plans", stranded))
        self.assertEqual(total, 2)

    def test_the_hour_is_what_spares_an_upload_in_flight(self):
        self.assertEqual(area_plan_sweep.MIN_AGE_SECONDS, 3600)

    def test_nothing_to_delete_deletes_nothing(self):
        total, log = self.run_sweep([[]])
        self.assertEqual([e[0] for e in log], ["rpc"])
        self.assertEqual(total, 0)

    def test_a_short_batch_is_the_last(self):
        total, log = self.run_sweep([plans(3)])
        self.assertEqual([e[0] for e in log], ["rpc", "remove"])
        self.assertEqual(total, 3)

    def test_a_full_batch_is_followed_by_the_next(self):
        first, second = plans(area_plan_sweep.BATCH), plans(7, start=area_plan_sweep.BATCH)
        total, log = self.run_sweep([first, second])
        self.assertEqual([e[0] for e in log], ["rpc", "remove", "rpc", "remove"])
        self.assertEqual(total, area_plan_sweep.BATCH + 7)

    def test_a_refused_delete_is_not_asked_for_again(self):
        """The same names would come back, and the run would spin through every batch."""
        full = plans(area_plan_sweep.BATCH)
        with self.assertLogs("area-plan-sweep", level="WARNING") as logged:
            total, log = self.run_sweep([full], keep_back=1)
        self.assertEqual([e[0] for e in log], ["rpc", "remove"])
        self.assertEqual(total, area_plan_sweep.BATCH - 1)
        self.assertIn("refused", logged.output[0])

    def test_a_run_never_outlasts_its_batches(self):
        total, log = self.run_sweep([plans(area_plan_sweep.BATCH)])
        self.assertEqual(sum(1 for e in log if e[0] == "remove"), area_plan_sweep.MAX_BATCHES)
        self.assertEqual(total, area_plan_sweep.BATCH * area_plan_sweep.MAX_BATCHES)

    def test_a_dry_run_lists_and_deletes_nothing(self):
        total, log = self.run_sweep([plans(2)], dry_run=True)
        self.assertEqual([e[0] for e in log], ["rpc"])
        self.assertEqual(total, 2)


class TheRun(unittest.TestCase):

    def test_without_the_ingestion_key_it_fails_and_says_why(self):
        with patch.object(area_plan_sweep, "SUPABASE_INGESTION_KEY", ""), \
                self.assertLogs("area-plan-sweep", level="ERROR") as logged:
            self.assertEqual(area_plan_sweep.main([]), 2)
        self.assertIn("SUPABASE_INGESTION_KEY", logged.output[0])

    def test_a_failed_sweep_fails_the_job(self):
        def broken(*_args, **_kw):
            raise RuntimeError("Could not query the database for the schema cache. Retrying.")
        with patch.object(area_plan_sweep, "SUPABASE_INGESTION_KEY", "a.b.c"), \
                patch.object(area_plan_sweep, "_supabase_client", lambda: None), \
                patch.object(area_plan_sweep, "_storage_client", lambda: None), \
                patch.object(area_plan_sweep, "sweep", broken), \
                self.assertLogs("area-plan-sweep", level="ERROR"):
            self.assertEqual(area_plan_sweep.main([]), 1)

    def test_it_authenticates_storage_as_the_ingestion_principal(self):
        """The storage client is capture_worker's, which carries the ingestion key, not anon's."""
        import capture_worker
        self.assertIs(area_plan_sweep._storage_client, capture_worker._storage_client)


if __name__ == "__main__":
    unittest.main(verbosity=2)

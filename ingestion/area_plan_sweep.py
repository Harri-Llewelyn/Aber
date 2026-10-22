#!/usr/bin/env python3
"""
Delete the area plans no area names any more. The chart's area-plan-sweep CronJob runs it hourly:

    python -m area_plan_sweep             # delete them
    python -m area_plan_sweep --dry-run   # list them and delete nothing

An area's plan is an object in the `area-plans` bucket that `areas.plan_path` names. A plan is left
behind when the nightly purge deletes its area, which it does in SQL, and SQL cannot remove a stored
file. It is also left behind when the dashboard fails to delete the plan it replaced or removed, or
the plan of an area deleted by hand. `ingest_unclaimed_area_plan_objects()` (0199) lists the objects
no area names that are at least an hour old. The hour spares a plan the dashboard has uploaded and
not yet recorded on its area. This deletes them through the Storage API, the only way bytes leave
a bucket: a DELETE of the storage.objects row in SQL leaves the file in the storage backend.

It runs as the ingestion principal, with SUPABASE_INGESTION_KEY, as the cold archive does. The
bucket's DELETE policy admits that principal to an object no area names and nothing else, so a plan
an area shows survives whatever this is asked.

Related: supabase/README.md -> "A plan no area names is swept from storage (0199)", and
         capture_worker.py, whose storage client this reuses and whose hourly sweep does the same
         for captures nothing claims.
"""
import argparse
import os
import sys

from capture_worker import SUPABASE_GATEWAY_KEY, SUPABASE_INGESTION_KEY, SUPABASE_URL, _storage_client
from logging_config import get_logger

logger = get_logger("area-plan-sweep")

BUCKET = "area-plans"
# How long an object no area names must have gone untouched before it is deleted.
MIN_AGE_SECONDS = int(os.getenv("AREA_PLAN_SWEEP_MIN_AGE_SECONDS", "3600"))
# The gate answers at most this many a call; a full answer is asked again, up to MAX_BATCHES times.
BATCH = 500
MAX_BATCHES = 20


def sweep(supabase, storage, min_age_seconds=MIN_AGE_SECONDS, dry_run=False):
    """
    Delete the plans no area names, a batch at a time. Returns how many were deleted, or listed on
    a dry run. Stops early when Storage deletes fewer than it was given: asking again would only
    be answered with the same names.
    """
    total = 0
    for _ in range(MAX_BATCHES):
        names = list(supabase.rpc("ingest_unclaimed_area_plan_objects", {
            "p_min_age_seconds": int(min_age_seconds),
        }).execute().data or [])
        if not names:
            break
        if dry_run:
            logger.info("Area plans: %d no area names: %s", len(names), ", ".join(names))
            return len(names)
        removed = storage.from_(BUCKET).remove(names) or []
        total += len(removed)
        if len(removed) < len(names):
            logger.warning(
                "Area plans: Storage deleted %d of the %d no area names. The bucket's DELETE policy "
                "refused the rest, or they were already gone; the next run asks again.",
                len(removed), len(names))
            break
        if len(names) < BATCH:
            break
    if total:
        logger.info("Area plans: deleted %d that no area names any more.", total)
    return total


def _supabase_client():
    """PostgREST as the ingestion principal, as cold_archive.py reaches it."""
    from supabase import create_client

    client = create_client(SUPABASE_URL, SUPABASE_GATEWAY_KEY)
    client.postgrest.auth(SUPABASE_INGESTION_KEY)
    return client


def main(argv=None):
    parser = argparse.ArgumentParser(description="Delete the area plans no area names any more.")
    parser.add_argument("--dry-run", action="store_true", help="list them and delete nothing")
    args = parser.parse_args(argv)

    # Without it every call is anon's, which the gate refuses: say so rather than fail on a 42501.
    if not SUPABASE_INGESTION_KEY:
        logger.error("Area plans: SUPABASE_INGESTION_KEY is not set. The sweep runs as the ingestion "
                     "principal, and nothing else may list or delete what no area names.")
        return 2
    try:
        sweep(_supabase_client(), _storage_client(), dry_run=args.dry_run)
    except Exception as err:  # noqa: BLE001 - one line in the Job's log, and a failed Job
        logger.error("Area plans: the sweep failed: %s. The next run tries again.", err)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

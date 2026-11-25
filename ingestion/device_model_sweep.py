#!/usr/bin/env python3
"""
Delete the 3D models nothing names any more. The chart's device-model-sweep CronJob runs it hourly:

    python -m device_model_sweep             # delete them
    python -m device_model_sweep --dry-run   # list them and delete nothing

A device's 3D model is an object in the public `asset-3d-models` bucket that `devices.model_3d_path`
names. One is left behind when the dashboard fails to delete the file it replaced or removed, and when a
device that was never archived is deleted. Before 1.10.0, replacing a model with a file of another name
left the old one every time. `ingest_unclaimed_device_model_objects()` (0329) lists the objects that no
device, no retired device's tombstone and no open proposal names, once they have gone a day untouched.
The day spares a model the dashboard has uploaded and not yet recorded on its device. This deletes them
through the Storage API, the only way bytes leave a bucket.

It runs as the ingestion principal, with SUPABASE_INGESTION_KEY. The bucket's SELECT and DELETE policies
admit that principal to an object nothing names and to no other, so a model a device shows survives
whatever this is asked.

Related: supabase/README.md -> "A 3D model no device names is swept from storage (0329)", and
         area_plan_sweep.py, whose loop and clients this reuses.
"""
import argparse
import os
import sys

from area_plan_sweep import _supabase_client, delete_unclaimed
from capture_worker import SUPABASE_INGESTION_KEY, _storage_client
from logging_config import get_logger

logger = get_logger("device-model-sweep")

# The bucket the chart and storage-policies.sql name. One set elsewhere has no policy for the sweep.
BUCKET = "asset-3d-models"
GATE = "ingest_unclaimed_device_model_objects"
# How long an object nothing names must have gone untouched before it is deleted.
MIN_AGE_SECONDS = int(os.getenv("DEVICE_MODEL_SWEEP_MIN_AGE_SECONDS", "86400"))


def sweep(supabase, storage, min_age_seconds=MIN_AGE_SECONDS, dry_run=False):
    """Delete the models nothing names. Returns how many were deleted, or listed on a dry run."""
    return delete_unclaimed(supabase, storage, logger, "3D models", "nothing names", BUCKET, GATE,
                            min_age_seconds, dry_run)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Delete the 3D models nothing names any more.")
    parser.add_argument("--dry-run", action="store_true", help="list them and delete nothing")
    args = parser.parse_args(argv)

    # Without it every call is anon's, which the gate refuses: say so rather than fail on a 42501.
    if not SUPABASE_INGESTION_KEY:
        logger.error("3D models: SUPABASE_INGESTION_KEY is not set. The sweep runs as the ingestion "
                     "principal, and nothing else may list or delete what nothing names.")
        return 2
    try:
        sweep(_supabase_client(), _storage_client(), dry_run=args.dry_run)
    except Exception as err:  # noqa: BLE001 - one line in the Job's log, and a failed Job
        logger.error("3D models: the sweep failed: %s. The next run tries again.", err)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

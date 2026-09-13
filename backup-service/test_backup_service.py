"""
The backup service (0101), against the live stack.

WHAT IS UNDER TEST, in order of what would be worst to get wrong: nobody but an Administrator can
queue a backup, and no PostgREST role can call the service's gates; a backup an Administrator asks
for is taken -- both dumps, the storage objects and the forge, each with the digest the row
records, and a manifest restore-databases.sh can read; the thread records who asked and that the
service wrote it; a request nobody has claimed is refused a twin, can be cancelled, and says why;
and a pinned backup is released once.

Needs the stack up with the backup-service container, the seeded personas and both keys. The
cancel test stops the service container for a few seconds. Skips without the keys.

    SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... python backup-service/test_backup_service.py
"""
import json
import os
import sys
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "supabase", "functions", "enroll-gateway"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-harness"))
from test_enroll_gateway import ADMIN_PASSWORD, ANON_KEY, SERVICE_ROLE_KEY, SUPABASE_URL, rest, sign_in  # noqa: E402
import stack_exec  # noqa: E402  -- kubectl exec into the release's pods

OPERATOR_EMAIL = os.getenv("ACS_OPERATOR_EMAIL", "operator@acs-cymru.local")
NOTE = "test_backup_service.py"
# A backup of a developer stack takes well under a minute; a poll of fifteen seconds precedes it.
BACKUP_TIMEOUT_SECONDS = int(os.getenv("BACKUP_TIMEOUT_SECONDS", "300"))


def service(*args, check=True):
    """Run a command inside the backup service, where the files it wrote live."""
    return stack_exec.run("backup-service", *args, check=check).stdout


def psql(sql):
    """One statement as postgres, the way the migrations run."""
    return stack_exec.output("supabase-db", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql).strip()


def rpc(name, body, bearer):
    try:
        return rest(f"/rpc/{name}", method="POST", body=body, key=ANON_KEY, bearer=bearer)
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        return err.code, (json.loads(raw) if raw.strip() else None)


def query(path, bearer):
    return rest(path, key=ANON_KEY, bearer=bearer)[1]



@unittest.skipIf(not SERVICE_ROLE_KEY or not ANON_KEY, "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY must be set")
class BackupServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin = sign_in()
        if not stack_exec.running("backup-service"):
            raise unittest.SkipTest(f"{stack_exec.describe('backup-service')} is not running")
        # A clean slate: a job left over from an earlier run would make the single-flight refusal
        # fire on the wrong test.
        psql("UPDATE public.backup_jobs SET status = 'CANCELLED', finished_at = now() WHERE status = 'PENDING'")
        cls.wait_for_idle()

    @classmethod
    def tearDownClass(cls):
        if not stack_exec.running("backup-service"):
            stack_exec.start("backup-service")
        # The backups this file took: files first, then the row, the way the service prunes.
        for line in psql(f"SELECT id || ' ' || location FROM public.backups WHERE note = '{NOTE}'").splitlines():
            backup_id, location = line.split(" ", 1)
            service("rm", "-rf", location, check=False)
            psql(f"UPDATE public.backups SET pinned = false WHERE id = '{backup_id}'")
            psql(f"SELECT public.backup_forget('{backup_id}', 'test_backup_service.py cleanup')")

    @classmethod
    def wait_for_idle(cls, timeout=BACKUP_TIMEOUT_SECONDS):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if psql("SELECT count(*) FROM public.backup_jobs WHERE status IN ('PENDING', 'RUNNING')") == "0":
                return
            time.sleep(3)
        raise RuntimeError("a backup job stayed in flight")

    # ---------------------------------------------------------------------------------------------
    def test_01_only_an_administrator_may_ask(self):
        try:
            operator = sign_in(OPERATOR_EMAIL, ADMIN_PASSWORD)
        except urllib.error.HTTPError:
            self.skipTest("the seeded Operator persona is not available with the default password")
        status, body = rpc("request_backup", {"p_note": NOTE}, operator)
        self.assertIn(status, (401, 403), body)
        self.assertEqual(psql(f"SELECT count(*) FROM public.backup_jobs WHERE note = '{NOTE}' AND requested_by IS NOT NULL AND origin = 'requested' AND status = 'PENDING'"), "0")
        # And the tables are theirs to read as little as to write.
        self.assertEqual(query("/backups?select=id", operator), [])
        self.assertEqual(query("/backup_jobs?select=id", operator), [])

    def test_02_the_gates_are_closed_to_every_postgrest_role(self):
        for name, body in [
            ("backup_claim_job", {}),
            ("backup_fail", {"p_job_id": "00000000-0000-0000-0000-000000000000", "p_error": "x"}),
            ("backup_reconcile_jobs", {"p_reason": "x"}),
            ("backup_prunable", {"p_retention_days": 1}),
            ("backup_schedule", {"p_cron": ""}),
        ]:
            for bearer in (self.admin, SERVICE_ROLE_KEY):
                status, _ = rpc(name, body, bearer)
                self.assertIn(status, (401, 403, 404), f"{name} answered {status} to a PostgREST caller")

    def test_03_a_requested_backup_is_taken_and_recorded(self):
        status, job_id = rpc("request_backup", {"p_note": NOTE}, self.admin)
        self.assertEqual(status, 200, job_id)

        # Who asked, as a user.
        self.assertEqual(psql(
            f"SELECT actor_source || ' ' || (changed_by IS NOT NULL)::text FROM public.digital_thread "
            f"WHERE entity_type = 'backup_jobs' AND entity_id = '{job_id}' AND action = 'BACKUP_REQUESTED'"
        ), "user true")

        deadline = time.time() + BACKUP_TIMEOUT_SECONDS
        job = None
        while time.time() < deadline:
            job = query(f"/backup_jobs?id=eq.{job_id}&select=*", self.admin)[0]
            if job["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
                break
            time.sleep(3)
        self.assertEqual(job["status"], "COMPLETED", job.get("error"))

        backup = query(f"/backups?id=eq.{job['backup_id']}&select=*", self.admin)[0]
        self.assertEqual(backup["origin"], "requested")
        self.assertTrue(backup["pinned"], "a requested backup is born pinned")
        self.assertEqual(backup["note"], NOTE)
        names = {c["name"] for c in backup["components"]}
        self.assertEqual(names, {"supabase-db", "timescaledb", "storage-objects", "forge"})
        self.assertEqual(backup["size_bytes"], sum(c["size_bytes"] for c in backup["components"]))

        # The files are where the row says, as big as it says, with the digest it says.
        listing = service("ls", "-1", backup["location"]).split()
        self.assertIn(f"manifest-{backup['stamp']}.txt", listing)
        self.assertIn("manifest.json", listing)
        for component in backup["components"]:
            self.assertIn(component["file"], listing)
            digest = service("sha256sum", f"{backup['location']}/{component['file']}").split()[0]
            self.assertEqual(digest, component["sha256"], component["file"])
            size = int(service("stat", "-c", "%s", f"{backup['location']}/{component['file']}"))
            self.assertEqual(size, component["size_bytes"], component["file"])

        # The text manifest names the dumps the way restore-databases.sh looks them up.
        manifest = service("cat", f"{backup['location']}/manifest-{backup['stamp']}.txt")
        self.assertIn(f"stamp={backup['stamp']}", manifest)
        self.assertIn("format=", manifest)
        self.assertIn("supabase_db=supabase-db-", manifest)
        self.assertIn("timescaledb=timescaledb-", manifest)
        self.assertIn("forge=forge-", manifest)

        # The forge archive carries a database copy that passes its own integrity check.
        forge = next(c for c in backup["components"] if c["name"] == "forge")
        self.assertIn(forge.get("sqlite"), ("sqlite-online-backup", "raw-copy-with-checkpoint"))
        members = service("tar", "-tzf", f"{backup['location']}/{forge['file']}")
        self.assertIn("gitea/gitea.db", members)
        self.assertIn("./ssh/", members, "the host keys appliances pin are in the archive")

        # And the service witnessed it.
        self.assertEqual(psql(
            f"SELECT actor_source || ' ' || (changed_by IS NULL)::text FROM public.digital_thread "
            f"WHERE entity_type = 'backups' AND entity_id = '{backup['id']}' AND action = 'BACKUP_TAKEN'"
        ), "service true")

    def test_04_a_queued_request_refuses_a_twin_and_can_be_cancelled(self):
        stack_exec.stop("backup-service")
        try:
            status, job_id = rpc("request_backup", {"p_note": NOTE}, self.admin)
            self.assertEqual(status, 200, job_id)

            status, body = rpc("request_backup", {"p_note": NOTE}, self.admin)
            self.assertIn(status, (400, 409), body)
            self.assertIn("has not been claimed", json.dumps(body))

            status, cancelled = rpc("cancel_backup_job", {"p_job_id": job_id}, self.admin)
            self.assertEqual((status, cancelled), (200, True))
            status, again = rpc("cancel_backup_job", {"p_job_id": job_id}, self.admin)
            self.assertEqual((status, again), (200, False), "cancelling twice is a no-op, not an error")
            self.assertEqual(psql(
                f"SELECT count(*) FROM public.digital_thread WHERE entity_type = 'backup_jobs' "
                f"AND entity_id = '{job_id}' AND action = 'BACKUP_CANCELLED' AND actor_source = 'user'"
            ), "1")
        finally:
            stack_exec.start("backup-service")

    def test_05_a_pinned_backup_is_released_once(self):
        rows = query(f"/backups?note=eq.{NOTE}&pinned=eq.true&select=id&order=taken_at.desc&limit=1", self.admin)
        self.assertTrue(rows, "test_03 left a pinned backup to release")
        backup_id = rows[0]["id"]

        status, released = rpc("release_backup", {"p_backup_id": backup_id}, self.admin)
        self.assertEqual((status, released), (200, True))
        row = query(f"/backups?id=eq.{backup_id}&select=pinned,released_at,released_by", self.admin)[0]
        self.assertFalse(row["pinned"])
        self.assertIsNotNone(row["released_at"])
        self.assertIsNotNone(row["released_by"])

        status, again = rpc("release_backup", {"p_backup_id": backup_id}, self.admin)
        self.assertEqual((status, again), (200, False))
        self.assertEqual(psql(
            f"SELECT count(*) FROM public.digital_thread WHERE entity_type = 'backups' "
            f"AND entity_id = '{backup_id}' AND action = 'BACKUP_RELEASED'"
        ), "1")


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""
The backup service (0101), against the live stack.

WHAT IS UNDER TEST, in order of what would be worst to get wrong: nobody but an Administrator can
queue a backup, and no PostgREST role can call the service's gates; a backup an Administrator asks
for is taken -- both dumps, the storage objects, the forge, the broker's document and, with TLS
on, the internal CA, each with the digest the row records, and a manifest restore-databases.sh
can read; the trail records who asked and that the service wrote it; a request nobody has
claimed is refused a twin, can be cancelled, and says why; a pinned backup is released once; a
RUNNING job no service is running is failed, so a restored database does not refuse backups; a
failed job is followed by a prune that leaves the newest three backups alone; and, with a MinIO of
the test's own as the destination, a backup is copied off site encrypted to a key the stack never
holds, and a pruned backup takes its copy with it.

Needs the stack up with the backup-service container, the seeded personas and both keys. The
cancel test stops the service container for a few seconds. The off-site test applies
test-harness/restore-rehearsal/minio.yaml and deletes its namespace afterwards; it skips on a stack
that already has a destination, or NetworkPolicies. Skips without the keys.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... python backup-service/test_backup_service.py
"""
import json
import os
import re
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "supabase", "functions", "enroll-gateway"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-harness"))
from test_enroll_gateway import ADMIN_PASSWORD, PUBLISHABLE_KEY, SERVICE_ROLE_KEY, rest, sign_in  # noqa: E402
import stack_exec  # noqa: E402  -- kubectl exec into the release's pods

OPERATOR_EMAIL = os.getenv("ABER_OPERATOR_EMAIL", "operator@aber.local")
NOTE = "test_backup_service.py"
# A job with this note fails at backup_finalise(), refused by a trigger test_07 installs.
FAILING_NOTE = "test_backup_service.py: a failing job"
STAMP = re.compile(r"^\d{8}T\d{6}Z$")

# test_08's off-site store: a MinIO in a namespace of its own, the rehearsal's manifest.
MINIO_MANIFEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-harness", "restore-rehearsal", "minio.yaml")
OFFSITE_NS = "rehearsal-offsite"
OFFSITE_ENDPOINT = f"http://minio.{OFFSITE_NS}.svc.cluster.local:9000"
OFFSITE_BUCKET = "aber-offsite-test"
OFFSITE_PREFIX = "test-backup-service"
# The manifest's root credential, handed to the aws CLI inside the service's pod.
OFFSITE_AWS = ("AWS_ACCESS_KEY_ID=rehearsal", "AWS_SECRET_ACCESS_KEY=rehearsal-secret-key",
               "AWS_DEFAULT_REGION=us-east-1", "AWS_EC2_METADATA_DISABLED=true",
               "AWS_REQUEST_CHECKSUM_CALCULATION=when_required")


def kubectl(*args, namespace=None, input=None, check=True):
    cmd = ["kubectl", *(["-n", namespace] if namespace else []), *args]
    result = subprocess.run(cmd, capture_output=True, text=True, input=input)
    if check and result.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout
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
        return rest(f"/rpc/{name}", method="POST", body=body, bearer=bearer)
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        return err.code, (json.loads(raw) if raw.strip() else None)


def query(path, bearer):
    return rest(path, bearer=bearer)[1]



@unittest.skipIf(not SERVICE_ROLE_KEY or not PUBLISHABLE_KEY, "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY must be set")
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
            ("backup_offsite_destination", {}),
            ("backup_offsite_next", {}),
            ("backup_offsite_record", {"p_backup_id": "00000000-0000-0000-0000-000000000000",
                                       "p_location": None, "p_objects": None, "p_error": "x"}),
        ]:
            for bearer in (self.admin, SERVICE_ROLE_KEY):
                status, _ = rpc(name, body, bearer)
                self.assertIn(status, (401, 403, 404), f"{name} answered {status} to a PostgREST caller")

    def test_03_a_requested_backup_is_taken_and_recorded(self):
        status, job_id = rpc("request_backup", {"p_note": NOTE}, self.admin)
        self.assertEqual(status, 200, job_id)

        # Who asked, as a user.
        self.assertEqual(psql(
            f"SELECT actor_source || ' ' || (changed_by IS NOT NULL)::text FROM public.audit_trail "
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
        # The CA is present when the stack was installed with TLS (backup.ca.secretName), absent
        # otherwise; the historian's dump is absent while pgBackRest backs it up
        # (timescaledb.physicalBackup); everything else the dev cluster mounts.
        dumps_historian = service("printenv", "DUMP_TIMESCALE", check=False).strip() != "false"
        expected = {"supabase-db", "vault-key", "storage-objects", "forge", "broker"}
        if dumps_historian:
            expected.add("timescaledb")
        self.assertLessEqual(expected, names, names)
        self.assertLessEqual(names, expected | {"ca"}, names)
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
        self.assertIn("timescaledb=timescaledb-" if dumps_historian else "timescaledb=physical", manifest)
        self.assertIn("forge=forge-", manifest)

        # The forge archive carries a database copy that passes its own integrity check.
        forge = next(c for c in backup["components"] if c["name"] == "forge")
        self.assertIn(forge.get("sqlite"), ("sqlite-online-backup", "raw-copy-with-checkpoint"))
        members = service("tar", "-tzf", f"{backup['location']}/{forge['file']}")
        self.assertIn("gitea/gitea.db", members)
        self.assertIn("./ssh/", members, "the host keys appliances pin are in the archive")

        # pgsodium's root key, as the file on the data volume holds it: Vault is ciphertext under it.
        self.assertIn("vault_key=vault-key-", manifest)
        vault_key = next(c for c in backup["components"] if c["name"] == "vault-key")
        self.assertRegex(service("cat", f"{backup['location']}/{vault_key['file']}").strip(), r"^[0-9a-f]{64}$")

        # The broker archive is the data volume: the document is every issued gateway account.
        self.assertIn("broker=broker-", manifest)
        broker = next(c for c in backup["components"] if c["name"] == "broker")
        members = service("tar", "-tzf", f"{backup['location']}/{broker['file']}")
        self.assertIn("./dynamic-security.json", members)

        # The CA, when the stack names one: the key pair under ca/, read from the Secret the row names.
        ca = next((c for c in backup["components"] if c["name"] == "ca"), None)
        if ca is not None:
            self.assertIn("ca=ca-", manifest)
            self.assertRegex(ca.get("secret", ""), r"^[a-z0-9-]+/[a-z0-9.-]+$")
            self.assertLessEqual({"tls.crt", "tls.key"}, set(ca.get("keys", [])))
            members = service("tar", "-tzf", f"{backup['location']}/{ca['file']}")
            self.assertIn("./ca/tls.key", members)
            self.assertIn("./ca/tls.crt", members)

        # And the service witnessed it.
        self.assertEqual(psql(
            f"SELECT actor_source || ' ' || (changed_by IS NULL)::text FROM public.audit_trail "
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
                f"SELECT count(*) FROM public.audit_trail WHERE entity_type = 'backup_jobs' "
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
            f"SELECT count(*) FROM public.audit_trail WHERE entity_type = 'backups' "
            f"AND entity_id = '{backup_id}' AND action = 'BACKUP_RELEASED'"
        ), "1")

    def test_06_a_running_job_no_service_is_running_is_failed(self):
        # The shape a restore leaves behind: the dump was taken while a job was RUNNING, so the
        # restored database carries that row, and request_backup() refuses while it stands. The
        # service fails it before its next claim, without a restart.
        self.wait_for_idle()
        # With the service stopped, so the refusal is observed before the reconcile runs.
        stack_exec.stop("backup-service")
        try:
            # Through a CTE, so psql prints the id alone and not the INSERT's command tag with it.
            job_id = psql(
                "WITH j AS (INSERT INTO public.backup_jobs (origin, status, started_at) "
                "VALUES ('scheduled', 'RUNNING', now() - interval '1 hour') RETURNING id) "
                "SELECT id FROM j"
            )
            status, body = rpc("request_backup", {"p_note": NOTE}, self.admin)
            self.assertIn(status, (400, 409), body)
            self.assertIn("is running", json.dumps(body))
        finally:
            stack_exec.start("backup-service")

        deadline = time.time() + 120
        while time.time() < deadline:
            if psql(f"SELECT status FROM public.backup_jobs WHERE id = '{job_id}'") == "FAILED":
                break
            time.sleep(3)
        row = query(f"/backup_jobs?id=eq.{job_id}&select=status,error", self.admin)[0]
        self.assertEqual(row["status"], "FAILED", row)
        self.assertIn("no backup service was running this job", row["error"])
        self.assertEqual(psql(
            f"SELECT count(*) FROM public.audit_trail WHERE entity_type = 'backup_jobs' "
            f"AND entity_id = '{job_id}' AND action = 'BACKUP_FAILED' AND actor_source = 'service'"
        ), "1")

        # And the way is clear again.
        status, new_job = rpc("request_backup", {"p_note": NOTE}, self.admin)
        self.assertEqual(status, 200, new_job)
        status, cancelled = rpc("cancel_backup_job", {"p_job_id": new_job}, self.admin)
        if status != 200 or not cancelled:
            self.wait_for_idle()

    def test_07_a_failed_job_prunes_nothing_inside_the_floor(self):
        # Four scheduled backups older than any window, then a job that fails at its last step.
        # The service prunes after the failure, and backup_prunable() never hands it the newest
        # three rows. How many of the four are among those depends on the backups the stack already
        # has; the floor's arithmetic on old rows is test_backup_health.py's, and this is that the
        # failure path prunes and leaves the floor alone.
        self.wait_for_idle()
        fakes = [f"2001010{i}T000000Z" for i in range(1, 5)]
        for age, stamp in enumerate(fakes):
            service("sh", "-c", f"mkdir -p /backups/{stamp} && echo floor > /backups/{stamp}/marker")
            psql(
                "INSERT INTO public.backups (stamp, origin, note, location, taken_at) "
                f"VALUES ('{stamp}', 'scheduled', '{NOTE}', '/backups/{stamp}', now() - interval '{400 + age} days')"
            )
        floor = psql("SELECT stamp || ' ' || location FROM public.backups ORDER BY taken_at DESC, stamp DESC LIMIT 3").splitlines()
        floor = dict(line.split(" ", 1) for line in floor)
        doomed = [s for s in fakes if s not in floor]
        orphans_before = self.unrecorded_directories()

        # The failure: backup_finalise() refused, after the files were written and renamed.
        psql(
            "CREATE OR REPLACE FUNCTION public.test_backup_service_refuse() RETURNS trigger "
            "LANGUAGE plpgsql AS $$ BEGIN IF NEW.note = '" + FAILING_NOTE + "' THEN "
            "RAISE EXCEPTION 'test_backup_service.py refused this backup'; END IF; RETURN NEW; END $$"
        )
        psql(
            "CREATE OR REPLACE TRIGGER test_backup_service_refuse BEFORE INSERT ON public.backups "
            "FOR EACH ROW EXECUTE FUNCTION public.test_backup_service_refuse()"
        )
        try:
            status, job_id = rpc("request_backup", {"p_note": FAILING_NOTE}, self.admin)
            self.assertEqual(status, 200, job_id)
            deadline = time.time() + BACKUP_TIMEOUT_SECONDS
            while time.time() < deadline:
                job = query(f"/backup_jobs?id=eq.{job_id}&select=status,error", self.admin)[0]
                if job["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
                    break
                time.sleep(3)
            self.assertEqual(job["status"], "FAILED", job)
            self.assertIn("refused this backup", job["error"])

            # The prune follows the failure in the same poll.
            deadline = time.time() + 60
            while time.time() < deadline and doomed:
                if psql(f"SELECT count(*) FROM public.backups WHERE stamp IN ({', '.join(repr(s) for s in doomed)})") == "0":
                    break
                time.sleep(3)
        finally:
            psql("DROP TRIGGER IF EXISTS test_backup_service_refuse ON public.backups")
            psql("DROP FUNCTION IF EXISTS public.test_backup_service_refuse()")

        for stamp, location in floor.items():
            self.assertEqual(psql(f"SELECT count(*) FROM public.backups WHERE stamp = '{stamp}'"), "1", f"{stamp} is in the floor and was pruned")
            self.assertEqual(service("sh", "-c", f"test -d '{location}' && echo present || echo absent").strip(), "present", location)
        for stamp in doomed:
            self.assertEqual(psql(f"SELECT count(*) FROM public.backups WHERE stamp = '{stamp}'"), "0", f"{stamp} is outside the floor and was not pruned after the failure")
            self.assertEqual(service("sh", "-c", f"test -d /backups/{stamp} && echo present || echo absent").strip(), "absent")
        # And the failed job's own directory went with it.
        self.assertLessEqual(self.unrecorded_directories(), orphans_before)

    def test_08_a_backup_is_copied_off_site_encrypted_and_its_copy_follows_the_prune(self):
        # A MinIO of the test's own, the destination set the way the page's dialog sets it, and a
        # backup: the copy lands, each object is the ciphertext of a file the backup holds, and the
        # identity the stack never held turns it back into that file. A backup the prune after that
        # job removes takes its copy with it.
        if psql("SELECT count(*) FROM public.system_settings WHERE starts_with(key, 'backup_offsite.') "
                "AND value NOT IN ('\"\"'::jsonb, 'false'::jsonb)") != "0":
            self.skipTest("this stack has an off-site destination already, which the test will not replace")
        if kubectl("get", "networkpolicy", "-o", "name", namespace=stack_exec.NAMESPACE).strip():
            self.skipTest("NetworkPolicies are on, and the backup service has no egress rule for the test's MinIO")
        self.wait_for_idle()

        with open(MINIO_MANIFEST, encoding="utf-8") as handle:
            kubectl("apply", "-f", "-", input=handle.read())
        self.addCleanup(kubectl, "delete", "namespace", OFFSITE_NS, "--wait=false", check=False)
        kubectl("rollout", "status", "deploy/minio", "--timeout=180s", namespace=OFFSITE_NS)

        # The aws CLI in the service's own pod, path-style, as the root user of the test's MinIO.
        service("sh", "-c", "printf '[default]\\ns3 =\\n  addressing_style = path\\n' > /tmp/offsite-test-aws")
        self.addCleanup(service, "rm", "-f", "/tmp/offsite-test-aws", "/tmp/offsite-test.key",
                        "/tmp/offsite-test.age", "/tmp/offsite-test.plain", check=False)

        def aws(*args):
            return service("env", *OFFSITE_AWS, "AWS_CONFIG_FILE=/tmp/offsite-test-aws",
                           "aws", "--endpoint-url", OFFSITE_ENDPOINT, "--output", "json", *args)

        aws("s3api", "create-bucket", "--bucket", OFFSITE_BUCKET)

        # The identity is made and kept here; only the recipient goes to the stack.
        identity = service("age-keygen")
        recipient = re.search(r"^# public key: (age1[0-9a-z]+)$", identity, re.M).group(1)
        status, body = rpc("set_backup_offsite_destination", {
            "p_endpoint": OFFSITE_ENDPOINT, "p_region": "us-east-1", "p_bucket": OFFSITE_BUCKET,
            "p_prefix": OFFSITE_PREFIX, "p_access_key_id": "rehearsal", "p_recipient": recipient,
            "p_path_style": True,
        }, self.admin)
        self.assertIn(status, (200, 204), body)
        self.addCleanup(rpc, "clear_backup_offsite_destination", {}, self.admin)
        status, body = rpc("set_backup_offsite_credential", {"p_secret": "rehearsal-secret-key"}, self.admin)
        self.assertIn(status, (200, 204), body)
        self.assertEqual(rpc("backup_offsite_credential_is_set", {}, self.admin), (200, True))

        # An old backup with a copy, older than every other: pruned after the job below, copy and
        # all, unless fewer than three backups are newer than it, when the floor keeps both.
        old = "20010105T000000Z"
        old_prefix = f"{OFFSITE_PREFIX}/{old}/"
        service("sh", "-c", f"mkdir -p /backups/{old} && echo floor > /backups/{old}/marker")
        aws("s3api", "put-object", "--bucket", OFFSITE_BUCKET, "--key", f"{old_prefix}marker.age", "--body", f"/backups/{old}/marker")
        psql(
            "INSERT INTO public.backups (stamp, origin, note, location, taken_at, offsite_state, offsite_location) "
            f"VALUES ('{old}', 'scheduled', '{NOTE}', '/backups/{old}', now() - interval '500 days', 'COPIED', "
            f"'{OFFSITE_ENDPOINT}/{OFFSITE_BUCKET}/{old_prefix}')"
        )
        newer = int(psql(f"SELECT count(*) FROM public.backups WHERE stamp <> '{old}'"))

        status, job_id = rpc("request_backup", {"p_note": NOTE}, self.admin)
        self.assertEqual(status, 200, job_id)
        deadline = time.time() + BACKUP_TIMEOUT_SECONDS
        row = None
        while time.time() < deadline:
            job = query(f"/backup_jobs?id=eq.{job_id}&select=status,error,backup_id", self.admin)[0]
            self.assertNotIn(job["status"], ("FAILED", "CANCELLED"), job)
            if job["status"] == "COMPLETED":
                row = query(f"/backups?id=eq.{job['backup_id']}&select=*", self.admin)[0]
                if row["offsite_state"] == "COPIED":
                    break
            time.sleep(3)
        self.assertEqual((row or {}).get("offsite_state"), "COPIED", row)
        self.assertEqual(row["offsite_location"], f"{OFFSITE_ENDPOINT}/{OFFSITE_BUCKET}/{OFFSITE_PREFIX}/{row['stamp']}/")

        # One object per file, the manifests included, each the size the row recorded.
        listing = json.loads(aws("s3api", "list-objects-v2", "--bucket", OFFSITE_BUCKET, "--prefix", f"{OFFSITE_PREFIX}/{row['stamp']}/"))
        stored = {o["Key"]: o["Size"] for o in listing["Contents"]}
        files = {c["file"] for c in row["components"]} | {"manifest.json", f"manifest-{row['stamp']}.txt"}
        self.assertEqual({o["file"] for o in row["offsite_objects"]}, files)
        for o in row["offsite_objects"]:
            self.assertEqual(stored.get(o["key"]), o["size_bytes"], o["key"])

        # The ciphertext is not the dump, and the identity makes it the dump again, byte for byte.
        dump = next(c for c in row["components"] if c["name"] == "supabase-db")
        aws("s3api", "get-object", "--bucket", OFFSITE_BUCKET, "--key", f"{OFFSITE_PREFIX}/{row['stamp']}/{dump['file']}.age", "/tmp/offsite-test.age")
        self.assertEqual(service("head", "-c", "21", "/tmp/offsite-test.age"), "age-encryption.org/v1")
        stack_exec.run("backup-service", "sh", "-c", "umask 077; cat > /tmp/offsite-test.key", input=identity, check=True)
        service("age", "-d", "-i", "/tmp/offsite-test.key", "-o", "/tmp/offsite-test.plain", "/tmp/offsite-test.age")
        self.assertEqual(service("sha256sum", "/tmp/offsite-test.plain").split()[0], dump["sha256"])

        # The old backup and its copy, together.
        remaining = json.loads(aws("s3api", "list-objects-v2", "--bucket", OFFSITE_BUCKET, "--prefix", old_prefix) or "{}")
        if newer + 1 >= 3:
            self.assertEqual(psql(f"SELECT count(*) FROM public.backups WHERE stamp = '{old}'"), "0")
            self.assertEqual(remaining.get("Contents", []), [], "the prune removed the backup and left its copy")
            self.assertIn("was deleted", psql(
                "SELECT new_data ->> 'reason' FROM public.audit_trail WHERE action = 'BACKUP_PRUNED' "
                f"AND old_data ->> 'stamp' = '{old}' ORDER BY recorded_at DESC LIMIT 1"))
        else:
            self.assertEqual(psql(f"SELECT count(*) FROM public.backups WHERE stamp = '{old}'"), "1")
            self.assertEqual(len(remaining.get("Contents", [])), 1, "the floor kept the backup and not its copy")

    @staticmethod
    def unrecorded_directories():
        """Stamp-named directories on the volume that no backups row names."""
        on_disk = {name for name in service("ls", "-1", "/backups").split() if STAMP.match(name)}
        return on_disk - set(psql("SELECT stamp FROM public.backups").split())


if __name__ == "__main__":
    unittest.main(verbosity=2)

# suite:
#   lanes: stack
#   why: A gateway that stops being Remote loses its appliance's deploy key, as an archived one does,
#     and keeps its repository out of the forge's archive. Changed back to Remote and set up again, the
#     new appliance's key is registered at enrolment. A key left on the repository would let the old
#     appliance pull its flow and push its branch after the broker credential was ended. Needs the
#     stack, the forge, the seeded Administrator, the organisation and FORGE_SWEEP_SECRET.

"""
The forge sweep follows a change of a gateway's type (0311), against the live stack.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... FORGE_SWEEP_SECRET=... \\
      python supabase/functions/forge-sweep/test_forge_sweep_follows_the_gateway_type.py

Each test holds the sweep lease, as test_forge_sweep.py's do, so the pass whose report it reads is
its own. The change of type asks the database for a pass at once, and that ask meets the lease.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_forge_sweep import (  # noqa: E402
    ORGANISATION, PLATFORM_ORGANISATION, PLATFORM_REPOSITORY, ForgeSweepBase, delete_broker_account, enroll,
    forge, rest, sign_in, stack_sign_in, sweep,
)
from test_enroll_gateway import (  # noqa: E402
    check_sparkplug_id, delete_gateway_and_wait_for_revoke, sparkplug_id_of,
)

# Differs from every other suite's fixture id in its first block: sparkplug_id is the first 21 hex
# characters of the uuid.
TEST_GW_ID = "f5af1000-0000-4000-8000-000000000001"


def a_public_key():
    key_dir = tempfile.mkdtemp(prefix="aber-forge-type-")
    try:
        key_path = os.path.join(key_dir, "id_ed25519")
        subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "test", "-f", key_path],
                       check=True, capture_output=True)
        with open(f"{key_path}.pub", encoding="utf-8") as handle:
            return handle.read().strip()
    finally:
        shutil.rmtree(key_dir, ignore_errors=True)


class TestTheKeyFollowsTheType(ForgeSweepBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        try:
            cls.admin_token = sign_in()
        except stack_sign_in.RateLimited:
            raise
        except Exception as err:  # noqa: BLE001
            raise unittest.SkipTest(f"could not sign in as the seeded administrator ({err})")
        cls.sparkplug_id = sparkplug_id_of(TEST_GW_ID)
        cls.repo = f"gateway-{cls.sparkplug_id}"
        # Class clean-ups, which Python also runs when setUpClass raises. In reverse: the repository,
        # the row, whose delete waits for the revoke it queues, then the account that outlives it.
        cls.addClassCleanup(delete_broker_account, cls.sparkplug_id)
        cls.addClassCleanup(delete_gateway_and_wait_for_revoke, TEST_GW_ID, cls.sparkplug_id)
        cls.addClassCleanup(forge, f"/repos/{ORGANISATION}/{cls.repo}", method="DELETE")
        # What a run that was killed left behind.
        forge(f"/repos/{ORGANISATION}/{cls.repo}", method="DELETE")
        delete_gateway_and_wait_for_revoke(TEST_GW_ID, cls.sparkplug_id)
        status, rows = rest(
            "/gateways", method="POST", prefer="return=representation",
            body={"id": TEST_GW_ID, "name": "Test_Forge_Sweep_Type", "status": "OFFLINE", "deployment": "remote"},
        )
        if status >= 300:
            raise unittest.SkipTest(f"could not create the test gateway: {rows}")
        check_sparkplug_id(TEST_GW_ID, rows[0]["sparkplug_id"])

    def set_type(self, deployment):
        status, _ = rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"deployment": deployment})
        self.assertIn(status, (200, 204))

    def enrol(self, public_key):
        _, rows = rest("/rpc/issue_gateway_enrollment_token", method="POST", bearer=self.admin_token,
                       body={"p_gateway_id": TEST_GW_ID, "p_ttl_minutes": 30})
        status, payload = enroll(rows[0]["token"], ssh_public_key=public_key)
        self.assertEqual(status, 200, payload)
        self.assertIsNotNone(payload.get("repository"), payload)

    def keys(self):
        status, keys = forge(f"/repos/{ORGANISATION}/{self.repo}/keys")
        self.assertEqual(status, 200, keys)
        return keys

    def platform_keys(self):
        status, keys = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/keys?limit=50")
        self.assertEqual(status, 200, keys)
        return [k for k in keys if k["title"] == f"gateway {self.sparkplug_id}"]

    def repository(self):
        status, repo = forge(f"/repos/{ORGANISATION}/{self.repo}")
        self.assertEqual(status, 200, repo)
        return repo

    def test_leaving_remote_removes_the_key_keeps_the_repository_and_enrolling_again_adds_one(self):
        self.enrol(a_public_key())
        self.assertEqual(len(self.keys()), 1)
        self.set_type("host")
        try:
            status, body = sweep()
            self.assertEqual(status, 200, body)
            self.assertTrue(any(entry.startswith(self.repo) for entry in body["revoked"]), body)
            self.assertEqual(self.keys(), [], "the old appliance can still reach the repository")
            self.assertEqual(self.platform_keys(), [], "the old appliance can still read the platform repository")
            self.assertFalse(self.repository()["archived"], "a change of type is not an archive")
            self.assertEqual(body["errors"], [], body)

            # A second pass has nothing left to remove.
            status, body = sweep()
            self.assertFalse(any(entry.startswith(self.repo) for entry in body["revoked"]), body)
        finally:
            self.set_type("remote")

        # Back to Remote, the repository has no key until the new appliance enrols.
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertEqual(self.keys(), [])
        new_key = a_public_key()
        self.enrol(new_key)
        (key,) = self.keys()
        self.assertEqual(key["key"].split()[:2], new_key.split()[:2])
        self.assertFalse(key["read_only"], key)
        status, body = sweep()
        self.assertEqual(len(self.keys()), 1, "the sweep removed the key of a gateway that is Remote again")


if __name__ == "__main__":
    unittest.main(verbosity=2)

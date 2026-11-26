# suite:
#   lanes: db
#   why: 0337. Reject deleted a registered device held again in Quarantine, with its schemas, nameplate and
#     links, and the hold can come from another gateway's message. Holds the refusal for every API caller,
#     its sentence, and that it deletes nothing; and that every writer that deletes a device still does:
#     a Reject of a device nobody registered, the merge, Permanent Delete after an archive, the nightly
#     purge, a replay lane going with its machine, and the owner's own connection.

"""
A registered device held again is not deleted by a Reject (0337).

    python supabase/migrations/test_a_registered_device_held_again_is_not_deleted_by_a_reject.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

  * A DELETE of a device that is in Quarantine, was registered before it was held and is not archived is
    refused for a Shopfloor Manager, an Administrator and service_role, as raise_exception with a sentence
    that names the device and says to approve it, or to archive it and delete it from Entities. Nothing
    goes: not the device, its nameplate or its schemas.
  * A device nobody registered is still rejected. The merge still deletes its duplicate. An archived held
    device is still deleted by Permanent Delete and by the nightly purge. A replay lane held again still
    goes with its archived machine. The owner's own connection deletes as before. A registered device that
    is not held is deleted as before.

Every test rolls back.
"""
import json
import os
import unittest
import uuid

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MANAGER = "a0d17070-0000-4000-8000-000000000337"
ADMIN = "a0d17070-0000-4000-8000-000000000338"
INGESTOR = "b0000000-0000-4000-8000-000000000002"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    """One transaction per test: fixtures as the owner, each delete as its caller, a rollback."""

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT to_regprocedure('public.refuse_deleting_a_registered_held_device()');")
            if cur.fetchone()[0] is None:
                raise unittest.SkipTest("0337 has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        self.tag = uuid.uuid4().hex[:8]
        for user_id, role in ((MANAGER, "Shopfloor_Manager"), (ADMIN, "Administrator")):
            self.cur.execute("INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                             (user_id, f"{user_id}@reject-0337.test"))
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) SELECT %s, id FROM public.roles WHERE name = %s"
                " ON CONFLICT DO NOTHING;", (user_id, role))

    # -- callers -------------------------------------------------------------------------------

    def as_user(self, user_id):
        self.cur.execute("SET ROLE authenticated;")
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps({"sub": user_id, "role": "authenticated", "aal": "aal2"}),))

    def as_service(self):
        self.cur.execute("SET ROLE service_role;")
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps({"role": "service_role"}),))

    def as_owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")

    # -- fixtures, as the owner ----------------------------------------------------------------

    def provisioned(self, name, seen=False):
        device = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, first_dbirth_at) VALUES (%s, %s, CASE WHEN %s THEN now() END);",
            (device, f"{name} {self.tag}", seen))
        return device

    def discovered(self, name):
        """A device nobody registered, as its first birth makes it."""
        self.as_user(INGESTOR)
        self.cur.execute(
            "SELECT id FROM public.ingest_register_quarantined_device(%s, NULL, %s, 'UNKNOWN_DEVICE: test',"
            " 'reported_identity');", (f"{name} {self.tag}", f"{name}-{self.tag}"))
        device = str(self.cur.fetchone()[0])
        self.as_owner()
        return device

    def hold(self, device):
        self.as_user(INGESTOR)
        self.cur.execute("SELECT public.ingest_requarantine_device(%s, %s, %s);",
                         (device, "GATEWAY_MISMATCH: test", f"wire-{self.tag}"))
        self.as_owner()

    def held_again(self, name):
        """A registered device that was heard from, and then held by the gate, with a nameplate."""
        device = self.provisioned(name, seen=True)
        self.cur.execute("INSERT INTO public.device_nameplate (device_id, serial_number) VALUES (%s, 'S-1');", (device,))
        self.hold(device)
        return device

    def archive(self, device, due=False):
        self.cur.execute(
            "UPDATE public.devices SET is_archived = true, archived_at = now(),"
            " auto_delete_at = now() + CASE WHEN %s THEN interval '-1 day' ELSE interval '30 days' END WHERE id = %s;",
            (due, device))

    # -- acts and reads ------------------------------------------------------------------------

    def delete(self, device):
        """The DELETE PostgREST sends for Reject and for Permanent Delete. The rows it deleted."""
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (device,))
        deleted = self.cur.rowcount
        self.as_owner()
        return deleted

    def exists(self, device):
        self.cur.execute("SELECT count(*) FROM public.devices WHERE id = %s;", (device,))
        return self.cur.fetchone()[0] == 1


class TheRefusal(Base):
    def refused(self, device, become):
        self.cur.execute("SAVEPOINT refused;")
        become()
        with self.assertRaises(psycopg2.errors.RaiseException) as raised:
            self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (device,))
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
        self.as_owner()
        return raised.exception.diag.message_primary

    def test_a_reject_of_a_registered_device_held_again_is_refused_for_every_caller(self):
        device = self.held_again("CNC_01")
        for name, become in (("Shopfloor Manager", lambda: self.as_user(MANAGER)),
                             ("Administrator", lambda: self.as_user(ADMIN)),
                             ("service_role", self.as_service)):
            with self.subTest(caller=name):
                said = self.refused(device, become)
                self.assertEqual(
                    said,
                    f'"CNC_01 {self.tag}" is a registered device held in Quarantine again, so it was not deleted. '
                    'Approve it on the Quarantine tab to let it in where it was, with its schemas, nameplate and links. '
                    'Or archive it, and then delete it from Entities.')

    def test_a_refusal_deletes_nothing(self):
        device = self.held_again("CNC_02")
        self.refused(device, lambda: self.as_user(MANAGER))
        self.cur.execute("SELECT d.is_quarantined, d.requarantined_at IS NOT NULL, n.serial_number FROM public.devices d"
                         " JOIN public.device_nameplate n ON n.device_id = d.id WHERE d.id = %s;", (device,))
        self.assertEqual(self.cur.fetchone(), (True, True, "S-1"))
        self.cur.execute("SELECT count(*) FROM public.retired_entities WHERE entity_id = %s;", (device,))
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_a_device_held_again_after_an_approval_is_refused_too(self):
        device = self.discovered("Approved")
        self.cur.execute("SELECT public.approve_quarantined_device(p_device_id => %s, p_actor_id => %s);", (device, MANAGER))
        self.hold(device)
        self.refused(device, lambda: self.as_user(MANAGER))


class EveryWriterThatDeletesADevice(Base):
    def test_a_reject_of_a_device_nobody_registered(self):
        device = self.discovered("Unknown")
        self.as_user(MANAGER)
        self.assertEqual(self.delete(device), 1)
        self.assertFalse(self.exists(device))

    def test_the_merge_deletes_its_duplicate(self):
        source, into = self.discovered("Duplicate"), self.provisioned("Candidate")
        # As approve-quarantine calls it, with the service key: the function runs as the owner.
        self.as_service()
        self.cur.execute("SELECT public.approve_quarantined_device(p_device_id => %s, p_actor_id => %s,"
                         " p_merge_into_device_id => %s);", (source, MANAGER, into))
        self.assertTrue(self.cur.fetchone()[0]["merged"])
        self.as_owner()
        self.assertFalse(self.exists(source))
        self.assertTrue(self.exists(into))

    def test_permanent_delete_after_an_archive(self):
        device = self.held_again("Archived")
        self.as_user(MANAGER)
        self.archive(device)
        self.assertEqual(self.delete(device), 1)
        self.assertFalse(self.exists(device))
        # Archived first, it leaves the tombstone Entities lists.
        self.cur.execute("SELECT count(*) FROM public.retired_entities WHERE entity_id = %s;", (device,))
        self.assertEqual(self.cur.fetchone()[0], 1)

    def test_the_nightly_purge(self):
        device = self.held_again("Purged")
        self.archive(device, due=True)
        self.cur.execute("SELECT command FROM cron.job WHERE jobname = 'purge_expired_archives';")
        self.cur.execute(self.cur.fetchone()[0])
        self.assertFalse(self.exists(device))

    def test_a_replay_lane_held_again_goes_with_its_archived_machine(self):
        self.cur.execute(
            "INSERT INTO public.gateways (name, location_scope, deployment, is_simulated, is_shadow)"
            " VALUES (%s, 'cell', 'host', true, true) RETURNING id;", (f"Playback {self.tag}",))
        playback = self.cur.fetchone()[0]
        machine = self.provisioned("Machine", seen=True)
        lane = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.devices (id, name, gateway_id, shadow_of, first_dbirth_at)"
                         " VALUES (%s, %s, %s, %s, now());", (lane, f"Lane {self.tag}", playback, machine))
        self.hold(lane)
        self.as_user(MANAGER)
        self.archive(machine)
        self.assertEqual(self.delete(machine), 1)
        self.assertFalse(self.exists(lane))

    def test_the_owners_own_connection(self):
        device = self.held_again("Owned")
        self.assertEqual(self.delete(device), 1)

    def test_a_registered_device_that_is_not_held(self):
        device = self.provisioned("Plain", seen=True)
        self.as_user(MANAGER)
        self.assertEqual(self.delete(device), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)

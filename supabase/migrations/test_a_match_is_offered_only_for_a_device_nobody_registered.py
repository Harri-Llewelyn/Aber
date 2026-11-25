# suite:
#   lanes: db
#   why: 0328. Accept Match could delete a registered device that was held again, with its schemas and
#     nameplate, because nothing on the row told it from one Aber never admitted, and the merge checked
#     neither device. Holds each refusal and that it changes nothing, what each kind of hold writes, what
#     an upgraded site's rows get from the Audit Trail, and a second boot.

"""
A match is offered only for a device nobody registered (0328).

    python supabase/migrations/test_a_match_is_offered_only_for_a_device_nobody_registered.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

  * A device Aber never admitted arrives held, with requarantined_at null. Holding a registered one again
    writes it, through the ingestion gate or a person's PATCH, and an approval keeps it.
  * approve_quarantined_device() refuses to merge a device that is not in Quarantine or was registered
    before it was held, and a target that is archived, in Quarantine or has been seen. Each refusal is
    raise_exception with a sentence that names the device, and changes nothing.
  * The boot that adds the column fills it from the Audit Trail for the devices held then, and no later
    boot does.

Every test rolls back.
"""
import glob
import json
import os
import re
import unittest
import uuid

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATION = glob.glob(os.path.join(HERE, "0328_*.sql"))[0]

MANAGER = "a0d17070-0000-4000-8000-000000000328"
OPERATOR = "a0d17070-0000-4000-8000-000000000329"
INGESTOR = "b0000000-0000-4000-8000-000000000002"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def migration_text():
    """The file, without the transaction it states for itself, which would commit the test's."""
    with open(MIGRATION, "r", encoding="utf-8") as handle:
        return re.sub(r"(?m)^(BEGIN|COMMIT);\s*$", "", handle.read())


class Base(unittest.TestCase):
    """One transaction per test: fixtures as the owner, each call as its caller, a rollback."""

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT to_regprocedure('public.stamp_requarantined_device()');")
            if cur.fetchone()[0] is None:
                raise unittest.SkipTest(f"{os.path.basename(MIGRATION)} has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # Cleanups, not tearDown: they also run when a fixture fails.
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        self.tag = uuid.uuid4().hex[:8]
        for user_id, role in ((MANAGER, "Shopfloor_Manager"), (OPERATOR, "Operator")):
            self.cur.execute("INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                             (user_id, f"{user_id}@match-0328.test"))
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) SELECT %s, id FROM public.roles WHERE name = %s"
                " ON CONFLICT DO NOTHING;", (user_id, role))

    # -- callers -------------------------------------------------------------------------------

    def as_user(self, user_id):
        self.cur.execute("SET ROLE authenticated;")
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps({"sub": user_id, "role": "authenticated"}),))

    def as_owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")

    # -- fixtures ------------------------------------------------------------------------------

    def provisioned(self, name, seen=False, archived=False, held=False):
        """A device a person added, as the Devices page does: not held, and not yet heard from."""
        device = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, first_dbirth_at, is_archived, archived_at, is_quarantined)"
            " VALUES (%s, %s, CASE WHEN %s THEN now() END, %s, CASE WHEN %s THEN now() END, %s);",
            (device, f"{name} {self.tag}", seen, archived, archived, held))
        return device

    def discovered(self, name):
        """A device nobody registered, as its first birth makes it: the ingestion gate's own row."""
        self.as_user(INGESTOR)
        self.cur.execute(
            "SELECT id FROM public.ingest_register_quarantined_device(%s, NULL, %s, 'UNKNOWN_DEVICE: test',"
            " 'reported_identity');", (f"{name} {self.tag}", f"{name}-{self.tag}"))
        device = str(self.cur.fetchone()[0])
        self.as_owner()
        return device

    def hold(self, device, reason="GATEWAY_MISMATCH: test"):
        self.as_user(INGESTOR)
        self.cur.execute("SELECT public.ingest_requarantine_device(%s, %s, %s);",
                         (device, reason, f"wire-{self.tag}"))
        self.as_owner()

    def held_again(self, name):
        """A registered device that was heard from, and then held by the gate."""
        device = self.provisioned(name, seen=True)
        self.hold(device)
        return device

    # -- reads ---------------------------------------------------------------------------------

    def when(self, device):
        self.cur.execute("SELECT requarantined_at FROM public.devices WHERE id = %s;", (device,))
        return self.cur.fetchone()[0]

    def rows(self, *devices):
        """Each device whole, and the birth values recorded under its id."""
        self.cur.execute(
            "SELECT to_jsonb(d), (SELECT jsonb_agg(a.metric_name ORDER BY a.metric_name)"
            " FROM public.asset_config a WHERE a.asset_id = d.sparkplug_id)"
            " FROM public.devices d WHERE d.id = ANY (%s::uuid[]) ORDER BY d.id;", (list(devices),))
        return self.cur.fetchall()

    def trail(self, device):
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_id = %s;", (device,))
        return self.cur.fetchone()[0]

    def approve(self, device, **into):
        self.cur.execute(
            "SELECT public.approve_quarantined_device(p_device_id => %s, p_actor_id => %s,"
            " p_merge_into_device_id => %s);", (device, into.get("actor", MANAGER), into.get("into")))
        return self.cur.fetchone()[0]


class TheHold(Base):
    def test_a_device_nobody_registered_arrives_held_with_no_time(self):
        device = self.discovered("Discovered")
        self.cur.execute("SELECT is_quarantined, first_dbirth_at IS NOT NULL FROM public.devices WHERE id = %s;", (device,))
        self.assertEqual(self.cur.fetchone(), (True, True))
        self.assertIsNone(self.when(device))

    def test_holding_a_registered_device_writes_the_time(self):
        for seen in (True, False):
            for reason in ("GATEWAY_MISMATCH: test", "IDENTITY_MISMATCH: test", "MALFORMED_IDENTITY: test"):
                with self.subTest(seen=seen, reason=reason):
                    device = self.provisioned("Registered", seen=seen)
                    self.assertIsNone(self.when(device))
                    self.hold(device, reason)
                    self.assertIsNotNone(self.when(device))

    def test_holding_a_device_nobody_registered_a_second_time_writes_nothing(self):
        device = self.discovered("Discovered")
        self.hold(device)
        self.assertIsNone(self.when(device))

    def test_a_person_who_holds_a_device_writes_the_time_too(self):
        device = self.provisioned("Registered")
        self.as_user(MANAGER)
        self.cur.execute("UPDATE public.devices SET is_quarantined = true WHERE id = %s;", (device,))
        self.as_owner()
        self.assertIsNotNone(self.when(device))

    def test_an_approval_keeps_the_time_and_the_next_hold_moves_it(self):
        device = self.held_again("Registered")
        self.cur.execute("UPDATE public.devices SET requarantined_at = now() - interval '9 days' WHERE id = %s;", (device,))
        before = self.when(device)
        self.assertFalse(self.approve(device)["merged"])
        self.assertEqual(self.when(device), before)
        self.hold(device)
        self.assertGreater(self.when(device), before)

    def test_a_device_never_admitted_gains_it_once_it_has_been(self):
        device = self.discovered("Discovered")
        self.approve(device)
        self.assertIsNone(self.when(device))
        self.hold(device)
        self.assertIsNotNone(self.when(device))

    def test_the_hold_is_the_audit_row_it_always_was(self):
        device = self.provisioned("Registered", seen=True)
        before = self.trail(device)
        self.hold(device)
        self.assertEqual(self.trail(device), before + 1)
        self.cur.execute(
            "SELECT action, public.audit_event_class(action, entity_type, audit_domain, old_data, new_data),"
            "       old_data ->> 'requarantined_at', new_data ->> 'requarantined_at' IS NOT NULL"
            "  FROM public.audit_trail WHERE entity_id = %s AND action = 'UPDATE';", (device,))
        self.assertEqual(self.cur.fetchall(), [("UPDATE", "lifecycle", None, True)])


class TheMerge(Base):
    def refused(self, source, into, pattern, code="P0001", actor=MANAGER):
        """The call is refused with `code` and a message matching `pattern`, and changes neither device."""
        self.cur.execute("INSERT INTO public.asset_config (asset_id, metric_name, val_string)"
                         " SELECT sparkplug_id, 'Properties/Serial', 'x' FROM public.devices WHERE id = %s"
                         " ON CONFLICT DO NOTHING;", (source,))
        before = self.rows(source, into)
        self.cur.execute("SAVEPOINT merge;")
        with self.assertRaises(psycopg2.Error) as raised:
            self.approve(source, into=into, actor=actor)
        self.cur.execute("ROLLBACK TO SAVEPOINT merge;")
        self.assertEqual(raised.exception.pgcode, code)
        self.assertRegex(raised.exception.diag.message_primary, pattern)
        self.assertEqual(self.rows(source, into), before)

    def test_a_device_that_is_not_in_quarantine(self):
        self.refused(self.provisioned("Approved", seen=True), self.provisioned("Candidate"),
                     rf'^"Approved {self.tag}" is not in Quarantine, so it was not merged\.')

    def test_a_device_whose_quarantine_flag_is_null_is_not_in_quarantine(self):
        device = self.provisioned("Approved", seen=True)
        self.cur.execute("UPDATE public.devices SET is_quarantined = NULL WHERE id = %s;", (device,))
        self.refused(device, self.provisioned("Candidate"), r"is not in Quarantine, so it was not merged\.")

    def test_a_device_that_was_registered_before_it_was_held(self):
        self.refused(self.held_again("CNC_01"), self.provisioned("CNC_02"),
                     rf'^"CNC_01 {self.tag}" was registered before it was held in Quarantine, so it was not merged\.')

    def test_a_device_registered_by_an_approval_and_then_held(self):
        device = self.discovered("CNC_01")
        self.approve(device)
        self.hold(device)
        self.refused(device, self.provisioned("CNC_02"), r"was registered before it was held")

    def test_a_target_that_is_archived(self):
        self.refused(self.discovered("Discovered"), self.provisioned("Candidate", archived=True),
                     rf'^"Candidate {self.tag}" is archived, so nothing was merged into it\.')

    def test_a_target_that_is_in_quarantine(self):
        for into in (self.discovered("Another"), self.provisioned("Candidate", held=True)):
            with self.subTest(into=into):
                self.refused(self.discovered("Discovered"), into, r"is in Quarantine itself, so nothing was merged into it\.")

    def test_a_target_that_sent_its_first_birth_after_the_list_was_read(self):
        source, into = self.discovered("Discovered"), self.provisioned("Candidate")
        self.as_user(INGESTOR)
        self.cur.execute("SELECT public.ingest_set_device_state(%s, 'ONLINE', 'sparkplug_id', now());", (into,))
        self.as_owner()
        self.refused(source, into, rf'^"Candidate {self.tag}" has already sent its first birth, so nothing was merged into it\.')

    def test_what_was_refused_before_is_refused_as_it_was(self):
        source, into = self.discovered("Discovered"), self.provisioned("Candidate")
        self.refused(source, source, "^cannot merge device .* into itself$", code="22023")
        self.refused(source, into, "is not permitted to approve quarantined devices$", code="42501", actor=OPERATOR)
        self.refused(source, str(uuid.uuid4()), "target device .* not found", code="PGRST")
        self.refused(self.provisioned("Approved"), str(uuid.uuid4()), "target device .* not found", code="PGRST")

    def test_a_device_nobody_registered_merges_into_one_never_seen(self):
        source, into = self.discovered("Discovered"), self.provisioned("Candidate")
        self.cur.execute("INSERT INTO public.asset_config (asset_id, metric_name, val_string)"
                         " SELECT sparkplug_id, 'Properties/Serial', 'x' FROM public.devices WHERE id = %s;", (source,))
        answer = self.approve(source, into=into)
        self.assertTrue(answer["merged"])
        [(device, births)] = self.rows(source, into)
        self.assertEqual(device["id"], into)
        self.assertEqual(device["reported_identity"], f"Discovered-{self.tag}")
        self.assertEqual((device["status"], device["is_quarantined"], device["requarantined_at"]), ("ONLINE", False, None))
        self.assertIsNotNone(device["first_dbirth_at"])
        self.assertEqual(births, ["Properties/Serial"])

    def test_a_device_held_again_is_still_approved_and_keeps_what_is_set_on_it(self):
        device = self.held_again("CNC_01")
        self.cur.execute("INSERT INTO public.device_nameplate (device_id, serial_number) VALUES (%s, 'S-1');", (device,))
        self.assertFalse(self.approve(device)["merged"])
        self.cur.execute("SELECT d.is_quarantined, n.serial_number FROM public.devices d"
                         " JOIN public.device_nameplate n ON n.device_id = d.id WHERE d.id = %s;", (device,))
        self.assertEqual(self.cur.fetchone(), (False, "S-1"))


class TheUpgrade(Base):
    """The boot that adds the column, on a database where devices are held already."""

    def upgrade(self):
        self.cur.execute("ALTER TABLE public.devices DROP COLUMN requarantined_at;")
        del self.conn.notices[:]
        self.cur.execute(migration_text())

    def test_a_held_device_that_was_registered_gets_the_time_of_its_last_hold(self):
        held, never, registered = self.held_again("Held"), self.discovered("Never"), self.provisioned("Live", seen=True)
        # Two earlier holds in the trail, so the one written is the latest.
        for days in (30, 2):
            self.cur.execute(
                "INSERT INTO public.audit_trail (entity_type, entity_id, action, old_data, new_data, actor_source, recorded_at)"
                " VALUES ('devices', %s, 'UPDATE', '{\"is_quarantined\": false}', '{\"is_quarantined\": true}', 'ingestion',"
                "         now() - make_interval(days => %s));", (held, days))
        self.cur.execute("SELECT now();")
        now = self.cur.fetchone()[0]
        self.upgrade()
        self.assertEqual(self.when(held), now)
        self.assertIsNone(self.when(never))
        self.assertIsNone(self.when(registered))
        self.assertTrue([n for n in self.conn.notices if "0328:" in n and "registered before they were held" in n],
                        "the upgrade does not say how many it filled")

    def test_a_device_approved_since_its_hold_gets_none(self):
        device = self.held_again("Approved")
        self.approve(device)
        self.upgrade()
        self.assertIsNone(self.when(device))
        self.hold(device)
        self.assertIsNotNone(self.when(device))

    def test_the_fill_is_recorded_once_as_the_migration(self):
        held, never = self.held_again("Held"), self.discovered("Never")
        before = self.trail(held), self.trail(never)
        self.upgrade()
        self.assertEqual((self.trail(held), self.trail(never)), (before[0] + 1, before[1]))
        self.cur.execute("SELECT actor_source FROM public.audit_trail WHERE entity_id = %s ORDER BY id DESC LIMIT 1;", (held,))
        self.assertEqual(self.cur.fetchone()[0], "migration")

    def test_an_upgrade_with_nothing_held_says_nothing(self):
        self.provisioned("Live", seen=True)
        self.cur.execute("SELECT count(*) FROM public.devices WHERE is_quarantined;")
        if self.cur.fetchone()[0]:
            self.skipTest("this database has devices in Quarantine")
        self.upgrade()
        self.assertEqual([n for n in self.conn.notices if "0328:" in n], [])


class TheDeclarations(Base):
    def test_a_second_boot_changes_nothing(self):
        held, never = self.held_again("Held"), self.discovered("Never")
        before = self.rows(held, never), self.trail(held), self.trail(never)
        del self.conn.notices[:]
        self.cur.execute(migration_text())
        self.assertEqual((self.rows(held, never), self.trail(held), self.trail(never)), before)
        self.assertEqual(list(self.conn.notices), [])

    def test_only_the_service_role_may_call_the_approval(self):
        self.cur.execute(
            "SELECT r, has_function_privilege(r, p.oid, 'EXECUTE') FROM pg_proc p,"
            " unnest(ARRAY['anon', 'authenticated', 'service_role']) r"
            " WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'approve_quarantined_device' ORDER BY r;")
        self.assertEqual(self.cur.fetchall(), [("anon", False), ("authenticated", False), ("service_role", True)])

    def test_the_approval_pins_its_search_path_and_is_one_function(self):
        self.cur.execute(
            "SELECT prosecdef, proconfig FROM pg_proc WHERE pronamespace = 'public'::regnamespace"
            " AND proname = 'approve_quarantined_device';")
        self.assertEqual(self.cur.fetchall(), [(True, ["search_path=public"])])


if __name__ == "__main__":
    unittest.main(verbosity=2)

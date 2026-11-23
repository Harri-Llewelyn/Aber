# suite:
#   lanes: db
#   why: 0317 drops devices.connection_method, and 0001 adds it back on every boot, so the suite
#     replays the boot itself and rebuilds 1.9.0's column for the upgrade. Its faults are a failed
#     boot, a function still naming the column, and a proposal filed before the upgrade applied
#     with the key left out.

"""
A device has no connection_method column (0317).

    python supabase/migrations/test_a_device_has_no_connection_method_column.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

1.9.0 deprecated `devices.connection_method`. 0317 drops it:

  * the column is gone, no function or view names it but in a comment or an old snapshot, the
    device lane does not admit it, and a new proposal that names it is refused when it is filed;
  * a proposal filed before the upgrade that names it is refused when someone approves it, with
    what to do, and is never applied with the key left out; it can still be rejected, and the
    upgrade note's query lists it;
  * a boot replays 0001's column, 0165 and 0202 with it, then 0317 drops it again, every time.

An upgrade is 1.9.0's column rebuilt inside the test's transaction, as
test_a_cell_has_no_grafana_url_column.py rebuilds cells.grafana_url. Every test rolls back.
"""
import glob
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

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATION_0165 = glob.glob(os.path.join(HERE, "0165_*.sql"))[0]
MIGRATION_0202 = glob.glob(os.path.join(HERE, "0202_*.sql"))[0]
MIGRATION_0317 = glob.glob(os.path.join(HERE, "0317_*.sql"))[0]

ADMIN = "00000000-0000-4000-8000-00000003a317"
OPERATOR = "00000000-0000-4000-8000-00000003b317"

HAS_COLUMN = (
    "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.devices'::regclass "
    "                  AND attname = 'connection_method' AND NOT attisdropped);"
)

# What 0001 runs on every boot: the column back, empty, and its default dropped.
BASELINE_COLUMN = (
    "ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS connection_method text; "
    "ALTER TABLE public.devices ALTER COLUMN connection_method DROP DEFAULT;"
)

# The upgrade note's query, word for word: the open proposals that name the key.
PENDING_QUERY = (
    "SELECT id, entity_id, proposed_by_email, proposed_at FROM public.change_proposals "
    "WHERE status = 'open' AND entity_type = 'devices' AND patch ? 'connection_method' "
    "ORDER BY proposed_at;"
)

REFUSAL = "names connection_method , which is not proposable on devices; reject it, and ask for a new proposal without it"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class Base(unittest.TestCase):
    """One transaction per test: fixtures as the owner, the files replayed, a rollback."""

    @classmethod
    def setUpClass(cls):
        cls.sql_0165 = read(MIGRATION_0165)
        cls.sql_0202 = read(MIGRATION_0202)
        cls.sql_0317 = read(MIGRATION_0317)
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(HAS_COLUMN)
            if cur.fetchone()[0]:
                raise unittest.SkipTest(f"{os.path.basename(MIGRATION_0317)} has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        # Cleanups, not tearDown: they also run when a fixture fails.
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        for user_id, role in ((ADMIN, "Administrator"), (OPERATOR, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"devices-0317-{role.lower()}@test.local"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s ON CONFLICT DO NOTHING;",
                (user_id, role),
            )

    def _has_column(self):
        self.cur.execute(HAS_COLUMN)
        return self.cur.fetchone()[0]

    def _device(self):
        # A random id: sparkplug_id is generated from its first 21 hex characters under a UNIQUE.
        did = str(uuid.uuid4())
        name = f"Test_0317_Device_{did[:8]}"
        self.cur.execute("INSERT INTO public.devices (id, name) VALUES (%s, %s);", (did, name))
        return did, name

    def _as(self, user_id):
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute(
            "SELECT set_config('request.jwt.claims', %s, true);",
            (json.dumps({"sub": user_id, "role": "authenticated", "aal": "aal2",
                         "email": f"{user_id}@test.local"}),),
        )

    def _acting(self, user_id, sql, params):
        """One statement as this person, in a savepoint: a refusal rolls back to the owner."""
        self.cur.execute("SAVEPOINT acting;")
        try:
            self._as(user_id)
            self.cur.execute(sql, params)
            row = self.cur.fetchone()
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT acting;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT acting;")
        return row[0]

    def _propose(self, device_id, patch):
        return str(self._acting(
            OPERATOR,
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch) "
            "VALUES ('devices', %s, %s::jsonb) RETURNING id;",
            (device_id, json.dumps(patch)),
        ))

    def _approve(self, proposal):
        return self._acting(ADMIN, "SELECT public.approve_proposal(%s) ->> 'status';", (proposal,))

    def _status(self, proposal):
        self.cur.execute("SELECT status FROM public.change_proposals WHERE id = %s;", (proposal,))
        return self.cur.fetchone()[0]

    def _boot(self, *sqls):
        """Replay the files in order, as db-init does on every boot; returns the NOTICEs."""
        del self.conn.notices[:]
        for sql in sqls:
            self.cur.execute(sql)
        return [n.strip() for n in self.conn.notices]

    def _full_boot(self):
        """The parts of a boot that touch the column: 0001's, then 0165, 0202 and 0317."""
        return self._boot(BASELINE_COLUMN, self.sql_0165, self.sql_0202, self.sql_0317)


class TheColumnIsGone(Base):

    def test_devices_has_no_connection_method(self):
        self.assertFalse(self._has_column())

    def test_no_function_names_it_but_in_a_comment_or_an_old_snapshot(self):
        # Past audit rows carry it, so audit_event_class() reads it out of a snapshot as a JSON key.
        # approve_quarantined_device() (0293) names it in a comment, which nothing runs.
        self.cur.execute(
            "SELECT p.oid::regprocedure::text FROM pg_proc p "
            "  JOIN pg_namespace n ON n.oid = p.pronamespace "
            " WHERE n.nspname = 'public'"
            "   AND replace(regexp_replace(p.prosrc, '--[^\\n]*', '', 'g'), '-> ''connection_method''', '')"
            "       ~ '\\mconnection_method\\M' ORDER BY 1;"
        )
        self.assertEqual(self.cur.fetchall(), [])

    def test_no_view_names_it(self):
        self.cur.execute(
            "SELECT schemaname || '.' || viewname FROM pg_views "
            " WHERE schemaname = 'public' AND definition ~ '\\mconnection_method\\M' ORDER BY 1;"
        )
        self.assertEqual(self.cur.fetchall(), [])

    def test_the_device_lane_does_not_admit_it(self):
        self.cur.execute("SELECT public.proposable_columns('devices');")
        lane = self.cur.fetchone()[0]
        self.assertNotIn("connection_method", lane)
        # A superset, not the set: a later file may widen the lane.
        self.assertLessEqual({"name", "description", "cell_id", "area_id", "location_scope",
                              "model_3d_path"}, set(lane))

    def test_a_new_proposal_that_names_it_is_refused_when_it_is_filed(self):
        device, _ = self._device()
        with self.assertRaises(psycopg2.errors.InvalidParameterValue) as caught:
            self._propose(device, {"connection_method": "Sparkplug B"})
        message = str(caught.exception)
        self.assertIn("column connection_method is not proposable on devices", message)
        self.assertNotIn("connection_method", message.split("proposable columns are:")[1])

    def test_an_ordinary_device_proposal_still_applies(self):
        device, name = self._device()
        proposal = self._propose(device, {"name": f"{name}_Renamed", "description": "By the door"})
        self.assertEqual(self._approve(proposal), "applied")
        self.cur.execute("SELECT name, description FROM public.devices WHERE id = %s;", (device,))
        self.assertEqual(self.cur.fetchone(), (f"{name}_Renamed", "By the door"))

    def test_a_replay_of_0317_alone_finds_nothing_to_do(self):
        notices = self._boot(self.sql_0317)
        self.assertEqual([n for n in notices if "0317:" in n], [])
        self.assertFalse(self._has_column())


class AProposalFiledBeforeTheUpgrade(Base):
    """
    Filed on 1.9.0, while the device lane admitted the key, and still open at the upgrade. 0202 is
    replayed for 1.9.0's allowlist, the proposal is filed, then 0317 runs as the upgrade's boot does.
    """

    def setUp(self):
        super().setUp()
        self._boot(BASELINE_COLUMN, self.sql_0165, self.sql_0202)
        self.device, self.name = self._device()
        self.proposal = self._propose(self.device, {"name": f"{self.name}_Renamed",
                                                    "connection_method": "Modbus TCP"})
        self.other_device, _ = self._device()
        self.plain = self._propose(self.other_device, {"description": "No key here"})
        self._boot(self.sql_0317)

    def test_approving_it_is_refused_and_says_what_to_do(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue) as caught:
            self._approve(self.proposal)
        self.assertIn(f"proposal {self.proposal} {REFUSAL}", str(caught.exception))

    def test_the_rest_of_the_patch_is_not_applied_without_it(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self._approve(self.proposal)
        self.assertEqual(self._status(self.proposal), "open")
        self.cur.execute("SELECT name FROM public.devices WHERE id = %s;", (self.device,))
        self.assertEqual(self.cur.fetchone()[0], self.name)
        self.cur.execute(
            "SELECT count(*) FROM public.audit_trail "
            " WHERE action = 'PROPOSAL_APPLIED' AND new_data ->> 'proposal_id' = %s;",
            (self.proposal,),
        )
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_it_can_still_be_rejected(self):
        status = self._acting(
            ADMIN, "SELECT public.reject_proposal(%s, %s) ->> 'status';",
            (self.proposal, "Devices have no connection method since 1.10.0. Propose the name alone."),
        )
        self.assertEqual(status, "rejected")

    def test_a_proposal_without_it_still_applies(self):
        self.assertEqual(self._approve(self.plain), "applied")

    def test_the_upgrade_notes_query_lists_it_and_nothing_else(self):
        self.cur.execute(PENDING_QUERY)
        listed = [str(row[0]) for row in self.cur.fetchall()]
        self.assertIn(self.proposal, listed)
        self.assertNotIn(self.plain, listed)


class EveryBoot(Base):
    """0001 adds the column back, empty, on every boot; 0317 drops it again."""

    def test_an_upgrades_first_boot_drops_the_values_and_counts_them(self):
        self._boot(BASELINE_COLUMN)
        held = [self._device()[0] for _ in range(2)]
        blank = [self._device()[0] for _ in range(2)]
        for device, value in zip(held + blank, ("Sparkplug B", "Modbus TCP", "", "  ")):
            self.cur.execute("UPDATE public.devices SET connection_method = %s WHERE id = %s;",
                             (value, device))
        notices = self._boot(self.sql_0165, self.sql_0202, self.sql_0317)
        self.assertFalse(self._has_column())
        counted = [n for n in notices if "0317: devices.connection_method dropped" in n]
        self.assertEqual(len(counted), 1, notices)
        self.assertIn("with the value 2 device(s) held", counted[0])

    def test_each_later_boot_adds_it_back_empty_and_drops_it_without_a_word(self):
        for boot in (1, 2):
            with self.subTest(boot=boot):
                notices = self._full_boot()
                self.assertEqual([n for n in notices if "0317:" in n], [])
                self.assertFalse(self._has_column())
                self.cur.execute(
                    "SELECT prosrc ~ '\\mconnection_method\\M' FROM pg_proc "
                    " WHERE oid = 'public.approve_proposal(uuid)'::regprocedure;"
                )
                self.assertFalse(self.cur.fetchone()[0])
                self.cur.execute("SELECT public.proposable_columns('devices');")
                self.assertNotIn("connection_method", self.cur.fetchone()[0])

    def test_a_device_proposal_applies_after_a_boot(self):
        self._full_boot()
        device, name = self._device()
        proposal = self._propose(device, {"name": f"{name}_Booted"})
        self.assertEqual(self._approve(proposal), "applied")
        self.cur.execute("SELECT name FROM public.devices WHERE id = %s;", (device,))
        self.assertEqual(self.cur.fetchone()[0], f"{name}_Booted")


if __name__ == "__main__":
    unittest.main(verbosity=2)

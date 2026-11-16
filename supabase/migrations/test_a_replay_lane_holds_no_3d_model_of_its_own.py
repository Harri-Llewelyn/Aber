# suite:
#   lanes: db
#   why: 0294's CHECK refuses a 3D model on a replay lane, by an owner write, an Administrator
#     through the API role, the service role and an approved proposal. The file's move gives a
#     machine its lane's model where it had none, clears the lane's where it had one, takes the older
#     of two lanes, leaves an orphan alone, and is idempotent. The asset-3d-models INSERT and UPDATE
#     policies, verbatim from storage-policies.sql on a stand-in table, refuse an object under a
#     lane's id (upper case too) and admit one under a machine's, and the file's self-check refuses
#     an arm without the refusal. A write the dashboard does not offer is what these hold.

"""
A replay lane holds no 3D model of its own (0294).

    python supabase/migrations/test_a_replay_lane_holds_no_3d_model_of_its_own.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * devices_a_replay_lane_has_no_model is declared and validated, and refuses a model on a lane: set
    by an UPDATE or on an INSERT, by an Administrator through the API's role, by the service role
    and by an approved proposal, which aborts the approval and leaves the lane without. A machine
    takes a model, and a lane's other columns are still written.
  * The file moves what a lane held. Where the machine had none it takes the lane's path and the
    lane's is cleared; where it had one the lane's is cleared and the machine's stays; of two lanes
    of one machine the older one's moves and the other's is cleared; a device whose machine is gone
    (shadow_of NULL) is no lane and keeps its path; each move is named in a NOTICE and written to
    the Audit Trail by the migration. A second run changes nothing and keeps the constraint's oid.
  * is_replay_lane_model_path() answers for the first folder of an object name, in either case, and
    never raises for a name that is not shaped like one. anon may not execute it.
  * The asset-3d-models policies, verbatim from storage-policies.sql on a stand-in table: an
    Administrator and a Shopfloor Manager write an object under a machine's id, or one outside any
    device's folder, and not one under a lane's id (an upload, an upsert of a lane's object, or a
    rename into a lane's folder). DELETE is not confined, so a machine removes a model that is stored
    under its lane's id. The file's self-check refuses an INSERT or an UPDATE arm without the refusal.

EVERY TEST ROLLS BACK. The file itself runs inside the transaction, with the CHECK dropped first where
a test needs the database as 1.8.0 left it.
"""
import json
import os
import unittest
import uuid
from pathlib import Path

import psycopg2
import psycopg2.errors as pg_errors
from psycopg2 import sql

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = Path(__file__).resolve().parents[2]
MIGRATION = Path(__file__).with_name("0294_a_replay_lane_holds_no_3d_model_of_its_own.sql")
STORAGE_POLICIES = REPO / "supabase" / "storage-policies.sql"

CONSTRAINT = "devices_a_replay_lane_has_no_model"
WANT = "CHECK (((shadow_of IS NULL) OR (model_3d_path IS NULL)))"
PROBE = "asset_3d_models_lane_probe"

DROP_CHECK = "ALTER TABLE public.devices DROP CONSTRAINT devices_a_replay_lane_has_no_model;"

PEOPLE = {
    "Administrator": "a0d17294-0000-4000-8000-0000000294a1",
    "Shopfloor_Manager": "a0d17294-0000-4000-8000-0000000294a2",
    "Auditor": "a0d17294-0000-4000-8000-0000000294a3",
    "Operator": "a0d17294-0000-4000-8000-0000000294a4",
}


def probe(statement):
    """`statement` with {t} standing for the stand-in table and {s} for its schema, composed, not formatted."""
    return sql.SQL(statement).format(t=sql.Identifier(PROBE, "objects"), s=sql.Identifier(PROBE))


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class LaneBase(unittest.TestCase):
    """A machine, its lane and the gateways under them, as the owner; each call as a caller."""

    def setUp(self):
        self.conn = get_connection()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT count(*) FROM pg_constraint WHERE conname = %s;", (CONSTRAINT,))
        if self.cur.fetchone()[0] != 1:
            self.skipTest("0294 is not applied to this database")
        self.cur.execute("SELECT name, id FROM public.roles;")
        roles = dict(self.cur.fetchall())
        for role, user_id in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id[-4:]}@lane-model.test"))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        self.real_gateway = self.gateway(shadow=False)
        self.shadow_gateway = self.gateway(shadow=True)
        self.machine = self.device(self.real_gateway, "Machine")
        self.lane = self.device(self.shadow_gateway, "Machine (replay)", shadow_of=self.machine)

    # ---- fixtures, as the owner --------------------------------------------------------------------
    def gateway(self, shadow):
        # The sparkplug id comes from the first characters of the id, so each id must differ early.
        gateway_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment, is_simulated, is_shadow)"
            " VALUES (%s, %s, 'cell', %s, %s, %s);",
            (gateway_id, f"Test_0294_GW_{gateway_id[:8]}", "host" if shadow else "remote", shadow, shadow))
        return gateway_id

    def device(self, gateway_id, name, shadow_of=None, model=None, age_days=0):
        device_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, shadow_of, model_3d_path, created_at)"
            " VALUES (%s, %s, %s, %s, %s, now() - make_interval(days => %s));",
            (device_id, f"Test_0294_{name}_{device_id[:6]}", gateway_id, shadow_of, model, age_days))
        return device_id

    def path_of(self, device_id):
        self.cur.execute("SELECT model_3d_path FROM public.devices WHERE id = %s;", (device_id,))
        return self.cur.fetchone()[0]

    def model_path(self, device_id, name="model.glb"):
        return f"{device_id}/{name}"

    # ---- callers -------------------------------------------------------------------------------------
    def as_caller(self, role, user=None):
        """The rest of the transaction runs as `role`, with `user`'s claims where one is given."""
        self.cur.execute("SELECT set_config('role', %s, true);", (role,))
        if user:
            claims = {"sub": user, "role": role, "aal": "aal1", "email": f"{user[-4:]}@lane-model.test"}
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))

    def back_to_owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")

    def refused(self, error_class, statement, args=(), role=None, user=None):
        """Run `statement` as `role` and return the `error_class` it raised; the fixture stands."""
        self.cur.execute("SAVEPOINT refused;")
        try:
            if role:
                self.as_caller(role, user)
            with self.assertRaises(error_class) as caught:
                self.cur.execute(statement, args)
            return caught.exception
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
            self.back_to_owner()
            self.cur.execute("RELEASE SAVEPOINT refused;")


class TestTheCheck(LaneBase):
    def test_it_is_declared_as_a_lane_or_no_model_and_validated(self):
        self.cur.execute("SELECT public.live_constraint_definition(conrelid, conname), convalidated"
                         " FROM pg_constraint WHERE conname = %s AND conrelid = 'public.devices'::regclass;",
                         (CONSTRAINT,))
        self.assertEqual(self.cur.fetchall(), [(WANT, True)])

    def test_a_lane_is_refused_a_model_on_an_update(self):
        error = self.refused(pg_errors.CheckViolation,
                             "UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                             (self.model_path(self.lane), self.lane))
        self.assertEqual(error.diag.constraint_name, CONSTRAINT)
        self.assertIsNone(self.path_of(self.lane))

    def test_a_lane_is_refused_a_model_when_it_is_made(self):
        other = self.device(self.real_gateway, "Other machine")
        other_lane_gateway = self.gateway(shadow=True)
        error = self.refused(pg_errors.CheckViolation,
                             "INSERT INTO public.devices (name, gateway_id, shadow_of, model_3d_path)"
                             " VALUES ('Test_0294_made_with_one', %s, %s, %s);",
                             (other_lane_gateway, other, self.model_path(other)))
        self.assertEqual(error.diag.constraint_name, CONSTRAINT)

    def test_a_machine_takes_a_model_and_a_lane_is_still_written(self):
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                         (self.model_path(self.machine), self.machine))
        self.assertEqual(self.path_of(self.machine), self.model_path(self.machine))
        for statement in ("UPDATE public.devices SET description = 'Kept' WHERE id = %s;",
                          "UPDATE public.devices SET name = 'Kept' WHERE id = %s;"):
            self.cur.execute(statement, (self.lane,))
            self.assertEqual(self.cur.rowcount, 1)
        # A model path under a lane's id is the machine's to hold: the shape check admits it.
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                         (self.model_path(self.lane, "was-the-lanes.glb"), self.machine))
        self.assertEqual(self.cur.rowcount, 1)

    def test_a_lane_with_no_model_clears_nothing_and_a_clear_is_allowed(self):
        self.cur.execute("UPDATE public.devices SET model_3d_path = NULL WHERE id = %s;", (self.lane,))
        self.assertEqual(self.cur.rowcount, 1)

    def test_an_administrator_through_the_api_role_is_refused(self):
        error = self.refused(pg_errors.CheckViolation,
                             "UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                             (self.model_path(self.lane), self.lane),
                             role="authenticated", user=PEOPLE["Administrator"])
        self.assertEqual(error.diag.constraint_name, CONSTRAINT)

    def test_an_administrator_through_the_api_role_may_still_give_the_machine_one(self):
        self.as_caller("authenticated", PEOPLE["Administrator"])
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                         (self.model_path(self.machine), self.machine))
        self.assertEqual(self.cur.rowcount, 1)

    def test_the_service_role_is_refused(self):
        error = self.refused(pg_errors.CheckViolation,
                             "UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                             (self.model_path(self.lane), self.lane), role="service_role")
        self.assertEqual(error.diag.constraint_name, CONSTRAINT)

    def test_an_approved_proposal_that_gives_a_lane_a_model_aborts_the_approval(self):
        # model_3d_path is a proposable column, and approving is applying: the CHECK runs inside the
        # approver's transaction, the proposal stays open and the lane keeps no model.
        self.as_caller("authenticated", PEOPLE["Operator"])
        self.cur.execute("INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale)"
                         " VALUES ('devices', %s, %s::jsonb, 'the lane should show a model') RETURNING id;",
                         (self.lane, json.dumps({"model_3d_path": self.model_path(self.lane)})))
        proposal = self.cur.fetchone()[0]
        self.back_to_owner()
        error = self.refused(pg_errors.CheckViolation, "SELECT public.approve_proposal(%s);", (proposal,),
                             role="authenticated", user=PEOPLE["Administrator"])
        self.assertEqual(error.diag.constraint_name, CONSTRAINT)
        self.cur.execute("SELECT status FROM public.change_proposals WHERE id = %s;", (proposal,))
        self.assertEqual(self.cur.fetchone()[0], "open")
        self.assertIsNone(self.path_of(self.lane))

    def test_a_device_whose_machine_is_gone_is_no_lane_and_may_hold_a_model(self):
        # devices_shadow_of_fkey is ON DELETE SET NULL, so shadow_of can be NULL on the playback gateway.
        self.cur.execute("UPDATE public.devices SET shadow_of = NULL WHERE id = %s;", (self.lane,))
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                         (self.model_path(self.lane), self.lane))
        self.assertEqual(self.cur.rowcount, 1)


class TestTheFile(LaneBase):
    """The migration's file, run inside the transaction against the database as 1.8.0 left it."""

    def drop_the_check(self):
        self.cur.execute(DROP_CHECK)

    def run_file(self):
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))

    def oid(self):
        self.cur.execute("SELECT oid FROM pg_constraint WHERE conname = %s AND conrelid = 'public.devices'::regclass;",
                         (CONSTRAINT,))
        row = self.cur.fetchone()
        return row[0] if row else None

    def lane_holding(self, machine, model_name, age_days=0):
        """A lane of `machine` on a gateway of its own, holding a model: only a database as 1.8.0 left
        it has one."""
        lane = self.device(self.gateway(shadow=True), "Lane", shadow_of=machine, age_days=age_days)
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                         (self.model_path(lane, model_name), lane))
        return lane

    def test_a_machine_with_no_model_takes_its_lanes_and_the_object_stays_where_it_is(self):
        self.drop_the_check()
        held = self.model_path(self.lane, "upload.glb")
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;", (held, self.lane))
        self.run_file()
        self.assertEqual(self.path_of(self.machine), held)
        self.assertIsNone(self.path_of(self.lane))
        self.assertTrue(held.startswith(self.lane + "/"), "the path still names the lane's folder: the object is not copied")

    def test_a_machine_with_a_model_keeps_it_and_the_lanes_is_cleared(self):
        self.drop_the_check()
        own = self.model_path(self.machine, "own.stl")
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;", (own, self.machine))
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                         (self.model_path(self.lane, "upload.glb"), self.lane))
        self.run_file()
        self.assertEqual(self.path_of(self.machine), own)
        self.assertIsNone(self.path_of(self.lane))

    def test_of_two_lanes_the_older_ones_model_moves_and_the_other_is_cleared(self):
        self.drop_the_check()
        older = self.lane_holding(self.machine, "older.glb", age_days=3)
        newer = self.lane_holding(self.machine, "newer.glb", age_days=1)
        self.run_file()
        self.assertEqual(self.path_of(self.machine), self.model_path(older, "older.glb"))
        self.assertIsNone(self.path_of(older))
        self.assertIsNone(self.path_of(newer))

    def test_a_lane_with_no_model_and_a_machine_with_none_change_nothing(self):
        self.drop_the_check()
        self.run_file()
        self.assertIsNone(self.path_of(self.machine))
        self.assertIsNone(self.path_of(self.lane))

    def test_a_device_whose_machine_is_gone_keeps_its_path(self):
        self.drop_the_check()
        # A lane whose machine was deleted before lanes followed their machines: shadow_of is NULL.
        orphan = self.device(self.gateway(shadow=True), "Orphan", shadow_of=self.machine)
        kept = self.model_path(orphan, "orphan.glb")
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s, shadow_of = NULL WHERE id = %s;", (kept, orphan))
        self.run_file()
        self.assertEqual(self.path_of(orphan), kept)

    def test_a_machine_that_is_a_lane_takes_nothing_and_the_lane_is_cleared(self):
        # No lane stands in for a lane, so none should exist. If one did, the file must still finish.
        self.drop_the_check()
        third = self.device(self.gateway(shadow=True), "Lane of a lane", shadow_of=self.lane)
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                         (self.model_path(third, "x.glb"), third))
        self.run_file()
        self.assertIsNone(self.path_of(third))
        self.assertIsNone(self.path_of(self.lane))

    def test_each_move_is_named_and_the_migration_is_the_one_that_wrote_it(self):
        self.drop_the_check()
        other = self.device(self.real_gateway, "Machine with one", model=None)
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                         (self.model_path(other, "own.glb"), other))
        cleared = self.lane_holding(other, "extra.glb")
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                         (self.model_path(self.lane, "upload.glb"), self.lane))
        del self.conn.notices[:]
        self.run_file()
        notices = [n for n in self.conn.notices if "0294:" in n]
        moved = [n for n in notices if self.lane in n and "now holds it" in n]
        self.assertEqual(len(moved), 1, notices)
        self.assertIn(self.machine, moved[0])
        self.assertIn(self.model_path(self.lane, "upload.glb"), moved[0])
        dropped = [n for n in notices if cleared in n and "no longer holds it" in n]
        self.assertEqual(len(dropped), 1, notices)
        self.assertIn(self.model_path(cleared, "extra.glb"), dropped[0])
        self.assertIn(other, dropped[0])
        self.assertTrue(any("moved to their machines" in n and "cleared" in n for n in notices), notices)
        self.cur.execute("SELECT DISTINCT actor_source FROM public.audit_trail"
                         " WHERE entity_id = ANY(%s::uuid[]) AND action = 'UPDATE'"
                         " AND (new_data ->> 'model_3d_path') IS DISTINCT FROM (old_data ->> 'model_3d_path');",
                         ([self.machine, self.lane, cleared],))
        self.assertEqual(self.cur.fetchall(), [("migration",)])

    def test_a_replay_changes_nothing_and_keeps_the_constraint(self):
        before = self.oid()
        del self.conn.notices[:]
        self.run_file()
        self.assertEqual(self.oid(), before)
        self.assertFalse([n for n in self.conn.notices if "held the 3D model" in n])

    def test_a_second_run_after_a_move_changes_nothing(self):
        self.drop_the_check()
        held = self.model_path(self.lane, "upload.glb")
        self.cur.execute("UPDATE public.devices SET model_3d_path = %s WHERE id = %s;", (held, self.lane))
        self.run_file()
        oid = self.oid()
        del self.conn.notices[:]
        self.run_file()
        self.assertEqual(self.path_of(self.machine), held)
        self.assertIsNone(self.path_of(self.lane))
        self.assertEqual(self.oid(), oid)
        self.assertFalse([n for n in self.conn.notices if "held the 3D model" in n])

    def test_the_check_is_added_validated_and_refuses_after_the_file(self):
        self.drop_the_check()
        self.run_file()
        self.cur.execute("SELECT public.live_constraint_definition(conrelid, conname), convalidated"
                         " FROM pg_constraint WHERE conname = %s AND conrelid = 'public.devices'::regclass;",
                         (CONSTRAINT,))
        self.assertEqual(self.cur.fetchall(), [(WANT, True)])
        error = self.refused(pg_errors.CheckViolation, "UPDATE public.devices SET model_3d_path = %s WHERE id = %s;",
                             (self.model_path(self.lane), self.lane))
        self.assertEqual(error.diag.constraint_name, CONSTRAINT)

    def test_a_not_valid_check_is_validated(self):
        self.drop_the_check()
        self.cur.execute("ALTER TABLE public.devices ADD CONSTRAINT devices_a_replay_lane_has_no_model"
                         " CHECK (((shadow_of IS NULL) OR (model_3d_path IS NULL))) NOT VALID;")
        self.run_file()
        self.cur.execute("SELECT convalidated FROM pg_constraint WHERE conname = %s;", (CONSTRAINT,))
        self.assertEqual(self.cur.fetchone(), (True,))

    def test_a_different_definition_under_the_name_is_put_back(self):
        self.drop_the_check()
        self.cur.execute("ALTER TABLE public.devices ADD CONSTRAINT devices_a_replay_lane_has_no_model CHECK (true);")
        self.run_file()
        self.cur.execute("SELECT public.live_constraint_definition(conrelid, conname) FROM pg_constraint"
                         " WHERE conname = %s;", (CONSTRAINT,))
        self.assertEqual(self.cur.fetchone()[0], WANT)


class TestTheFunction(LaneBase):
    def answers(self, name, role=None):
        if role:
            self.as_caller(role)
        try:
            self.cur.execute("SELECT public.is_replay_lane_model_path(%s);", (name,))
            return self.cur.fetchone()[0]
        finally:
            self.back_to_owner()

    def test_the_folder_of_a_lane_is_true_and_a_machines_is_false(self):
        self.assertTrue(self.answers(f"{self.lane}/model.glb"))
        self.assertFalse(self.answers(f"{self.machine}/model.glb"))

    def test_the_case_of_the_folder_does_not_matter(self):
        self.assertTrue(self.answers(f"{self.lane.upper()}/model.glb"))
        self.assertFalse(self.answers(f"{self.machine.upper()}/model.glb"))

    def test_only_the_first_folder_names_the_device(self):
        self.assertFalse(self.answers(f"{self.machine}/{self.lane}/model.glb"))
        self.assertTrue(self.answers(f"{self.lane}/{self.machine}/model.glb"))

    def test_a_name_that_names_no_device_is_false_and_never_raises(self):
        for name in (None, "", "x.bin", "__probe__/x.bin", "not-a-uuid/model.glb", str(uuid.uuid4()),
                     f"{uuid.uuid4()}/model.glb", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz/model.glb",
                     f"{self.lane}"):
            with self.subTest(name=name):
                self.assertFalse(self.answers(name))

    def test_each_writer_reads_the_lane_through_it_as_itself(self):
        # The function reads devices as the caller, so a policy on devices that hid lanes from a
        # writer would answer false here and let an object under a lane through.
        for role in ("Administrator", "Shopfloor_Manager"):
            with self.subTest(role=role):
                self.as_caller("authenticated", PEOPLE[role])
                try:
                    self.cur.execute("SELECT public.is_replay_lane_model_path(%s), public.is_replay_lane_model_path(%s);",
                                     (f"{self.lane}/model.glb", f"{self.machine}/model.glb"))
                    self.assertEqual(self.cur.fetchone(), (True, False))
                finally:
                    self.back_to_owner()

    def test_authenticated_may_ask_and_anon_may_not(self):
        self.assertTrue(self.answers(f"{self.lane}/model.glb", role="authenticated"))
        self.cur.execute("SAVEPOINT anon_asks;")
        self.as_caller("anon")
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.is_replay_lane_model_path(%s);", (f"{self.lane}/model.glb",))
        self.cur.execute("ROLLBACK TO SAVEPOINT anon_asks;")
        self.back_to_owner()


class TheBucketPolicies(LaneBase):
    """The asset-3d-models policies and their self-check from storage-policies.sql, on a stand-in."""

    def section(self, edit=lambda text: text):
        text = edit(STORAGE_POLICIES.read_text(encoding="utf-8"))
        policies = text[text.index("-- asset-3d-models."):text.index("-- On the PG17 image")]
        check = text[text.index("-- Self-check, by name and not by count"):text.index("-- broker-captures: private.")]
        block = (policies + check).replace("storage.objects", PROBE + ".objects")
        block = block.replace("schemaname = 'storage'", f"schemaname = '{PROBE}'")
        self.assertNotIn("storage.", block)
        self.assertNotIn("'storage'", block)
        return block

    def setUp(self):
        super().setUp()
        self.cur.execute(probe("CREATE SCHEMA {s};"))
        self.cur.execute(probe("CREATE TABLE {t} (bucket_id text NOT NULL, name text NOT NULL);"))
        self.cur.execute(probe("ALTER TABLE {t} ENABLE ROW LEVEL SECURITY;"))
        self.cur.execute(probe("GRANT USAGE ON SCHEMA {s} TO authenticated;"))
        self.cur.execute(probe("GRANT SELECT, INSERT, UPDATE, DELETE ON {t} TO authenticated;"))
        self.cur.execute(self.section())

    def put(self, name):
        """An object as the owner, which no policy governs."""
        self.cur.execute(probe("INSERT INTO {t} (bucket_id, name) VALUES ('asset-3d-models', %s);"), (name,))

    def writes(self, caller, name):
        self.cur.execute("SAVEPOINT writes;")
        try:
            self.as_caller("authenticated", PEOPLE[caller])
            self.cur.execute(probe("INSERT INTO {t} (bucket_id, name) VALUES ('asset-3d-models', %s);"), (name,))
            return True
        except pg_errors.InsufficientPrivilege:
            return False
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT writes;")
            self.back_to_owner()
            self.cur.execute("RELEASE SAVEPOINT writes;")

    def updates(self, caller, name, set_name):
        """Rows changed, or False when the new name is refused outright."""
        self.cur.execute("SAVEPOINT updates;")
        try:
            self.as_caller("authenticated", PEOPLE[caller])
            self.cur.execute(probe("UPDATE {t} SET name = %s WHERE bucket_id = 'asset-3d-models' AND name = %s;"),
                             (set_name, name))
            return self.cur.rowcount
        except pg_errors.InsufficientPrivilege:
            return False
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT updates;")
            self.back_to_owner()
            self.cur.execute("RELEASE SAVEPOINT updates;")

    def deletes(self, caller, name):
        self.cur.execute("SAVEPOINT deletes;")
        try:
            self.as_caller("authenticated", PEOPLE[caller])
            self.cur.execute(probe("DELETE FROM {t} WHERE bucket_id = 'asset-3d-models' AND name = %s;"), (name,))
            return self.cur.rowcount
        finally:
            self.cur.execute("ROLLBACK TO SAVEPOINT deletes;")
            self.back_to_owner()
            self.cur.execute("RELEASE SAVEPOINT deletes;")

    def test_a_writer_stores_a_model_under_a_machine_and_not_under_a_lane(self):
        for caller in ("Administrator", "Shopfloor_Manager"):
            with self.subTest(caller=caller):
                self.assertTrue(self.writes(caller, f"{self.machine}/model.glb"))
                self.assertFalse(self.writes(caller, f"{self.lane}/model.glb"))

    def test_the_case_of_the_lanes_folder_does_not_get_round_it(self):
        self.assertFalse(self.writes("Administrator", f"{self.lane.upper()}/model.glb"))

    def test_an_object_outside_any_devices_folder_is_still_written(self):
        # check-gateway-surface.mjs probes the bucket with a name in no folder.
        for name in ("__gateway_probe__.bin", "__probe__/x.bin", f"{uuid.uuid4()}/model.glb"):
            with self.subTest(name=name):
                self.assertTrue(self.writes("Administrator", name))

    def test_nobody_but_a_writer_writes_at_all(self):
        for caller in ("Auditor", "Operator"):
            with self.subTest(caller=caller):
                self.assertFalse(self.writes(caller, f"{self.machine}/model.glb"))

    def test_an_object_under_a_lane_cannot_be_updated_or_renamed_into_one(self):
        self.put(f"{self.lane}/model.glb")
        self.put(f"{self.machine}/model.glb")
        # Targeted: the row is not one the UPDATE may see, so nothing changes.
        self.assertEqual(self.updates("Administrator", f"{self.lane}/model.glb", f"{self.lane}/other.glb"), 0)
        # Produced: a machine's object renamed into a lane's folder is refused.
        self.assertFalse(self.updates("Administrator", f"{self.machine}/model.glb", f"{self.lane}/model.glb"))
        # A machine's object, renamed within its own folder, still moves.
        self.assertEqual(self.updates("Administrator", f"{self.machine}/model.glb", f"{self.machine}/renamed.glb"), 1)

    def test_a_model_stored_under_a_lane_is_removed_by_a_writer(self):
        self.put(f"{self.lane}/model.glb")
        for caller in ("Administrator", "Shopfloor_Manager"):
            with self.subTest(caller=caller):
                self.assertEqual(self.deletes(caller, f"{self.lane}/model.glb"), 1)
        for caller in ("Auditor", "Operator"):
            with self.subTest(caller=caller):
                self.assertEqual(self.deletes(caller, f"{self.lane}/model.glb"), 0)

    def test_the_files_own_self_check_passes_on_what_it_states(self):
        """An arm the self-check misreads would fail the storage-policies Job on every boot."""
        self.cur.execute(self.section())

    def test_the_self_check_refuses_an_insert_arm_without_the_refusal(self):
        def widen(text):
            arm = "    AND NOT public.is_replay_lane_model_path(storage.objects.name)\n  );\n\nDROP POLICY IF EXISTS \"asset_3d_models_update_privileged\""
            self.assertIn(arm, text, "the insert arm moved; update this test")
            return text.replace(arm, "  );\n\nDROP POLICY IF EXISTS \"asset_3d_models_update_privileged\"")
        with self.assertRaisesRegex(pg_errors.RaiseException, "under a replay lane"):
            self.cur.execute(self.section(widen))

    def test_the_self_check_refuses_an_update_arm_that_only_checks_the_new_row(self):
        def widen(text):
            arm = ("  USING (\n    bucket_id = 'asset-3d-models'\n"
                   "    AND (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) AND (SELECT public.require_mfa()))\n"
                   "    AND NOT public.is_replay_lane_model_path(storage.objects.name)\n  )\n  WITH CHECK")
            self.assertIn(arm, text, "the update arm moved; update this test")
            return text.replace(arm, "  USING (\n    bucket_id = 'asset-3d-models'\n"
                                     "    AND (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) AND (SELECT public.require_mfa()))\n"
                                     "  )\n  WITH CHECK")
        with self.assertRaisesRegex(pg_errors.RaiseException, "under a replay lane"):
            self.cur.execute(self.section(widen))


if __name__ == "__main__":
    unittest.main(verbosity=2)

# suite:
#   lanes: db
#   why: 0336 -- a schema version names the derived metrics its devices get: what may be named, in words
#     and in every writer's path; that it is frozen with a published version, carried by Create Version
#     and recorded as a change of the schema; that a derived metric a version names cannot be deleted;
#     and that the versions there are were filled once, by what they model, with no Audit Trail row and
#     a NOTICE for each device the fill cannot carry.

"""
A schema names the derived metrics its devices get (0336).

    python supabase/migrations/test_a_schema_names_the_derived_metrics_its_devices_get.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

  * What may be named: a derived metric of the catalogue, whose inputs the same schema models, whose
    states its copy of the input permits. A deprecated one only where the version or its parent names
    it. Each refusal names the metric, and every reason is said at once.
  * The version: the list is in name order, each name once; a published version's is frozen for the
    roles the API runs as; Create Version and an insert without a list take the parent's; publishing
    and discarding leave the other versions' as they are.
  * A copy of a published version is never refused, whatever it names.
  * The Audit Trail: a change of the list is one UPDATE of the schema, in the schema's own lane.
  * The catalogue: a derived metric a version names is not deleted and not renamed, also while another
    transaction is naming it.
  * Who: the list is as readable, and as writable, as the version.
  * The fill: every bound version and every draft, with the derived metrics whose inputs it models;
    nothing else; no Audit Trail row; a NOTICE for a device with no schema and for one whose inputs are
    split; once, and never again.

EVERY TEST ROLLS BACK, except the one that holds two transactions open, which plants rows of its own
and removes them.
"""
import json
import os
import re
import unittest

import psycopg2
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATION = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "0336_a_schema_names_the_derived_metrics_its_devices_get.sql")

ADMIN_ID = "b1e60336-0000-4000-8000-0000000336a1"
OPERATOR_ID = "b1e60336-0000-4000-8000-0000000336a2"
SWITCH = "security.require_mfa_for_managers"

COUNT = "Test_0336/PART_COUNT"
MODE = "Test_0336/MODE"
PHASE_A = "Test_0336/PHASE_A"
PHASE_B = "Test_0336/PHASE_B"
RATE = "Test_0336_D/PARTS_PER_HOUR"
RUNNING = "Test_0336_D/RUNNING"
NET = "Test_0336_D/NET"


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def definition(*names, enum=None):
    """A schema's definition of these metrics; `enum` is MODE's permitted values."""
    properties = {n: {"type": "string"} if n == MODE else {"type": "number"} for n in names}
    if enum is not None:
        properties[MODE]["enum"] = enum
    return {"type": "object", "properties": properties}


class Base(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT 1 FROM pg_attribute WHERE attrelid = 'public.schemas'::regclass"
                         " AND attname = 'derived_metrics' AND NOT attisdropped;")
        if self.cur.fetchone() is None:
            self.skipTest("0336 is not applied to this database")
        self.plant()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def plant(self):
        for user_id, role in ((ADMIN_ID, "Administrator"), (OPERATOR_ID, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@derived-metrics.test"))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id)"
                             " SELECT %s, id FROM public.roles WHERE name = %s"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, role))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))
        for name, datatype, permitted in ((COUNT, 10, None), (PHASE_A, 10, None), (PHASE_B, 10, None),
                                          (MODE, 12, ["AUTO", "MANUAL", "SETUP"])):
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, permitted_values) VALUES (%s, %s, %s);",
                             (name, datatype, permitted))
        for name, derivation in (
            (RATE, {"kind": "counter_rate", "input": COUNT}),
            (RUNNING, {"kind": "time_in_state", "input": MODE, "states": ["AUTO"]}),
            (NET, {"kind": "sum", "inputs": [{"metric": PHASE_A, "sign": 1}, {"metric": PHASE_B, "sign": -1}]}),
        ):
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, 10, %s);",
                             (name, Json(derivation)))

    # -- calls, as PostgREST makes them ---------------------------------------------------------

    def as_person(self, sql, args=(), user_id=ADMIN_ID):
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(
            {"sub": user_id, "role": "authenticated", "aal": "aal1"}),))
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute(sql, args)
        answer = self.cur.fetchall() if self.cur.description else self.cur.rowcount
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        return answer

    def refused(self, call, *args, **kwargs):
        """What a call is refused with, contained so the transaction survives."""
        self.cur.execute("SAVEPOINT refused;")
        try:
            call(*args, **kwargs)
        except psycopg2.Error as exc:
            self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
            return exc
        return self.fail("nothing was refused")

    # -- what is planted and what is read -------------------------------------------------------

    def schema(self, name, metrics=None, derived=None, status="active", version=1, parent=None, definition_=None):
        """A schema as the owner. `derived` None leaves the column out of the INSERT."""
        columns = ["schema_name", "schema_definition", "status", "version", "parent_schema_id"]
        values = [name, Json(definition_ if definition_ is not None else definition(*(metrics or (COUNT,)))),
                  status, version, parent]
        if derived is not None:
            columns.append("derived_metrics")
            values.append(derived)
        self.cur.execute(f"INSERT INTO public.schemas ({', '.join(columns)})"
                         f" VALUES ({', '.join(['%s'] * len(values))}) RETURNING id::text;", values)
        return self.cur.fetchone()[0]

    def names(self, schema_id):
        self.cur.execute("SELECT derived_metrics FROM public.schemas WHERE id = %s;", (schema_id,))
        return self.cur.fetchone()[0]

    def set_names(self, schema_id, names):
        self.cur.execute("UPDATE public.schemas SET derived_metrics = %s WHERE id = %s;", (names, schema_id))

    def fork(self, schema_id):
        return self.as_person("SELECT public.fork_schema(%s::uuid, 'why');", (schema_id,))[0][0]

    def publish(self, schema_id):
        self.as_person("SELECT public.publish_schema_version(%s::uuid);", (schema_id,))

    def device(self, name, birth=(), schemas=(), quarantined=False, shadow_of=None):
        self.cur.execute("INSERT INTO public.devices (name, status, last_birth_metrics, is_quarantined)"
                         " VALUES (%s, 'OFFLINE', %s, %s) RETURNING id::text;", (name, list(birth), quarantined))
        device = self.cur.fetchone()[0]
        for schema_id in schemas:
            self.cur.execute("INSERT INTO public.device_submodels (device_id, schema_id) VALUES (%s, %s);",
                             (device, schema_id))
        return device


class WhatMayBeNamed(Base):
    def test_a_derived_metric_whose_inputs_the_schema_models_is_named(self):
        schema = self.schema("Test_0336_Press", (COUNT, MODE, PHASE_A, PHASE_B), [RATE, RUNNING, NET])
        self.assertEqual(self.names(schema), sorted([RATE, RUNNING, NET]))

    def test_the_list_is_kept_in_name_order_and_each_name_once(self):
        schema = self.schema("Test_0336_Press", (COUNT, MODE, PHASE_A, PHASE_B), [RUNNING, NET, RATE, NET, None])
        self.assertEqual(self.names(schema), sorted([RATE, RUNNING, NET]))
        self.set_names(schema, [RATE, NET])
        self.assertEqual(self.names(schema), sorted([RATE, NET]))
        self.set_names(schema, None)
        self.assertEqual(self.names(schema), [])

    def test_a_schema_made_without_a_list_names_none(self):
        self.assertEqual(self.names(self.schema("Test_0336_Press")), [])

    def test_a_name_the_catalogue_lacks_is_refused_by_name(self):
        exc = self.refused(self.schema, "Test_0336_Press", (COUNT,), ["Test_0336_D/NOWHERE"])
        self.assertEqual(exc.pgcode, "23514")
        self.assertIn("Test_0336_D/NOWHERE is not in the metric catalogue.", str(exc))

    def test_a_measured_metric_is_refused_by_name(self):
        exc = self.refused(self.schema, "Test_0336_Press", (COUNT,), [COUNT])
        self.assertIn(f"{COUNT} is a measured metric", str(exc))

    def test_an_input_the_schema_does_not_model_is_refused_with_both_names(self):
        exc = self.refused(self.schema, "Test_0336_Press", (PHASE_A,), [NET])
        self.assertIn(f"{NET} is computed from {PHASE_B}, which this schema does not model.", str(exc))
        self.assertNotIn(f"computed from {PHASE_A}", str(exc))

    def test_a_metric_in_required_alone_is_modelled(self):
        schema = self.schema("Test_0336_Press", derived=[RATE],
                             definition_={"type": "object", "properties": {}, "required": [COUNT]})
        self.assertEqual(self.names(schema), [RATE])

    def test_every_reason_is_said_at_once(self):
        exc = self.refused(self.schema, "Test_0336_Press", (PHASE_A,), [NET, RATE, "Test_0336_D/NOWHERE"])
        for part in (f"{NET} is computed from {PHASE_B}", f"{RATE} is computed from {COUNT}",
                     "Test_0336_D/NOWHERE is not in the metric catalogue"):
            self.assertIn(part, str(exc))

    def test_a_state_the_schemas_copy_of_the_input_leaves_out_is_refused(self):
        exc = self.refused(self.schema, "Test_0336_Press", derived=[RUNNING],
                           definition_=definition(MODE, enum=["MANUAL", "SETUP"]))
        self.assertIn(f'{RUNNING} counts the state "AUTO", which this schema does not permit {MODE} to report'
                      " (MANUAL, SETUP).", str(exc))

    def test_a_state_the_copy_permits_or_does_not_restrict_is_named(self):
        for enum in (["AUTO", "MANUAL"], None):
            with self.subTest(enum=enum):
                self.cur.execute("SAVEPOINT s;")
                schema = self.schema("Test_0336_Press", derived=[RUNNING], definition_=definition(MODE, enum=enum))
                self.assertEqual(self.names(schema), [RUNNING])
                self.cur.execute("ROLLBACK TO SAVEPOINT s;")

    def test_a_booleans_states_are_compared_with_a_boolean_enum(self):
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES ('Test_0336/DOOR', 11);")
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES ('Test_0336_D/OPEN', 10, %s);",
                         (Json({"kind": "time_in_state", "input": "Test_0336/DOOR", "states": ["true"]}),))
        shape = {"type": "object", "properties": {"Test_0336/DOOR": {"type": "boolean", "enum": [True, False]}}}
        self.assertEqual(self.names(self.schema("Test_0336_Door", derived=["Test_0336_D/OPEN"], definition_=shape)),
                         ["Test_0336_D/OPEN"])
        shape["properties"]["Test_0336/DOOR"]["enum"] = [False]
        exc = self.refused(self.schema, "Test_0336_Door_2", derived=["Test_0336_D/OPEN"], definition_=shape)
        self.assertIn('counts the state "true"', str(exc))

    def test_a_draft_that_drops_an_input_is_refused_until_the_derived_metric_goes_too(self):
        root = self.schema("Test_0336_Press", (COUNT, PHASE_A, PHASE_B), [RATE, NET])
        draft = self.fork(root)["id"]
        drop = ("UPDATE public.schemas SET schema_definition = %s WHERE id = %s;",
                (Json(definition(COUNT, PHASE_A)), draft))
        exc = self.refused(self.as_person, *drop)
        self.assertIn(f"{NET} is computed from {PHASE_B}, which this schema does not model.", str(exc))
        # In one write, and in two, the list first.
        self.as_person("UPDATE public.schemas SET schema_definition = %s, derived_metrics = %s WHERE id = %s;",
                       (Json(definition(COUNT, PHASE_A)), [RATE], draft))
        self.assertEqual(self.names(draft), [RATE])

    def test_an_edit_of_neither_column_is_not_checked(self):
        root = self.schema("Test_0336_Press", derived=[RUNNING], definition_=definition(MODE, enum=["AUTO"]))
        draft = self.fork(root)["id"]
        # The catalogue's row cannot go, so what makes the draft unsound is the owner's own hand.
        self.cur.execute("ALTER TABLE public.schemas DISABLE TRIGGER trg_schemas_derived_metrics;")
        self.cur.execute("UPDATE public.schemas SET schema_definition = %s WHERE id = %s;",
                         (Json(definition(MODE, enum=["SETUP"])), draft))
        self.cur.execute("ALTER TABLE public.schemas ENABLE TRIGGER trg_schemas_derived_metrics;")
        self.as_person("UPDATE public.schemas SET description = 'edited' WHERE id = %s;", (draft,))
        self.publish(draft)


class ADeprecatedDerivedMetric(Base):
    def deprecate(self, name):
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE name = %s;", (name,))

    def test_it_is_not_added(self):
        self.deprecate(RATE)
        exc = self.refused(self.schema, "Test_0336_Press", (COUNT,), [RATE])
        self.assertIn(f"{RATE} is deprecated. A schema may keep it but not add it.", str(exc))

    def test_it_stays_where_the_version_or_its_parent_names_it(self):
        root = self.schema("Test_0336_Press", (COUNT, PHASE_A, PHASE_B), [RATE])
        self.deprecate(RATE)
        draft = self.fork(root)["id"]
        self.assertEqual(self.names(draft), [RATE])
        self.as_person("UPDATE public.schemas SET derived_metrics = %s WHERE id = %s;", ([RATE, NET], draft))
        # Taken off a draft and put back, because the version it was made from still names it.
        self.as_person("UPDATE public.schemas SET derived_metrics = %s WHERE id = %s;", ([NET], draft))
        self.as_person("UPDATE public.schemas SET derived_metrics = %s WHERE id = %s;", ([NET, RATE], draft))
        self.assertEqual(self.names(draft), sorted([NET, RATE]))


class TheVersionCarriesIt(Base):
    def test_create_version_carries_the_list_and_answers_it(self):
        root = self.schema("Test_0336_Press", (COUNT, PHASE_A, PHASE_B), [RATE, NET])
        draft = self.fork(root)
        self.assertEqual(draft["derived_metrics"], sorted([RATE, NET]))
        self.assertEqual(self.names(draft["id"]), sorted([RATE, NET]))

    def test_a_version_inserted_with_a_list_of_its_own_keeps_it(self):
        root = self.schema("Test_0336_Press", (COUNT, PHASE_A, PHASE_B), [RATE, NET])
        self.assertEqual(self.names(self.schema("Test_0336_Press_v2", (COUNT,), [], "draft", 2, root)), [])

    def test_publishing_and_discarding_leave_every_list_as_it_was(self):
        root = self.schema("Test_0336_Press", (COUNT, PHASE_A, PHASE_B), [RATE])
        device = self.device("Test 0336 Press", schemas=[root])
        draft = self.fork(root)["id"]
        self.as_person("UPDATE public.schemas SET derived_metrics = %s WHERE id = %s;", ([NET, RATE], draft))
        self.publish(draft)
        self.assertEqual(self.names(root), [RATE])
        self.assertEqual(self.names(draft), sorted([NET, RATE]))
        self.cur.execute("SELECT schema_id::text FROM public.device_submodels WHERE device_id = %s;", (device,))
        self.assertEqual(self.cur.fetchone()[0], draft)
        third = self.fork(draft)["id"]
        self.as_person("SELECT public.discard_schema_draft(%s::uuid);", (third,))
        self.assertEqual(self.names(draft), sorted([NET, RATE]))

    def test_a_published_versions_list_is_frozen_for_the_roles_the_api_runs_as(self):
        root = self.schema("Test_0336_Press", (COUNT, PHASE_A, PHASE_B), [RATE])
        for status in ("active", "archived"):
            if status == "archived":
                self.cur.execute("UPDATE public.schemas SET status = 'archived' WHERE id = %s;", (root,))
            with self.subTest(status=status):
                exc = self.refused(self.as_person, "UPDATE public.schemas SET derived_metrics = %s WHERE id = %s;", ([NET], root))
                self.assertIn("immutable", str(exc))
                self.assertEqual(self.names(root), [RATE])

    def test_a_copy_of_a_published_version_is_never_refused(self):
        root = self.schema("Test_0336_Press", derived=[RUNNING], definition_=definition(MODE, enum=["AUTO"]))
        self.cur.execute("ALTER TABLE public.schemas DISABLE TRIGGER trg_schemas_derived_metrics;")
        self.cur.execute("UPDATE public.schemas SET schema_definition = %s WHERE id = %s;",
                         (Json(definition(MODE, enum=["SETUP"])), root))
        self.cur.execute("ALTER TABLE public.schemas ENABLE TRIGGER trg_schemas_derived_metrics;")
        draft = self.fork(root)["id"]
        self.assertEqual(self.names(draft), [RUNNING])
        # The draft is where it is put right, and an edit of it is checked.
        exc = self.refused(self.as_person, "UPDATE public.schemas SET schema_definition = %s WHERE id = %s;",
                           (Json(definition(MODE, COUNT, enum=["SETUP"])), draft))
        self.assertIn(f'{RUNNING} counts the state "AUTO"', str(exc))


class TheRecordAndTheReaders(Base):
    def test_a_change_of_the_list_is_one_update_of_the_schema_in_its_own_lane(self):
        root = self.schema("Test_0336_Press", (COUNT, PHASE_A, PHASE_B), [RATE])
        draft = self.fork(root)["id"]
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.audit_trail;")
        (before,) = self.cur.fetchone()
        self.as_person("UPDATE public.schemas SET derived_metrics = %s WHERE id = %s;", ([NET, RATE], draft))
        self.cur.execute("SELECT entity_type, action, audit_domain, changed_by::text, old_data -> 'derived_metrics',"
                         " new_data -> 'derived_metrics' FROM public.audit_trail WHERE id > %s;", (before,))
        self.assertEqual(self.cur.fetchall(),
                         [("schemas", "UPDATE", "asset", ADMIN_ID, [RATE], sorted([NET, RATE]))])

    def test_every_signed_in_role_reads_it_and_only_the_versions_writers_write_it(self):
        root = self.schema("Test_0336_Press", (COUNT, PHASE_A, PHASE_B), [RATE])
        draft = self.fork(root)["id"]
        self.assertEqual(self.as_person("SELECT derived_metrics FROM public.schemas WHERE id = %s;", (draft,),
                                        user_id=OPERATOR_ID), [([RATE],)])
        self.assertEqual(self.as_person("UPDATE public.schemas SET derived_metrics = %s WHERE id = %s;", ([NET], draft),
                                        user_id=OPERATOR_ID), 0)
        self.assertEqual(self.names(draft), [RATE])
        self.cur.execute("SELECT has_table_privilege('anon', 'public.schemas', 'SELECT');")
        self.assertFalse(self.cur.fetchone()[0])

    def test_no_function_of_this_file_is_a_browsers(self):
        self.cur.execute("""
            SELECT p.oid::regprocedure::text FROM pg_proc p
             WHERE p.oid IN ('public.derivation_input_names(jsonb)'::regprocedure,
                             'public.schema_modelled_metrics(jsonb)'::regprocedure,
                             'public.schema_derived_metric_problems(jsonb, text[], text[])'::regprocedure,
                             'public.schemas_check_their_derived_metrics()'::regprocedure,
                             'public.refuse_losing_a_named_derived_metric()'::regprocedure)
               AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));""")
        self.assertEqual(self.cur.fetchall(), [])


class WhatAVersionNamesStaysInTheCatalogue(Base):
    def test_it_is_not_deleted_and_a_free_one_is(self):
        self.schema("Test_0336_Press", (COUNT,), [RATE])
        self.schema("Test_0336_Other", (COUNT,), [RATE])
        exc = self.refused(self.cur.execute, "DELETE FROM public.metric_catalog WHERE name = %s;", (RATE,))
        self.assertEqual(exc.pgcode, "23503")
        self.assertIn(f"{RATE} cannot be deleted: the schema version Test_0336_Other v1 names it, and 1 more.", str(exc))
        self.cur.execute("DELETE FROM public.metric_catalog WHERE name = %s;", (NET,))
        self.assertEqual(self.cur.rowcount, 1)

    def test_an_archived_version_and_a_draft_hold_it_too(self):
        for status in ("archived", "draft"):
            with self.subTest(status=status):
                self.cur.execute("SAVEPOINT s;")
                self.schema("Test_0336_Press", (COUNT,), [RATE], status)
                self.assertEqual(self.refused(self.cur.execute, "DELETE FROM public.metric_catalog WHERE name = %s;",
                                              (RATE,)).pgcode, "23503")
                self.cur.execute("ROLLBACK TO SAVEPOINT s;")

    def test_a_rename_is_refused_also_if_the_catalogue_allowed_one(self):
        self.schema("Test_0336_Press", (COUNT,), [RATE])
        for own_guard in (True, False):
            if not own_guard:
                self.cur.execute("ALTER TABLE public.metric_catalog DISABLE TRIGGER trg_metric_catalog_immutability;")
            with self.subTest(catalogues_own_guard=own_guard):
                exc = self.refused(self.cur.execute,
                                   "UPDATE public.metric_catalog SET name = 'Test_0336_D/RENAMED' WHERE name = %s;", (RATE,))
                self.assertEqual(exc.pgcode, "23503")
                self.assertIn(f"{RATE} cannot be renamed", str(exc))

    def test_a_delete_waits_for_the_transaction_that_is_naming_it(self):
        """The catalogue's row is locked as a foreign key locks it, so a delete cannot slip in between."""
        self.conn.rollback()
        other = get_connection()
        try:
            with self.conn.cursor() as cur:
                cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, 10) ON CONFLICT DO NOTHING;", (COUNT,))
                cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, 10, %s) ON CONFLICT DO NOTHING;",
                            (RATE, Json({"kind": "counter_rate", "input": COUNT})))
            self.conn.commit()
            with self.conn.cursor() as cur:
                cur.execute("INSERT INTO public.schemas (schema_name, schema_definition, derived_metrics)"
                            " VALUES ('Test_0336_Locked', %s, %s);", (Json(definition(COUNT)), [RATE]))
                with other.cursor() as second:
                    second.execute("SET LOCAL lock_timeout = '300ms';")
                    with self.assertRaises(psycopg2.errors.LockNotAvailable):
                        second.execute("DELETE FROM public.metric_catalog WHERE name = %s;", (RATE,))
                other.rollback()
            self.conn.commit()
            with other.cursor() as second:
                with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
                    second.execute("DELETE FROM public.metric_catalog WHERE name = %s;", (RATE,))
            other.rollback()
        finally:
            other.rollback()
            other.close()
            self.conn.rollback()
            with self.conn.cursor() as cur:
                cur.execute("DELETE FROM public.schemas WHERE schema_name = 'Test_0336_Locked';")
                cur.execute("DELETE FROM public.metric_catalog WHERE name = %s;", (RATE,))
                cur.execute("DELETE FROM public.metric_catalog WHERE name = %s;", (COUNT,))
            self.conn.commit()


class TheFill(Base):
    """The file's own fill, run on rows as they were before it, in a transaction that is taken back."""

    def before_the_file(self):
        self.cur.execute("ALTER TABLE public.schemas ALTER COLUMN derived_metrics DROP NOT NULL;")
        self.cur.execute("ALTER TABLE public.schemas DISABLE TRIGGER trg_schemas_derived_metrics;")
        self.cur.execute("ALTER TABLE public.schemas DISABLE TRIGGER trg_schemas_audit_trail;")
        self.cur.execute("UPDATE public.schemas SET derived_metrics = NULL;")
        self.cur.execute("ALTER TABLE public.schemas ENABLE TRIGGER trg_schemas_derived_metrics;")
        self.cur.execute("ALTER TABLE public.schemas ENABLE TRIGGER trg_schemas_audit_trail;")

    def fill(self):
        with open(MIGRATION, "r", encoding="utf-8") as handle:
            block = re.search(r"DO \$fill\$.*?END \$fill\$;", handle.read(), re.S).group(0)
        del self.conn.notices[:]
        self.cur.execute(block)
        # A site's own rows may be among what the fill says, so a test looks for its own devices.
        return [n.replace("NOTICE:", "").strip() for n in self.conn.notices]

    def trail(self):
        self.cur.execute("SELECT count(*) FROM public.audit_trail;")
        return self.cur.fetchone()[0]

    def test_a_bound_version_and_a_draft_take_what_they_model_the_inputs_of(self):
        bound = self.schema("Test_0336_Bound", (COUNT, PHASE_A, PHASE_B))
        self.device("Test 0336 Bound", schemas=[bound])
        draft = self.schema("Test_0336_Draft", (PHASE_A, MODE), status="draft")
        replaced = self.schema("Test_0336_Old", (COUNT,), status="archived")
        self.device("Test 0336 Left Behind")
        self.cur.execute("ALTER TABLE public.device_submodels DISABLE TRIGGER USER;")
        self.device("Test 0336 Behind", schemas=[replaced])
        self.cur.execute("ALTER TABLE public.device_submodels ENABLE TRIGGER USER;")
        free = self.schema("Test_0336_Free", (COUNT, PHASE_A, PHASE_B))
        archived = self.schema("Test_0336_Archived", (COUNT,), status="archived")
        self.before_the_file()
        before = self.trail()
        self.fill()
        self.assertEqual(self.names(bound), sorted([RATE, NET]))
        self.assertEqual(self.names(draft), [RUNNING])
        self.assertEqual(self.names(replaced), [RATE], "an archived version a device is still bound to is one it is bound to")
        self.assertEqual((self.names(free), self.names(archived)), ([], []))
        self.assertEqual(self.trail(), before, "the fill is not an Audit Trail event")
        self.cur.execute("SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.schemas'::regclass AND NOT tgisinternal"
                         " AND tgenabled = 'D';")
        self.assertEqual(self.cur.fetchone()[0], 0, "the fill left a trigger disabled")

    def test_a_deprecated_derived_metric_is_filled_since_its_values_are_still_shown(self):
        bound = self.schema("Test_0336_Bound", (COUNT,))
        self.device("Test 0336 Bound", schemas=[bound])
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE name = %s;", (RATE,))
        self.before_the_file()
        self.fill()
        self.assertEqual(self.names(bound), [RATE])
        self.assertEqual(self.names(self.fork(bound)["id"]), [RATE])

    def test_create_version_works_on_every_filled_version(self):
        """A state the version's own copy leaves out is filled too, and the fork is a copy."""
        bound = self.schema("Test_0336_Bound", definition_=definition(MODE, enum=["SETUP"]))
        self.device("Test 0336 Bound", schemas=[bound])
        self.before_the_file()
        self.fill()
        self.assertEqual(self.names(bound), [RUNNING])
        self.assertEqual(self.names(self.fork(bound)["id"]), [RUNNING])

    def test_it_says_which_devices_it_cannot_carry_and_names_their_metrics(self):
        half = self.schema("Test_0336_Half_A", (PHASE_A,))
        other = self.schema("Test_0336_Half_B", (PHASE_B, COUNT))
        self.device("Test 0336 None", birth=[COUNT, PHASE_A, PHASE_B])
        self.device("Test 0336 Split", schemas=[half, other])
        self.device("Test 0336 Beyond", birth=[MODE], schemas=[half])
        self.device("Test 0336 Kept", schemas=[other])
        self.device("Test 0336 Quarantined", birth=[COUNT], quarantined=True)
        self.before_the_file()
        notices = self.fill()
        (no_schema,) = [n for n in notices if "have no schema" in n]
        (split,) = [n for n in notices if "none of their schemas models every input" in n]
        self.assertIn(f"Test 0336 None ({NET}, {RATE})", no_schema)
        self.assertIn(f"Test 0336 Split ({NET})", split)
        self.assertIn(f"Test 0336 Beyond ({RUNNING})", split)
        for absent in ("Test 0336 Kept", "Test 0336 Quarantined"):
            self.assertNotIn(absent, no_schema + split)
        # A NOTICE is for a person: a device with a schema is not among the ones that have none.
        self.assertNotIn("Test 0336 Split", no_schema)

    def test_a_site_with_nothing_lost_is_told_of_nothing_lost(self):
        self.before_the_file()
        self.cur.execute("DELETE FROM public.metric_catalog WHERE derivation IS NOT NULL;")
        notices = self.fill()
        self.assertEqual([n for n in notices if "device(s)" in n], [])

    def test_it_runs_once(self):
        bound = self.schema("Test_0336_Bound", (COUNT,), [])
        self.device("Test 0336 Bound", schemas=[bound])
        notices = self.fill()
        self.assertEqual(notices, [])
        self.assertEqual(self.names(bound), [], "a later boot must not name what a person took off")

    def test_a_draft_made_between_the_trigger_and_the_fill_is_filled_too(self):
        """The previous release's dashboard forks while the column is there and not yet filled."""
        root = self.schema("Test_0336_Bound", (COUNT,))
        self.device("Test 0336 Bound", schemas=[root])
        self.before_the_file()
        draft = self.fork(root)["id"]
        self.assertIsNone(self.names(draft))
        self.fill()
        self.assertEqual(self.names(draft), [RATE])


if __name__ == "__main__":
    unittest.main()

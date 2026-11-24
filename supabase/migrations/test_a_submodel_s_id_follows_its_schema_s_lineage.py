# suite:
#   lanes: db
#   why: 0298 -- that every schema version names its lineage (the first version's id and name),
#     however it came to exist: fork_schema(), a draft inserted with a parent as
#     apply_device_schemas() does, or a first version inserted directly; that no caller can supply
#     or forge them; that a renamed first version renames its lineage; that the file fills a
#     database that already holds lineages (every row, none in the Audit Trail, a row inserted in the
#     window before the NOT NULL included) and replays to nothing; and that a device_submodels key
#     starts with a letter, with the old keys that did not rewritten first. A wrong lineage here
#     changes a Submodel id on every publish, or gives two versions of one schema two source types.

"""
A schema's AAS Submodel id follows its lineage (0298).

    python supabase/migrations/test_a_submodel_s_id_follows_its_schema_s_lineage.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

Runs as `authenticated` where the guard matters (fork_schema(), an edit of a frozen row) and as the
owner where the migration's own writes are the subject. Every test rolls back.
"""
import json
import os
import unittest
import uuid

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATION = os.path.join(HERE, "0298_a_submodel_s_id_follows_its_schema_s_lineage.sql")

ADMIN_USER_ID = "a0000000-0000-4000-8000-000000000298"
ROLE_ADMINISTRATOR = 1

DEFINITION = {"type": "object", "properties": {"Systems/TEMPERATURE": {"type": "number"}}}


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT 1 FROM pg_attribute WHERE attrelid = 'public.schemas'::regclass "
                         "AND attname = 'lineage_root_id' AND NOT attisdropped;")
        if self.cur.fetchone() is None:
            self.skipTest("0298 is not applied to this database")
        self.tag = uuid.uuid4().hex[:8]
        self.make_admin()

    def make_admin(self):
        # An emailed row, so it is a person and may hold a role (0080); audit_trail.changed_by
        # is a foreign key to auth.users, so a publish or fork writes nothing without it.
        self.cur.execute(
            "INSERT INTO auth.users (instance_id, id, aud, role, email) "
            "VALUES ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s) "
            "ON CONFLICT (id) DO NOTHING;",
            (ADMIN_USER_ID, f"{ADMIN_USER_ID}@lineage.test"),
        )
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s) "
            "ON CONFLICT (user_id, role_id) DO NOTHING;",
            (ADMIN_USER_ID, ROLE_ADMINISTRATOR),
        )

    def as_admin(self):
        claims = json.dumps({"sub": ADMIN_USER_ID, "app_metadata": {"role": "Administrator"}})
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (claims,))
        self.cur.execute("SET LOCAL ROLE authenticated;")

    def as_owner(self):
        self.cur.execute("RESET ROLE;")

    def name(self, stem):
        return f"{stem}_{self.tag}"

    def seed(self, name, status="active", version=1, parent=None):
        """A schema as the owner."""
        self.cur.execute(
            "INSERT INTO public.schemas (schema_name, schema_definition, status, version, parent_schema_id) "
            "VALUES (%s, %s::jsonb, %s, %s, %s) RETURNING id::text;",
            (name, json.dumps(DEFINITION), status, version, parent),
        )
        return self.cur.fetchone()[0]

    def lineage(self, schema_id):
        self.cur.execute(
            "SELECT lineage_root_id::text, lineage_name FROM public.schemas WHERE id = %s;",
            (schema_id,),
        )
        return self.cur.fetchone()

    def fork(self, parent_id):
        self.cur.execute("SELECT public.fork_schema(%s, 'a change');", (parent_id,))
        return self.cur.fetchone()[0]

    def publish(self, draft_id):
        self.cur.execute("SELECT public.publish_schema_version(%s);", (draft_id,))
        return self.cur.fetchone()[0]

    def refused(self, sql, params=None):
        """The error a statement raises, contained so the transaction survives."""
        self.cur.execute("SAVEPOINT refused;")
        try:
            self.cur.execute(sql, params)
        except psycopg2.Error as exc:
            self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
            return exc
        self.cur.execute("RELEASE SAVEPOINT refused;")
        return None

    def run_file(self):
        with open(MIGRATION, "r", encoding="utf-8") as handle:
            sql = handle.read()
        del self.conn.notices[:]
        self.cur.execute(sql)
        return list(self.conn.notices)


class EveryVersionNamesItsLineage(Base):
    def test_a_first_version_is_its_own_lineage(self):
        root = self.seed(self.name("Arm"))
        self.assertEqual(self.lineage(root), (root, self.name("Arm")))

    def test_fork_schema_carries_the_lineage_down_every_version(self):
        root = self.seed(self.name("Arm"))
        self.as_admin()
        v2 = self.fork(root)
        self.publish(v2["id"])
        v3 = self.fork(v2["id"])
        self.as_owner()
        # The versions are named for themselves, and one lineage carries them all.
        self.assertEqual(v2["schema_name"], self.name("Arm") + "_v2")
        self.assertEqual(self.lineage(v2["id"]), (root, self.name("Arm")))
        self.assertEqual(self.lineage(v3["id"]), (root, self.name("Arm")))
        self.assertEqual(v3["lineage_root_id"], root)
        self.assertEqual(v3["lineage_name"], self.name("Arm"))

    def test_a_name_fork_schema_had_to_suffix_still_names_the_first_versions_lineage(self):
        # _v2 is taken by another schema, so the fork is _v2_2; its own lineage name is not that.
        root = self.seed(self.name("Arm"))
        self.seed(self.name("Arm") + "_v2", status="archived")
        self.as_admin()
        v2 = self.fork(root)
        self.assertEqual(v2["schema_name"], self.name("Arm") + "_v2_2")
        self.publish(v2["id"])
        v3 = self.fork(v2["id"])
        self.as_owner()
        self.assertEqual(v3["schema_name"], self.name("Arm") + "_v3")
        self.assertEqual(self.lineage(v3["id"]), (root, self.name("Arm")))

    def test_a_draft_inserted_with_a_parent_names_its_lineage_as_apply_device_schemas_makes_one(self):
        root = self.seed(self.name("Arm"))
        draft = self.seed(self.name("Arm") + "_v2", status="draft", version=2, parent=root)
        self.assertEqual(self.lineage(draft), (root, self.name("Arm")))

    def test_two_lineages_with_the_same_look_are_two_lineages(self):
        a = self.seed(self.name("Robot-Arm"))
        b = self.seed(self.name("Robot_Arm"))
        self.assertNotEqual(self.lineage(a)[0], self.lineage(b)[0])

    def test_no_caller_supplies_a_lineage(self):
        root = self.seed(self.name("Arm"))
        other = self.seed(self.name("Other"))
        self.cur.execute(
            "INSERT INTO public.schemas (schema_name, schema_definition, lineage_root_id, lineage_name) "
            "VALUES (%s, %s::jsonb, %s, 'Forged') RETURNING id::text;",
            (self.name("Direct"), json.dumps(DEFINITION), other),
        )
        direct = self.cur.fetchone()[0]
        self.assertEqual(self.lineage(direct), (direct, self.name("Direct")))

        self.as_admin()
        v2 = self.fork(root)
        # A draft is editable. Naming another lineage on it changes nothing: the trigger derives it
        # again from the parent.
        self.cur.execute(
            "UPDATE public.schemas SET lineage_root_id = %s, lineage_name = 'Forged' WHERE id = %s;",
            (other, v2["id"]),
        )
        self.assertEqual(self.cur.rowcount, 1)
        self.as_owner()
        self.assertEqual(self.lineage(v2["id"]), (root, self.name("Arm")))

    def test_a_published_version_refuses_a_new_lineage_from_an_app_role(self):
        root = self.seed(self.name("Arm"))
        other = self.seed(self.name("Other"))
        self.as_admin()
        error = self.refused(
            "UPDATE public.schemas SET lineage_root_id = %s WHERE id = %s;", (other, root)
        )
        self.assertIsInstance(error, psycopg2.errors.CheckViolation)
        self.assertIn("immutable", str(error))

    def test_a_renamed_first_version_renames_the_lineage_it_roots(self):
        root = self.seed(self.name("Arm"))
        self.as_admin()
        v2 = self.fork(root)
        self.publish(v2["id"])
        v3 = self.fork(v2["id"])
        self.as_owner()
        # Only the owner may rename a published version (a migration does); every version follows.
        self.cur.execute("UPDATE public.schemas SET schema_name = %s WHERE id = %s;",
                         (self.name("Renamed"), root))
        for schema_id in (root, v2["id"], v3["id"]):
            self.assertEqual(self.lineage(schema_id), (root, self.name("Renamed")))

    def test_the_lineage_of_a_root_is_a_first_version(self):
        root = self.seed(self.name("Arm"))
        self.as_admin()
        v2 = self.fork(root)
        self.as_owner()
        self.cur.execute(
            "SELECT r.parent_schema_id IS NULL AND r.lineage_root_id = r.id "
            "FROM public.schemas s JOIN public.schemas r ON r.id = s.lineage_root_id WHERE s.id = %s;",
            (v2["id"],),
        )
        self.assertTrue(self.cur.fetchone()[0])

    def test_a_first_version_can_be_deleted_with_its_own_lineage_key(self):
        root = self.seed(self.name("Arm"))
        self.cur.execute("DELETE FROM public.schemas WHERE id = %s;", (root,))
        self.assertEqual(self.cur.rowcount, 1)

    def test_a_root_with_versions_cannot_be_deleted(self):
        root = self.seed(self.name("Arm"))
        self.as_admin()
        self.fork(root)
        self.as_owner()
        error = self.refused("DELETE FROM public.schemas WHERE id = %s;", (root,))
        self.assertIsNotNone(error)

    def test_the_lineage_columns_are_not_null_and_the_functions_are_not_callable_by_anon(self):
        for column in ("lineage_root_id", "lineage_name"):
            self.cur.execute(
                "SELECT attnotnull FROM pg_attribute "
                "WHERE attrelid = 'public.schemas'::regclass AND attname = %s;", (column,))
            self.assertTrue(self.cur.fetchone()[0], column)
        for fn in ("public.schemas_take_their_lineage()", "public.schemas_rename_their_lineage()"):
            for role in ("anon", "authenticated", "service_role"):
                self.cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE');", (role, fn))
                self.assertFalse(self.cur.fetchone()[0], f"{role} may execute {fn}")


class TheFillOfADatabaseThatHoldsLineages(Base):
    """
    The file run over the world an upgrade meets: schemas with no lineage columns. DDL is
    transactional, so the rollback puts the columns back.
    """

    def audit_rows(self):
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'schemas';")
        return self.cur.fetchone()[0]

    def old_world(self):
        self.cur.execute("ALTER TABLE public.schemas DROP COLUMN lineage_root_id CASCADE, "
                         "DROP COLUMN lineage_name CASCADE;")

    def test_every_row_is_filled_through_its_parent_and_the_audit_trail_hears_nothing(self):
        self.old_world()
        root = self.seed(self.name("Arm"))
        v2 = self.seed(self.name("Arm") + "_v2", status="archived", version=2, parent=root)
        v3 = self.seed(self.name("Arm") + "_v3", status="active", version=3, parent=v2)
        v4 = self.seed(self.name("Arm") + "_v4", status="draft", version=4, parent=v3)
        lone = self.seed(self.name("Lone"))
        other_root = self.seed(self.name("Pump"))
        other_v2 = self.seed(self.name("Pump") + "_v2", version=2, parent=other_root)
        before = self.audit_rows()

        self.run_file()

        for schema_id in (root, v2, v3, v4):
            self.assertEqual(self.lineage(schema_id), (root, self.name("Arm")))
        self.assertEqual(self.lineage(lone), (lone, self.name("Lone")))
        self.assertEqual(self.lineage(other_v2), (other_root, self.name("Pump")))
        self.assertEqual(self.audit_rows(), before, "the fill is not an Audit Trail event")
        # The audit trigger and the lineage trigger are on again.
        self.cur.execute(
            "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.schemas'::regclass "
            "AND tgname IN ('trg_schemas_audit_trail', 'trg_schemas_take_their_lineage', "
            "'trg_schemas_rename_their_lineage') ORDER BY tgname;")
        self.assertEqual(self.cur.fetchall(), [
            ("trg_schemas_audit_trail", "O"),
            ("trg_schemas_rename_their_lineage", "O"),
            ("trg_schemas_take_their_lineage", "O"),
        ])

    def test_a_row_inserted_before_the_trigger_existed_is_filled_too(self):
        # The window between the columns and the trigger: the columns are there, nullable, and the
        # previous release's dashboard inserts a schema.
        self.cur.execute("DROP TRIGGER trg_schemas_take_their_lineage ON public.schemas;")
        self.cur.execute("ALTER TABLE public.schemas ALTER COLUMN lineage_root_id DROP NOT NULL, "
                         "ALTER COLUMN lineage_name DROP NOT NULL;")
        self.cur.execute("INSERT INTO public.schemas (schema_name, schema_definition) "
                         "VALUES (%s, %s::jsonb) RETURNING id::text;",
                         (self.name("Window"), json.dumps(DEFINITION)))
        window = self.cur.fetchone()[0]
        self.assertEqual(self.lineage(window), (None, None))

        self.run_file()

        self.assertEqual(self.lineage(window), (window, self.name("Window")))

    def test_a_replay_changes_nothing_and_keeps_every_object(self):
        root = self.seed(self.name("Arm"))
        self.seed(self.name("Arm") + "_v2", version=2, parent=root)
        self.cur.execute(
            "SELECT oid FROM pg_constraint WHERE conrelid IN ('public.schemas'::regclass, "
            "'public.device_submodels'::regclass) AND conname IN ('schemas_lineage_root_id_fkey', "
            "'device_submodels_key_starts_with_a_letter') ORDER BY conname;")
        constraints = self.cur.fetchall()
        self.cur.execute("SELECT oid FROM pg_trigger WHERE tgname LIKE 'trg_schemas_%lineage' ORDER BY tgname;")
        triggers = self.cur.fetchall()
        before = self.audit_rows()
        self.cur.execute("SELECT id::text, lineage_root_id::text, lineage_name FROM public.schemas ORDER BY id;")
        rows = self.cur.fetchall()

        self.run_file()
        self.run_file()

        self.cur.execute(
            "SELECT oid FROM pg_constraint WHERE conrelid IN ('public.schemas'::regclass, "
            "'public.device_submodels'::regclass) AND conname IN ('schemas_lineage_root_id_fkey', "
            "'device_submodels_key_starts_with_a_letter') ORDER BY conname;")
        self.assertEqual(self.cur.fetchall(), constraints)
        self.cur.execute("SELECT oid FROM pg_trigger WHERE tgname LIKE 'trg_schemas_%lineage' ORDER BY tgname;")
        self.assertEqual(self.cur.fetchall(), triggers)
        self.assertEqual(self.audit_rows(), before)
        self.cur.execute("SELECT id::text, lineage_root_id::text, lineage_name FROM public.schemas ORDER BY id;")
        self.assertEqual(self.cur.fetchall(), rows)


class TheKeyStartsWithALetter(Base):
    def device_on(self, schema_id):
        self.cur.execute("INSERT INTO public.gateways (name) VALUES (%s) RETURNING id::text;",
                         (self.name("GW"),))
        gateway = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.devices (name, gateway_id) VALUES (%s, %s) RETURNING id::text;",
                         (self.name("DEV"), gateway))
        device = self.cur.fetchone()[0]
        return device

    def attach(self, device, schema_id, key):
        self.cur.execute(
            "INSERT INTO public.device_submodels (device_id, schema_id, submodel_key) "
            "VALUES (%s, %s, %s) RETURNING id::text;", (device, schema_id, key))
        return self.cur.fetchone()[0]

    def key(self, link_id):
        self.cur.execute("SELECT submodel_key FROM public.device_submodels WHERE id = %s;", (link_id,))
        return self.cur.fetchone()[0]

    def test_a_key_must_start_with_a_letter(self):
        schema = self.seed(self.name("Arm"))
        device = self.device_on(schema)
        error = self.refused(
            "INSERT INTO public.device_submodels (device_id, schema_id, submodel_key) VALUES (%s, %s, '_Arm');",
            (device, schema))
        self.assertIsInstance(error, psycopg2.errors.CheckViolation)
        self.assertIn("device_submodels_key_starts_with_a_letter", str(error))
        self.assertIsNone(self.refused(
            "INSERT INTO public.device_submodels (device_id, schema_id, submodel_key) VALUES (%s, %s, 'Arm_2');",
            (device, schema)))

    def test_a_key_that_began_with_an_underscore_is_rewritten_without_it(self):
        self.cur.execute("ALTER TABLE public.device_submodels "
                         "DROP CONSTRAINT device_submodels_key_starts_with_a_letter;")
        first, second, third, fourth = (self.seed(self.name(n)) for n in ("A", "B", "C", "D"))
        device = self.device_on(first)
        links = {
            "leading": self.attach(device, first, "_Arm"),
            "several": self.attach(device, second, "__Arm_2"),
            "nothing_else": self.attach(device, third, "___"),
            "fine": self.attach(device, fourth, "Arm_3"),
        }
        self.cur.execute("INSERT INTO public.device_submodels (device_id, schema_id) VALUES (%s, %s) "
                         "RETURNING id::text;", (device, self.seed(self.name("E"))))
        unset = self.cur.fetchone()[0]

        notices = self.run_file()

        self.assertEqual(self.key(links["leading"]), "Arm")
        self.assertEqual(self.key(links["several"]), "Arm_2")
        self.assertIsNone(self.key(links["nothing_else"]), "a key of nothing else goes back to the lineage")
        self.assertEqual(self.key(links["fine"]), "Arm_3")
        self.assertIsNone(self.key(unset))
        said = [n for n in notices if "0298:" in n and "underscore" in n]
        self.assertEqual(len(said), 1)
        self.assertIn("3 device_submodels key(s)", said[0])

        # A replay finds the constraint and rewrites nothing.
        notices = self.run_file()
        self.assertEqual([n for n in notices if "underscore" in n], [])

    def test_the_old_constraint_is_left_as_0001_declares_it(self):
        self.cur.execute(
            "SELECT public.live_constraint_definition('public.device_submodels'::regclass, "
            "'device_submodels_key_is_id_short');")
        self.assertEqual(
            self.cur.fetchone()[0],
            "CHECK (((submodel_key IS NULL) OR (submodel_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)))",
        )


if __name__ == "__main__":
    unittest.main()

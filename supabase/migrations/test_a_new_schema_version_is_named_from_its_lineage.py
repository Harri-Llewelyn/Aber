# suite:
#   lanes: db
#   why: 0318 -- a new schema version is named <lineage_name>_v<next> by fork_schema() and by a document
#     alike, and numbered further only while that name is taken: X_v3 follows X_v2_2, a lineage whose
#     own name ends in a version keeps it (Pump_v7_v2), a renamed lineage gives its new name, and a
#     version named before 0318 keeps its name. A file written before 0316 still finds its lineage
#     once the version in force is named from the lineage.

"""
A new schema version is named from its lineage (0318).

    python supabase/migrations/test_a_new_schema_version_is_named_from_its_lineage.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

Every name here is asked of three calls in one state, and they agree: a document's dry run, the same
document applied, and fork_schema() of the same version.

  * The name is the lineage's and the number is the parent's plus one.
  * A taken name is numbered further, and the version after it is not.
  * A version named before 0318, X_v2_2_v3, keeps its name and is followed by X_v4.
  * A lineage whose first version is named Pump_v7 is followed by Pump_v7_v2, beside a lineage Pump.
  * A renamed first version gives the lineage's later versions its new name; the ones it has keep theirs.
  * A file written before 0316 names a lineage by a version's name. It finds the lineage when its version
    in force has another name, and is refused where two lineages have that name.
  * fork_schema()'s gate, second factor and refusals, and the shape and grants of the three functions.
  * The file's self-check leaves nothing behind, on a database that holds lineages.

test_schema_versioning.py and test_a_device_schema_is_applied_from_a_document.py hold the rest of what
the two functions do.

EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest

import psycopg2
from psycopg2 import errors
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATION = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "0318_a_new_schema_version_is_named_from_its_lineage.sql")

ADMIN_ID = "b1e60318-0000-4000-8000-0000000318a1"
OPERATOR_ID = "b1e60318-0000-4000-8000-0000000318a2"
SWITCH = "security.require_mfa_for_managers"

SPINDLE = "Test_0318/Spindle_Load"
ARM = "Test_0318_Robot_Arm"
PUMP = "Test_0318_Pump"
EMPTY = json.dumps({"type": "object", "properties": {}})


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class NamedFromTheLineage(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        # By the comment, not by the body: a later body that goes back to the stem fails here.
        self.cur.execute("SELECT obj_description(to_regprocedure('public.fork_schema(uuid, text)'), 'pg_proc') LIKE '%0318%';")
        if not self.cur.fetchone()[0]:
            self.skipTest("0318 is not applied to this database")
        for user_id, role in ((ADMIN_ID, "Administrator"), (OPERATOR_ID, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@lineage-version.test"))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id)"
                             " SELECT %s, id FROM public.roles WHERE name = %s"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, role))
        self.set_switch(False)
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, description)"
                         " VALUES (%s, 10, 'Spindle load');", (SPINDLE,))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def set_switch(self, on):
        self.cur.execute("UPDATE public.system_settings SET value = %s::jsonb WHERE key = %s;", (json.dumps(on), SWITCH))

    # -- calls, as PostgREST makes them ---------------------------------------------------------

    def as_person(self, sql, args=(), user_id=ADMIN_ID):
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(
            {"sub": user_id, "role": "authenticated", "aal": "aal1"}),))
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute(sql, args)
        answer = self.cur.fetchone()[0] if self.cur.description else None
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        return answer

    def fork(self, schema_id, **who):
        return self.as_person("SELECT public.fork_schema(%s::uuid, 'why');", (schema_id,), **who)

    def publish(self, schema_id):
        self.as_person("SELECT public.publish_schema_version(%s::uuid);", (schema_id,))
        return schema_id

    def apply(self, name, dry_run):
        """A document with one metric, which every schema planted here lacks: a change, so a new version."""
        (result,) = self.as_person("SELECT public.apply_device_schemas(%s::jsonb, %s);",
                                   (Json([{"name": name, "metrics": [{"name": SPINDLE}]}]), dry_run))
        return result

    def undone(self, call):
        """What a call answers, with what it did taken back."""
        self.cur.execute("SAVEPOINT undone;")
        answer = call()
        self.cur.execute("ROLLBACK TO SAVEPOINT undone;")
        return answer

    def refused(self, call):
        """The error a call raises, contained so the transaction survives."""
        self.cur.execute("SAVEPOINT refused;")
        try:
            call()
        except psycopg2.Error as exc:
            self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
            return exc
        return self.fail("nothing was refused")

    # -- what is planted and what is read -------------------------------------------------------

    def plant(self, name, status="active", version=1, parent=None):
        """A schema as the owner, which the provenance and the immutability guards let through."""
        self.cur.execute(
            "INSERT INTO public.schemas (schema_name, schema_definition, status, version, parent_schema_id)"
            " VALUES (%s, %s::jsonb, %s, %s, %s) RETURNING id::text;", (name, EMPTY, status, version, parent))
        return self.cur.fetchone()[0]

    def named(self, schema_id):
        self.cur.execute("SELECT schema_name, version, lineage_name FROM public.schemas WHERE id = %s;", (schema_id,))
        return self.cur.fetchone()

    def next_name(self, head, name):
        """The name of the version after `head`, which a document's preview and its apply and fork_schema()
        each give in this one state."""
        said = self.apply(name, True)
        self.assertEqual((said["status"], said["reasons"]), ("changed", []))
        applied = self.undone(lambda: self.apply(name, False))
        forked = self.undone(lambda: self.fork(head))
        self.assertEqual((said["schema_name"], said["version"]), (forked["schema_name"], forked["version"]))
        self.assertEqual((applied["schema_name"], applied["version"]), (forked["schema_name"], forked["version"]))
        return forked["schema_name"]

    def make_next(self, head):
        """The next version, made and published, and its name."""
        draft = self.fork(head)
        return self.publish(draft["id"]), draft["schema_name"]

    # -- the rule -------------------------------------------------------------------------------

    def test_a_version_is_the_lineages_name_and_the_parents_number_plus_one(self):
        head = self.plant(ARM)
        for number in (2, 3, 4):
            self.assertEqual(self.next_name(head, ARM), f"{ARM}_v{number}")
            head, made = self.make_next(head)
            self.assertEqual(self.named(head), (f"{ARM}_v{number}", number, ARM))
            self.assertEqual(made, f"{ARM}_v{number}")

    def test_the_version_after_one_numbered_further_takes_the_lineages_name(self):
        first = self.plant(ARM)
        self.plant(f"{ARM}_v2", status="archived")
        self.assertEqual(self.next_name(first, ARM), f"{ARM}_v2_2")
        second, _ = self.make_next(first)
        self.assertEqual(self.next_name(second, ARM), f"{ARM}_v3")
        third, _ = self.make_next(second)
        self.assertEqual(self.named(second), (f"{ARM}_v2_2", 2, ARM))
        self.assertEqual(self.named(third), (f"{ARM}_v3", 3, ARM))
        self.assertEqual(self.next_name(third, ARM), f"{ARM}_v4")

    def test_a_document_that_makes_the_version_gives_the_name_fork_schema_gives(self):
        first = self.plant(ARM)
        self.plant(f"{ARM}_v2", status="archived")
        made = self.apply(ARM, False)
        self.assertEqual((made["status"], made["version"], made["schema_name"]), ("changed", 2, f"{ARM}_v2_2"))
        self.cur.execute("SELECT parent_schema_id::text, status FROM public.schemas WHERE id = %s;", (made["id"],))
        self.assertEqual(self.cur.fetchone(), (first, "draft"))
        self.publish(made["id"])
        self.assertEqual(self.fork(made["id"])["schema_name"], f"{ARM}_v3")

    def test_a_taken_name_is_numbered_further_until_one_is_free(self):
        first = self.plant(ARM)
        for taken in (f"{ARM}_v2", f"{ARM}_v2_2", f"{ARM}_v2_3"):
            self.plant(taken, status="archived")
        self.assertEqual(self.next_name(first, ARM), f"{ARM}_v2_4")
        second, _ = self.make_next(first)
        # The next one starts again from the lineage's name, and is numbered further only if that is taken.
        self.plant(f"{ARM}_v3", status="archived")
        self.assertEqual(self.next_name(second, ARM), f"{ARM}_v3_2")

    def test_a_discarded_drafts_name_is_free_again(self):
        first = self.plant(ARM)
        draft = self.fork(first)
        self.as_person("SELECT public.discard_schema_draft(%s::uuid);", (draft["id"],))
        self.assertEqual(self.next_name(first, ARM), f"{ARM}_v2")

    def test_a_version_named_before_0318_keeps_its_name_and_is_followed_by_the_lineages(self):
        first = self.plant(ARM, status="archived")
        second = self.plant(f"{ARM}_v2_2", status="archived", version=2, parent=first)
        third = self.plant(f"{ARM}_v2_2_v3", version=3, parent=second)
        self.assertEqual(self.next_name(third, ARM), f"{ARM}_v4")
        self.make_next(third)
        self.assertEqual([self.named(i)[0] for i in (first, second, third)],
                         [ARM, f"{ARM}_v2_2", f"{ARM}_v2_2_v3"])

    def test_the_number_is_the_versions_own_not_one_read_from_a_name(self):
        first = self.plant(ARM, status="archived")
        head = self.plant(f"{ARM}_v3", version=8, parent=first)
        self.assertEqual(self.next_name(head, ARM), f"{ARM}_v9")

    def test_a_lineage_whose_own_name_ends_in_a_version_keeps_it(self):
        pump = self.plant(PUMP)
        seventh = self.plant(f"{PUMP}_v7")
        self.assertEqual(self.next_name(seventh, f"{PUMP}_v7"), f"{PUMP}_v7_v2")
        second, _ = self.make_next(seventh)
        self.assertEqual(self.named(second), (f"{PUMP}_v7_v2", 2, f"{PUMP}_v7"))
        self.assertEqual(self.next_name(second, f"{PUMP}_v7"), f"{PUMP}_v7_v3")
        # The lineage beside it is versioned under its own name, around the first's.
        self.assertEqual(self.next_name(pump, PUMP), f"{PUMP}_v2")
        sixth, _ = self.make_next(pump)
        self.cur.execute("UPDATE public.schemas SET version = 6 WHERE id = %s;", (sixth,))
        self.assertEqual(self.next_name(sixth, PUMP), f"{PUMP}_v7_2")

    # -- a renamed lineage ----------------------------------------------------------------------

    def test_a_renamed_lineage_of_several_versions_gives_its_new_name(self):
        first = self.plant(ARM)
        second, _ = self.make_next(first)
        # Only the owner renames a published version, as a migration does.
        self.cur.execute("UPDATE public.schemas SET schema_name = 'Test_0318_Welder' WHERE id = %s;", (first,))
        self.assertEqual(self.named(second), (f"{ARM}_v2", 2, "Test_0318_Welder"))
        self.assertEqual(self.next_name(second, "Test_0318_Welder"), "Test_0318_Welder_v3")
        # A file written before the rename finds it by the version that kept its name, for the same draft.
        self.assertEqual(self.next_name(second, ARM), "Test_0318_Welder_v3")

    def test_a_first_version_renamed_as_a_draft_gives_its_new_name(self):
        draft = self.as_person("INSERT INTO public.schemas (schema_name, schema_definition, status)"
                               " VALUES (%s, %s::jsonb, 'draft') RETURNING id::text;", (ARM, EMPTY))
        self.as_person("UPDATE public.schemas SET schema_name = 'Test_0318_Welder' WHERE id = %s;", (draft,))
        self.publish(draft)
        self.assertEqual(self.named(draft), ("Test_0318_Welder", 1, "Test_0318_Welder"))
        self.assertEqual(self.next_name(draft, "Test_0318_Welder"), "Test_0318_Welder_v2")

    # -- a file written before 0316 -------------------------------------------------------------

    def test_a_file_that_names_a_version_numbered_further_still_finds_the_lineage(self):
        first = self.plant(ARM)
        self.plant(f"{ARM}_v2", status="archived")
        second, _ = self.make_next(first)
        third, _ = self.make_next(second)
        # What an export before 0316 called the lineage while X_v2_2 was in force. X_v3 is now.
        found = self.apply(f"{ARM}_v2_2", True)
        self.assertEqual((found["status"], found["id"], found["reasons"]), ("changed", third, []))
        self.assertEqual(self.next_name(third, f"{ARM}_v2_2"), f"{ARM}_v4")
        made = self.apply(f"{ARM}_v2_2", False)
        self.publish(made["id"])
        again = self.apply(f"{ARM}_v2_2", True)
        self.assertEqual((again["status"], again["id"], again["version"]), ("unchanged", made["id"], 4))

    def test_a_file_that_names_a_first_version_without_its_number_still_finds_the_lineage(self):
        # Before 0316 a lineage whose first version is Pump_v7 was exported as Pump.
        seventh = self.plant(f"{PUMP}_v7")
        self.assertEqual(self.apply(PUMP, True)["id"], seventh)
        second, _ = self.make_next(seventh)
        found = self.apply(PUMP, True)
        self.assertEqual((found["status"], found["id"], found["reasons"]), ("changed", second, []))

    def test_a_name_two_lineages_versions_have_is_refused(self):
        for number in (7, 8):
            self.make_next(self.plant(f"{PUMP}_v{number}"))
        found = self.apply(PUMP, True)
        self.assertEqual(found["status"], "refused")
        self.assertEqual([(r["path"], r["message"]) for r in found["reasons"]], [
            ("$[0].name", f"More than one schema here is called `{PUMP}`, so Aber cannot tell which the file means.")])

    def test_a_version_with_nothing_in_force_is_still_refused(self):
        self.plant(f"{PUMP}_v7", status="archived")
        found = self.apply(PUMP, True)
        self.assertEqual([r["message"] for r in found["reasons"]], [
            f"`{PUMP}` has no version in force. Publish its draft on the Schemas page first."])

    # -- the rest of both functions, as they were -----------------------------------------------

    def test_fork_schema_refuses_as_it_did(self):
        head = self.plant(ARM)
        self.assertIsInstance(self.refused(lambda: self.fork(head, user_id=OPERATOR_ID)), errors.InsufficientPrivilege)
        self.set_switch(True)
        second_factor = self.refused(lambda: self.fork(head))
        self.assertIsInstance(second_factor, errors.InsufficientPrivilege)
        self.assertEqual(second_factor.diag.message_detail, "mfa_required")
        self.set_switch(False)

        missing = self.refused(lambda: self.fork("00000000-0000-4000-8000-0000000318ff"))
        self.assertEqual(missing.pgcode, "PGRST")
        self.assertEqual(json.loads(missing.diag.message_primary)["code"], "P0002")
        self.assertEqual(json.loads(missing.diag.message_detail)["status"], 404)

        archived = self.plant(f"{ARM}_Old", status="archived")
        self.assertIsInstance(self.refused(lambda: self.fork(archived)), errors.CheckViolation)
        self.fork(head)
        self.assertIsInstance(self.refused(lambda: self.fork(head)), errors.UniqueViolation)

    def test_the_three_functions_keep_their_shape_and_grants(self):
        roles = ("anon", "authenticated", "service_role")
        for fn, definer, may in (
                ("public.fork_schema(uuid, text)", True, (False, True, True)),
                ("public.apply_device_schemas(jsonb, boolean)", True, (False, True, False)),
                ("public.device_schemas_parse(jsonb)", False, (False, False, False))):
            with self.subTest(fn=fn):
                self.cur.execute("SELECT prosecdef, proconfig, proowner::regrole::text FROM pg_proc WHERE oid = %s::regprocedure;", (fn,))
                self.assertEqual(self.cur.fetchone(), (definer, ["search_path=public"], "postgres"))
                self.cur.execute("SELECT has_function_privilege('public', %s, 'EXECUTE');", (fn,))
                self.assertFalse(self.cur.fetchone()[0])
                held = []
                for role in roles:
                    self.cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE');", (role, fn))
                    held.append(self.cur.fetchone()[0])
                self.assertEqual(tuple(held), may)

    def test_the_checked_schema_carries_no_stem(self):
        self.plant(ARM)
        self.cur.execute("SELECT public.device_schemas_parse(%s::jsonb) -> 0 -> 'canon';",
                         (Json([{"name": ARM, "metrics": [{"name": SPINDLE}]}]),))
        canon = self.cur.fetchone()[0]
        self.assertEqual(canon["lineage"], ARM)
        self.assertNotIn("stem", canon)

    def test_the_files_self_check_passes_over_lineages_and_leaves_nothing_behind(self):
        head, _ = self.make_next(self.plant(ARM))
        self.plant(f"{PUMP}_v7")
        counts = ("SELECT (SELECT count(*) FROM public.schemas), (SELECT count(*) FROM auth.users),"
                  " (SELECT count(*) FROM public.user_roles), (SELECT count(*) FROM public.metric_catalog),"
                  " (SELECT count(*) FROM public.audit_trail);")
        self.cur.execute(counts)
        before = self.cur.fetchone()
        with open(MIGRATION, "r", encoding="utf-8") as handle:
            sql = handle.read()
        for _ in range(2):
            self.cur.execute(sql)
        self.cur.execute(counts)
        self.assertEqual(self.cur.fetchone(), before)
        self.cur.execute("SELECT coalesce(current_setting('request.jwt.claims', true), '');")
        self.assertEqual(self.cur.fetchone()[0], "")
        self.assertEqual(self.next_name(head, ARM), f"{ARM}_v3")


if __name__ == "__main__":
    unittest.main(verbosity=2)

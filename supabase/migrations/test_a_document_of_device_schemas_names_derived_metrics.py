# suite:
#   lanes: db
#   why: 0336 -- the schemas file carries `derived_metrics`: exported in name order and applied back
#     unchanged, compared with the version in force, a change making a draft whose list is the file's; a
#     file without the key names none, and the result lists each one it removes; every refusal is at the
#     line of the derived metric it is about, a state the schema would not permit among them.

"""
A document of device schemas names derived metrics (0336).

    python supabase/migrations/test_a_document_of_device_schemas_names_derived_metrics.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

  * An export holds the list in name order, and no key for an empty one. Applied back it is unchanged.
  * A new schema takes the file's list. A changed one makes a draft with the file's list, also an empty
    one, and the version in force keeps its own. A draft that says it already is unchanged.
  * A file without the key names none: the result lists what it removes, under `derived_metrics`, and
    `derived_metrics` is among `changes`, as any key the file leaves out is.
  * What is refused, and where: a name the catalogue lacks, a measured metric, a deprecated one the version
    in force does not name, one twice, one whose input the file does not list, and one that counts a state
    the definition to be written would not permit. A refusal writes nothing.
  * A derived metric among `metrics` is told where it goes.

EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest

import psycopg2
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN_ID = "b3e60336-0000-4000-8000-0000000336c1"
SWITCH = "security.require_mfa_for_managers"
ARM = "Test_0336_File_Arm"
COUNT, SPEED, MODE = "Test_0336_F/Count", "Test_0336_F/Speed", "Test_0336_F/Mode"
RATE, REVS, AUTO = "Test_0336_FD/Rate", "Test_0336_FD/Revs", "Test_0336_FD/Automatic"


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def schema(metrics=(COUNT, SPEED), derived=None, name=ARM, **over):
    """One schema of a document; `derived` None leaves the key out."""
    out = {"name": name, "metrics": [{"name": m} for m in metrics], **over}
    if derived is not None:
        out["derived_metrics"] = list(derived)
    return out


class TheFileNamesDerivedMetrics(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.device_schema_derived_part(text[])') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0336 is not applied to this database")
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                         (ADMIN_ID, f"{ADMIN_ID}@derived-file.test"))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id)"
                         " SELECT %s, id FROM public.roles WHERE name = 'Administrator'"
                         " ON CONFLICT (user_id, role_id) DO NOTHING;", (ADMIN_ID,))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))
        for name, datatype, permitted in ((COUNT, 10, None), (SPEED, 10, None), (MODE, 12, ["AUTO", "MANUAL"])):
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, permitted_values) VALUES (%s, %s, %s);",
                             (name, datatype, permitted))
        for name, derivation in ((RATE, {"kind": "counter_rate", "input": COUNT}),
                                 (REVS, {"kind": "counter_rate", "input": SPEED}),
                                 (AUTO, {"kind": "time_in_state", "input": MODE, "states": ["AUTO"]})):
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, 10, %s);",
                             (name, Json(derivation)))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def as_person(self, sql, args=()):
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(
            {"sub": ADMIN_ID, "role": "authenticated", "aal": "aal1"}),))
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute(sql, args)
        answer = self.cur.fetchone()[0]
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        return answer

    def apply(self, *schemas, dry_run=False):
        return self.as_person("SELECT public.apply_device_schemas(%s::jsonb, %s);", (Json(list(schemas)), dry_run))

    def one(self, document, dry_run=False):
        (result,) = self.apply(document, dry_run=dry_run)
        return result

    def document(self, *ids):
        return self.as_person("SELECT public.device_schemas_document(%s::uuid[]);", (list(ids),))

    def names(self, schema_id):
        self.cur.execute("SELECT status, derived_metrics FROM public.schemas WHERE id = %s;", (schema_id,))
        return self.cur.fetchone()

    def made(self, *args, **kwargs):
        result = self.one(schema(*args, **kwargs))
        self.assertEqual(result["status"], "new", result)
        return result["id"]

    # -- the way there and back --------------------------------------------------------------------

    def test_a_new_schema_takes_the_files_list(self):
        self.assertEqual(self.names(self.made(derived=[REVS, RATE])), ("active", [RATE, REVS]))

    def test_an_export_holds_them_in_name_order_and_applies_back_unchanged(self):
        first = self.made(derived=[REVS, RATE])
        (doc,) = self.document(first)
        self.assertEqual(doc["derived_metrics"], [RATE, REVS])
        self.assertEqual(self.one(doc, dry_run=True)["status"], "unchanged")
        doc["derived_metrics"] = [REVS, RATE]
        self.assertEqual(self.one(doc, dry_run=True)["status"], "unchanged", "the order of the list does not matter")

    def test_a_schema_that_names_none_exports_no_key(self):
        (doc,) = self.document(self.made())
        self.assertNotIn("derived_metrics", doc)
        self.assertEqual(self.one({**doc, "derived_metrics": []}, dry_run=True)["status"], "unchanged")

    # -- what a file changes -------------------------------------------------------------------------

    def test_naming_one_more_is_a_draft_with_the_files_list(self):
        first = self.made(derived=[RATE])
        result = self.one(schema(derived=[RATE, REVS]))
        self.assertEqual((result["status"], result["version"], result["changes"]), ("changed", 2, ["derived_metrics"]))
        self.assertEqual(result["derived_metrics"], {"added": [REVS], "removed": []})
        self.assertEqual(result["metrics"], {"added": [], "removed": [], "changed": []})
        self.assertEqual(self.names(result["id"]), ("draft", [RATE, REVS]))
        self.assertEqual(self.names(first), ("active", [RATE]))
        # The draft says it now, so the same file makes nothing more.
        again = self.one(schema(derived=[RATE, REVS]), dry_run=True)
        self.assertEqual((again["status"], again["id"]), ("unchanged", result["id"]))

    def test_a_file_without_the_key_names_none_and_the_result_lists_what_it_removes(self):
        first = self.made(derived=[RATE, REVS])
        preview = self.one(schema(), dry_run=True)
        self.assertEqual((preview["status"], preview["changes"]), ("changed", ["derived_metrics"]))
        self.assertEqual(preview["derived_metrics"], {"added": [], "removed": [RATE, REVS]})
        result = self.one(schema())
        self.assertEqual(self.names(result["id"]), ("draft", []), "the draft is not given its parent's list")
        self.assertEqual(self.names(first), ("active", [RATE, REVS]), "a published version is never edited")

    def test_a_key_the_file_leaves_out_is_among_the_changes(self):
        self.made(derived=[RATE], description="What an arm publishes")
        self.assertEqual(self.one(schema(derived=[RATE]), dry_run=True)["changes"], ["description"])

    def test_a_change_of_the_metrics_alone_says_nothing_of_derived_metrics(self):
        self.made(metrics=(COUNT,), derived=[RATE])
        result = self.one(schema(derived=[RATE]), dry_run=True)
        self.assertEqual((result["changes"], result["derived_metrics"]), (["metrics"], {"added": [], "removed": []}))

    def test_only_a_changed_schema_has_the_lists(self):
        self.assertIsNone(self.one(schema(derived=[RATE]), dry_run=True)["derived_metrics"])
        self.made(derived=[RATE])
        self.assertIsNone(self.one(schema(derived=[RATE]), dry_run=True)["derived_metrics"])

    # -- what is refused, and where --------------------------------------------------------------------

    def refusal(self, document):
        before = self.count()
        result = self.one(document)
        self.assertEqual(result["status"], "refused", result)
        self.assertEqual(self.count(), before, "a refusal writes nothing")
        return [(r["path"], r["message"]) for r in result["reasons"]]

    def count(self):
        self.cur.execute("SELECT (SELECT count(*) FROM public.schemas), (SELECT count(*) FROM public.audit_trail);")
        return self.cur.fetchone()

    def test_each_refusal_is_at_the_line_of_its_derived_metric(self):
        reasons = self.refusal(schema(metrics=(COUNT,), derived=[RATE, "Test_0336_FD/Nowhere", COUNT, REVS, RATE]))
        self.assertEqual([path for path, _ in reasons], [f"$[0].derived_metrics[{i}]" for i in (1, 2, 3, 4)])
        for (_, message), words in zip(reasons, ("Test_0336_FD/Nowhere is not in the metric catalogue",
                                                f"{COUNT} is a measured metric",
                                                f"{REVS} is computed from {SPEED}, which this schema does not model",
                                                "listed twice")):
            self.assertIn(words, message)

    def test_a_file_that_drops_an_input_and_keeps_the_derived_metric_is_refused(self):
        self.made(derived=[RATE, REVS])
        ((path, message),) = self.refusal(schema(metrics=(COUNT,), derived=[RATE, REVS]))
        self.assertEqual(path, "$[0].derived_metrics[1]")
        self.assertIn(f"{REVS} is computed from {SPEED}", message)

    def test_an_input_that_is_listed_and_refused_for_itself_is_not_refused_twice(self):
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE name = %s;", (SPEED,))
        reasons = self.refusal(schema(derived=[REVS]))
        self.assertEqual([path for path, _ in reasons], ["$[0].metrics[1].name"])

    def test_a_state_the_definition_to_be_written_would_not_permit_is_refused_in_the_preview_too(self):
        self.cur.execute("UPDATE public.metric_catalog SET permitted_values = '{MANUAL}' WHERE name = %s;", (MODE,))
        document = schema(metrics=(COUNT, MODE), derived=[RATE, AUTO])
        for dry_run in (True, False):
            with self.subTest(dry_run=dry_run):
                result = self.one(document, dry_run=dry_run)
                self.assertEqual(result["status"], "refused")
                ((path, message),) = [(r["path"], r["message"]) for r in result["reasons"]]
                self.assertEqual(path, "$[0].derived_metrics[1]")
                self.assertIn(f'{AUTO} counts the state "AUTO", which this schema does not permit {MODE} to report (MANUAL)', message)

    def test_an_unchanged_schema_is_not_judged_by_a_catalogue_that_has_changed_since(self):
        first = self.made(metrics=(MODE,), derived=[AUTO])
        self.cur.execute("UPDATE public.metric_catalog SET permitted_values = '{MANUAL}' WHERE name = %s;", (MODE,))
        (doc,) = self.document(first)
        self.assertEqual(self.one(doc, dry_run=True)["status"], "unchanged")
        result = self.one({**doc, "description": "Edited"}, dry_run=True)
        self.assertEqual((result["status"], result["reasons"][0]["path"]), ("refused", "$[0].derived_metrics[0]"))

    def test_a_deprecated_one_is_kept_where_the_version_in_force_names_it_and_added_nowhere(self):
        self.made(derived=[RATE])
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE name = ANY (%s);", ([RATE, REVS],))
        self.assertEqual(self.one(schema(derived=[RATE]), dry_run=True)["status"], "unchanged")
        self.assertEqual(self.one(schema(derived=[RATE], description="Edited"), dry_run=True)["status"], "changed")
        ((path, message),) = self.refusal(schema(derived=[RATE, REVS]))
        self.assertEqual(path, "$[0].derived_metrics[1]")
        self.assertIn("is deprecated. A schema may keep it but not add it.", message)

    def test_a_derived_metric_among_the_metrics_is_told_where_it_goes(self):
        ((path, message),) = self.refusal(schema(metrics=(COUNT, RATE)))
        self.assertEqual(path, "$[0].metrics[1].name")
        self.assertIn("name it under `derived_metrics`", message)

    def test_the_key_is_one_a_schema_takes_and_the_message_lists_it(self):
        ((_, message),) = self.refusal({**schema(), "derived": [RATE]})
        self.assertIn("metrics and derived_metrics", message)

    def test_too_many_is_refused(self):
        reasons = self.refusal(schema(derived=["Test_0336_FD/N"] * 1001))
        self.assertEqual(reasons, [("$[0].derived_metrics", "A schema names at most 1000 derived metrics.")])

    def test_who_may_is_as_it_was(self):
        self.cur.execute("SELECT has_function_privilege('anon', 'public.apply_device_schemas(jsonb, boolean)', 'EXECUTE'),"
                         " has_function_privilege('service_role', 'public.apply_device_schemas(jsonb, boolean)', 'EXECUTE'),"
                         " has_function_privilege('authenticated', 'public.device_schemas_document(uuid[])', 'EXECUTE');")
        self.assertEqual(self.cur.fetchone(), (False, False, True))
        self.cur.execute("UPDATE public.user_roles SET role_id = (SELECT id FROM public.roles WHERE name = 'Shopfloor_Manager')"
                         " WHERE user_id = %s;", (ADMIN_ID,))
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.one(schema(derived=[RATE]), dry_run=True)


if __name__ == "__main__":
    unittest.main()

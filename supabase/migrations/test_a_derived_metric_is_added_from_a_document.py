# suite:
#   lanes: db
#   why: 0297 -- who adds a document of derived metrics (an Administrator, with the second factor, and
#     no machine identity or other role); apply_derived_metrics() (a dry run and a refusal write
#     nothing, new and unchanged are told apart, nothing is edited or deleted, a changed definition
#     or description and a name that is taken are refused and say what to do, every input the
#     catalogue lacks is named at once, every other refusal is the table's own words); the Audit
#     Trail rows; and the round trip through derived_metrics_document().

"""
A derived metric is added from a document (0297).

    python supabase/migrations/test_a_derived_metric_is_added_from_a_document.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * Who adds: an Administrator, as the catalogue's insert policy asks. A Shopfloor Manager, an
    Operator, an Auditor, a person with no role, a machine identity and anon are refused. With
    security.require_mfa_for_managers on, an Administrator needs a session that gave its code. Every
    signed-in role reads derived_metrics_document().
  * apply_derived_metrics(): a dry run writes nothing; one refusal writes nothing at all; a new metric
    is a Double with its definition and the unit the trigger works out; one that exists with the same
    definition and description is unchanged, whatever the order of its states or its inputs, and
    writes nothing. It never edits and never deletes: another definition or description under a name
    that exists, a measured metric's name and a deprecated one's are refused, and each says what to do.
  * What a document may say: no unit and no datatype, the keys of the kind and no others, an input the
    catalogue lacks or that is derived refused by name (every one in one pass), a deprecated input
    accepted as the table accepts it.
  * Every other refusal is enforce_derived_metric()'s own: each reason is the very sentence a direct
    INSERT raises, at the line of the input or the states it names.
  * The Audit Trail: one INSERT row for each metric added, naming the person, and none for a dry run,
    an unchanged metric or a refusal.
  * derived_metrics_document(): the derived metrics in name order, a deprecated one not among them;
    apply_derived_metrics() of it reports every metric unchanged.

EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest
import uuid

import psycopg2
import psycopg2.errors
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN_ID = "a0d17297-0000-4000-8000-0000000297a1"
MANAGER_ID = "a0d17297-0000-4000-8000-0000000297a2"
OPERATOR_ID = "a0d17297-0000-4000-8000-0000000297a3"
AUDITOR_ID = "a0d17297-0000-4000-8000-0000000297a4"
MACHINE_ID = "a0d17297-0000-4000-8000-0000000297a5"
NOBODY_ID = "a0d17297-0000-4000-8000-0000000297a6"
PEOPLE = ((ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager"), (OPERATOR_ID, "Operator"),
          (AUDITOR_ID, "Auditor"))
SWITCH = "security.require_mfa_for_managers"

T = "Test_0297"
PARTS = f"{T}/Part_Count"
PHASE_A = f"{T}/Phase_A"
PHASE_B = f"{T}/Phase_B"
PHASE_KW = f"{T}/Phase_Kw"
MODE = f"{T}/Mode"
DOOR = f"{T}/Door_Open"
PROGRAM = f"{T}/Program"
OLD_GAUGE = f"{T}/Old_Gauge"
HELD = f"{T}/Held_By_A_Gauge"
RATE = f"{T}/Parts_Per_Hour"
RETIRED = f"{T}/Old_Rate"
NOTHING = f"{T}/Nothing_Publishes_This"
RATE_DESCRIPTION = "Parts per hour."


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def rate(name=f"{T}/New_Rate", input=PARTS, **over):
    out = {"name": name, "kind": "counter_rate", "input": input}
    out.update(over)
    return out


def share(name=f"{T}/New_Share", input=MODE, states=("AUTO",), **over):
    out = {"name": name, "kind": "time_in_state", "input": input, "states": list(states)}
    out.update(over)
    return out


def total(name=f"{T}/New_Sum", *inputs, **over):
    pairs = inputs or ((PHASE_A, 1), (PHASE_B, -1))
    out = {"name": name, "kind": "sum", "inputs": [{"metric": m, "sign": s} for m, s in pairs]}
    out.update(over)
    return out


class DerivedBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.apply_derived_metrics(jsonb, boolean)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0297 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, self.email(user_id)))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        # A person with no role at all, and a machine identity that holds the schema permission: neither
        # satisfies has_role(), which is the catalogue's own gate.
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                         (NOBODY_ID, self.email(NOBODY_ID)))
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, NULL, '', now()) ON CONFLICT (id) DO NOTHING;", (MACHINE_ID,))
        self.cur.execute("INSERT INTO public.principal_permissions (principal_id, permission_id)"
                         " SELECT %s, id FROM public.permissions WHERE name = 'schema:manage';", (MACHINE_ID,))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))

        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, 10), (%s, 10);", (PARTS, HELD))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, units) VALUES (%s, 10, 'W'), (%s, 10, 'W'), (%s, 10, 'kW');",
                         (PHASE_A, PHASE_B, PHASE_KW))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, permitted_values)"
                         " VALUES (%s, 12, ARRAY['AUTO', 'MANUAL', 'STOPPED']);", (MODE,))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, 11), (%s, 12);", (DOOR, PROGRAM))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, deprecated) VALUES (%s, 10, true);", (OLD_GAUGE,))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, description, derivation)"
                         " VALUES (%s, 10, %s, %s::jsonb);",
                         (RATE, RATE_DESCRIPTION, json.dumps({"kind": "counter_rate", "input": PARTS})))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation, deprecated)"
                         " VALUES (%s, 10, %s::jsonb, true);", (RETIRED, json.dumps({"kind": "counter_rate", "input": PARTS})))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    @staticmethod
    def email(user_id):
        return f"{user_id[-4:]}@derived-metrics.test"

    def claims(self, user_id, aal="aal1"):
        self.cur.execute("RESET ROLE;")
        claims = {"sub": user_id, "role": "authenticated", "aal": aal}
        if user_id != MACHINE_ID:
            claims["email"] = self.email(user_id)
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
        self.cur.execute("SET LOCAL ROLE authenticated;")

    def owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")

    def as_person(self, user_id, sql, args=(), aal="aal1"):
        """Run `sql` as PostgREST would for a person's token. A refusal rolls back to the savepoint,
        so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT derived_call;")
        try:
            self.claims(user_id, aal)
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT derived_call;")
            raise
        finally:
            self.owner()
        self.cur.execute("RELEASE SAVEPOINT derived_call;")
        return rows

    def apply(self, document, dry_run=False, user_id=ADMIN_ID, aal="aal1"):
        return self.as_person(user_id, "SELECT public.apply_derived_metrics(%s::jsonb, %s);",
                              (Json(document), dry_run), aal)[0][0]

    def document(self, ids=None, user_id=OPERATOR_ID):
        return self.as_person(user_id, "SELECT public.derived_metrics_document(%s::uuid[]);", (ids,))[0][0]

    def row(self, name):
        self.cur.execute("SELECT id::text, name, datatype, description, units, derivation, deprecated, superseded_by::text,"
                         "       semantic_id, standard FROM public.metric_catalog WHERE name = %s;", (name,))
        return self.cur.fetchone()

    def derived_rows(self):
        self.cur.execute("SELECT id::text, name, datatype, description, units, derivation, deprecated, semantic_id"
                         "  FROM public.metric_catalog WHERE name LIKE %s ORDER BY name;", (f"{T}%",))
        return self.cur.fetchall()

    def audit(self):
        self.cur.execute(
            "SELECT action, entity_id::text, changed_by::text, actor_source, new_data ->> 'name'"
            "  FROM public.audit_trail WHERE entity_type = 'metric_catalog' AND new_data ->> 'name' LIKE %s ORDER BY id;",
            (f"{T}%",))
        return self.cur.fetchall()

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, str(caught.exception))
        return caught.exception

    @staticmethod
    def reasons(results):
        return [(r["path"], r["message"]) for item in results for r in item["reasons"]]


class Access(DerivedBase):
    def test_anon_may_execute_neither_function_and_signed_in_roles_both(self):
        for signature in ("apply_derived_metrics(jsonb, boolean)", "derived_metrics_document(uuid[])",
                          "derived_metric_document_of(text, text, jsonb)", "derived_metric_description(text)"):
            with self.subTest(function=signature):
                self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'),"
                                 "       has_function_privilege('authenticated', %s, 'EXECUTE');",
                                 (f"public.{signature}", f"public.{signature}"))
                self.assertEqual(self.cur.fetchone(), (False, True))

    def test_the_helpers_are_no_browsers(self):
        for signature in ("derived_metrics_parse(jsonb)", "derived_metric_refusal_path(text, jsonb, text, text)",
                          "derivation_canonical(jsonb)"):
            with self.subTest(function=signature):
                self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'),"
                                 "       has_function_privilege('authenticated', %s, 'EXECUTE');",
                                 (f"public.{signature}", f"public.{signature}"))
                self.assertEqual(self.cur.fetchone(), (False, False))

    def test_only_an_administrator_applies(self):
        before = self.derived_rows()
        for user_id in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NOBODY_ID, MACHINE_ID):
            for dry_run in (True, False):
                with self.subTest(user=user_id, dry_run=dry_run):
                    self.assertRefused("42501", self.apply, [rate()], dry_run, user_id)
        self.assertEqual(self.derived_rows(), before)
        self.assertEqual(self.apply([rate()], user_id=ADMIN_ID)[0]["status"], "new")

    def test_the_function_and_the_table_agree_on_who_may_add(self):
        """The catalogue's insert policy refuses the roles the function refuses, and admits the one it admits."""
        for user_id in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID):
            with self.subTest(user=user_id):
                self.assertRefused("42501", self.as_person, user_id,
                                   "INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, 10, %s::jsonb);",
                                   (f"{T}/By_Hand", json.dumps({"kind": "counter_rate", "input": PARTS})))
        self.as_person(ADMIN_ID, "INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, 10, %s::jsonb);",
                       (f"{T}/By_Hand", json.dumps({"kind": "counter_rate", "input": PARTS})))

    def test_anon_is_refused(self):
        self.cur.execute("SAVEPOINT anon_call;")
        self.cur.execute("SET LOCAL ROLE anon;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.apply_derived_metrics('[]'::jsonb, true);")
        self.cur.execute("ROLLBACK TO SAVEPOINT anon_call;")

    def test_with_the_switch_on_an_administrator_needs_a_session_that_gave_its_code(self):
        self.owner()
        self.cur.execute("UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = %s;", (SWITCH,))
        for dry_run in (True, False):
            err = self.assertRefused("42501", self.apply, [rate()], dry_run, ADMIN_ID)
            self.assertEqual(err.diag.message_detail, "mfa_required")
        self.assertEqual(self.apply([rate()], user_id=ADMIN_ID, aal="aal2")[0]["status"], "new")
        # Reading is not a write.
        self.assertEqual([m["name"] for m in self.document(user_id=OPERATOR_ID)], [f"{T}/New_Rate", RATE])

    def test_every_signed_in_role_reads_the_document(self):
        for user_id in (ADMIN_ID, MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NOBODY_ID, MACHINE_ID):
            with self.subTest(user=user_id):
                self.assertEqual([m["name"] for m in self.document(user_id=user_id)], [RATE])

    def test_a_missing_dry_run_flag_is_refused(self):
        self.assertRefused("22023", self.as_person, ADMIN_ID, "SELECT public.apply_derived_metrics('[]'::jsonb, NULL);")


class Applying(DerivedBase):
    def test_a_dry_run_writes_nothing_and_says_what_it_would_do(self):
        before = (self.derived_rows(), self.audit())
        results = self.apply([rate(), share(), total()], dry_run=True)
        self.assertEqual((self.derived_rows(), self.audit()), before)
        self.assertEqual([(r["name"], r["status"], r["id"], r["units"], r["reasons"]) for r in results],
                         [(f"{T}/New_Rate", "new", None, "COUNT/HOUR", []),
                          (f"{T}/New_Share", "new", None, None, []),
                          (f"{T}/New_Sum", "new", None, "W", [])])
        self.assertEqual(results[0]["derivation"], {"kind": "counter_rate", "input": PARTS})
        self.assertEqual(results[1]["derivation"], {"kind": "time_in_state", "input": MODE, "states": ["AUTO"]})

    def test_a_new_derived_metric_is_a_double_with_its_definition_and_the_unit_its_inputs_give(self):
        results = self.apply([rate(description="  Parts made per hour.  "), share(), total(),
                              rate(f"{T}/Watts_Per_Hour", PHASE_A)])
        self.assertEqual([r["status"] for r in results], ["new"] * 4)
        by_name = {r["name"]: r for r in results}
        rate_row = self.row(f"{T}/New_Rate")
        self.assertEqual(rate_row[0], by_name[f"{T}/New_Rate"]["id"])
        # datatype, description (trimmed), units, derivation, deprecated, superseded_by, semantic_id, standard
        self.assertEqual(rate_row[2:], (10, "Parts made per hour.", "COUNT/HOUR", {"kind": "counter_rate", "input": PARTS},
                                        False, None, None, None))
        self.assertEqual(self.row(f"{T}/New_Share")[3:6], (None, None, {"kind": "time_in_state", "input": MODE, "states": ["AUTO"]}))
        self.assertEqual(self.row(f"{T}/New_Sum")[4:6], ("W", {"kind": "sum", "inputs": [
            {"metric": PHASE_A, "sign": 1}, {"metric": PHASE_B, "sign": -1}]}))
        self.assertEqual(self.row(f"{T}/Watts_Per_Hour")[4], "W/HOUR")
        self.assertEqual(by_name[f"{T}/New_Sum"]["units"], "W")

    def test_an_empty_description_is_none_and_a_state_of_a_boolean_is_text(self):
        self.apply([rate(description="   "), share(f"{T}/Door_Share", DOOR, ["true", "false"])])
        self.assertIsNone(self.row(f"{T}/New_Rate")[3])
        self.assertEqual(self.row(f"{T}/Door_Share")[5]["states"], ["true", "false"])

    def test_an_unchanged_derived_metric_is_reported_so_and_writes_nothing(self):
        before = (self.derived_rows(), self.audit())
        results = self.apply([rate(RATE, description=RATE_DESCRIPTION)])
        self.assertEqual([(r["status"], r["id"], r["units"], r["reasons"]) for r in results],
                         [("unchanged", self.row(RATE)[0], "COUNT/HOUR", [])])
        self.assertEqual((self.derived_rows(), self.audit()), before)

    def test_a_definition_in_another_order_is_the_same_definition(self):
        self.apply([share(f"{T}/Two_States", MODE, ["AUTO", "MANUAL"]),
                    total(f"{T}/Two_Phases", (PHASE_A, 1), (PHASE_B, -1))])
        before = self.derived_rows()
        again = self.apply([share(f"{T}/Two_States", MODE, ["MANUAL", "AUTO"]),
                            total(f"{T}/Two_Phases", (PHASE_B, -1), (PHASE_A, 1))])
        self.assertEqual([r["status"] for r in again], ["unchanged", "unchanged"])
        self.assertEqual(self.derived_rows(), before)

    def test_a_changed_definition_is_refused_and_says_how(self):
        before = self.row(RATE)
        results = self.apply([rate(RATE, PHASE_A, description=RATE_DESCRIPTION)], dry_run=True)
        self.assertEqual(results[0]["status"], "refused")
        (path, message), = self.reasons(results)
        self.assertEqual(path, "$[0].name")
        self.assertIn("another definition", message)
        self.assertIn("fixed once saved", message)
        self.assertIn("new name", message)
        self.assertIn("deprecate", message)
        self.assertIn("Superseded By", message)
        self.assertEqual(self.apply([rate(RATE, PHASE_A, description=RATE_DESCRIPTION)], dry_run=False)[0]["status"], "refused")
        self.assertEqual(self.row(RATE), before, "an upload never edits")

    def test_a_changed_description_is_refused_and_says_where_it_cannot_be_edited(self):
        before = self.row(RATE)
        results = self.apply([rate(RATE, description="Something else.")])
        (path, message), = self.reasons(results)
        self.assertEqual(path, "$[0].description")
        self.assertIn("another description", message)
        self.assertIn("never edits", message)
        self.assertIn("cannot edit a description", message)
        # A file that leaves the description out says another thing than a metric that has one.
        (path, _), = self.reasons(self.apply([rate(RATE)]))
        self.assertEqual(path, "$[0].name")
        self.assertEqual(self.row(RATE), before)

    def test_a_name_a_measured_metric_holds_is_refused(self):
        (path, message), = self.reasons(self.apply([rate(HELD)]))
        self.assertEqual(path, "$[0].name")
        self.assertIn("measured metric", message)
        self.assertIsNone(self.row(HELD)[5])

    def test_the_name_of_a_deprecated_derived_metric_is_refused_and_says_to_restore_it(self):
        for document in (rate(RETIRED), rate(RETIRED, PHASE_A)):
            with self.subTest(document=document):
                (path, message), = self.reasons(self.apply([document]))
                self.assertEqual(path, "$[0].name")
                self.assertIn("deprecated", message)
                self.assertIn("Restore", message)
        self.assertTrue(self.row(RETIRED)[6])

    def test_every_input_the_site_lacks_is_named_in_one_pass(self):
        results = self.apply([total(f"{T}/Gone", (NOTHING, 1), (PHASE_A, 1), (f"{T}/Missing_Too", -1), description=5)])
        self.assertEqual(results[0]["status"], "refused")
        self.assertEqual(self.reasons(results), [
            ("$[0].description", "`description` is text of at most 4,000 characters."),
            ("$[0].inputs[0].metric", f"{NOTHING} is not in the catalogue. Add it before building a derived metric on it."),
            ("$[0].inputs[2].metric", f"{T}/Missing_Too is not in the catalogue. Add it before building a derived metric on it."),
        ])

    def test_a_derived_input_is_refused_by_name_and_a_deprecated_one_is_accepted(self):
        (path, message), = self.reasons(self.apply([rate(f"{T}/Rate_Of_A_Rate", RATE)]))
        self.assertEqual(path, "$[0].input")
        self.assertEqual(message, f"{RATE} is itself a derived metric. A derived metric cannot be built on another.")
        self.assertEqual(self.apply([rate(f"{T}/Old_Input_Rate", OLD_GAUGE)])[0]["status"], "new")
        # An input that is another metric of the file is a derived metric too, though the catalogue lacks it yet.
        results = self.apply([rate(), rate(f"{T}/Rate_Of_New", f"{T}/New_Rate")])
        self.assertEqual([r["status"] for r in results], ["new", "refused"])
        self.assertEqual(self.reasons(results), [
            ("$[1].input", f"{T}/New_Rate is itself a derived metric. A derived metric cannot be built on another.")])

    def test_one_refusal_writes_nothing_at_all(self):
        before = (self.derived_rows(), self.audit())
        results = self.apply([rate(), share(), rate(f"{T}/Other_Rate", NOTHING)])
        self.assertEqual([r["status"] for r in results], ["new", "new", "refused"])
        self.assertEqual((self.derived_rows(), self.audit()), before)
        self.assertEqual([r["id"] for r in results], [None, None, None])

    def test_it_never_edits_and_never_deletes(self):
        before = self.derived_rows()
        self.apply([rate()])
        after = self.derived_rows()
        self.assertEqual([r for r in after if r[1] != f"{T}/New_Rate"], before, "a file that leaves them out leaves them alone")
        self.apply([rate(), share()])
        self.assertEqual(self.row(RATE)[3:6], (RATE_DESCRIPTION, "COUNT/HOUR", {"kind": "counter_rate", "input": PARTS}))
        self.assertEqual(self.apply([]), [])
        self.assertIsNotNone(self.row(RETIRED), "a deprecated metric the file leaves out stays")

    def test_a_second_upload_of_a_file_changes_nothing(self):
        document = [rate(description="One."), share(), total()]
        self.assertEqual([r["status"] for r in self.apply(document)], ["new"] * 3)
        before = (self.derived_rows(), self.audit())
        again = self.apply(document)
        self.assertEqual([r["status"] for r in again], ["unchanged"] * 3)
        self.assertEqual((self.derived_rows(), self.audit()), before)

    def test_a_document_that_is_not_a_list_or_is_too_long_is_one_refusal(self):
        for document, fragment in (({"name": "x"}, "holds a list"), ([{}] * 1001, "at most 1000")):
            with self.subTest(fragment=fragment):
                results = self.apply(document)
                self.assertEqual([(r["index"], r["name"], r["status"]) for r in results], [(None, None, "refused")])
                (path, message), = self.reasons(results)
                self.assertEqual(path, "$")
                self.assertIn(fragment, message)

    def test_the_keys_of_a_kind_and_no_others(self):
        cases = {
            "$[0].units": rate(units="COUNT/HOUR"),
            "$[0].datatype": rate(datatype=10),
            "$[0].states": rate(states=["ACTIVE"]),
            "$[0].inputs": share(inputs=[{"metric": PHASE_A, "sign": 1}]),
            "$[0].input": total(input=PHASE_A),
        }
        for path, document in cases.items():
            with self.subTest(path=path):
                paths = [p for p, _ in self.reasons(self.apply([document]))]
                self.assertIn(path, paths)
        (path, message), = self.reasons(self.apply([rate(units="COUNT/HOUR")]))
        self.assertIn("worked out from the inputs", message)

    def test_a_state_of_a_boolean_written_as_a_yaml_boolean_is_refused_with_the_fix(self):
        (path, message), = self.reasons(self.apply([share(f"{T}/Open", DOOR, [True])]))
        self.assertEqual(path, "$[0].states[0]")
        self.assertIn('in quotes', message)


class TheTablesOwnWords(DerivedBase):
    """A refusal that only the table's triggers can make is the trigger's sentence, at the line it names."""

    def direct(self, document):
        """The sentence a direct INSERT of this derived metric raises, as the owner."""
        self.cur.execute("SAVEPOINT direct;")
        try:
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, description, derivation)"
                             " VALUES (%s, 10, %s, %s::jsonb);",
                             (document["name"], document.get("description"), json.dumps(
                                 {k: v for k, v in document.items() if k not in ("name", "description")})))
        except psycopg2.Error as e:
            self.cur.execute("ROLLBACK TO SAVEPOINT direct;")
            return e.diag.message_primary
        self.cur.execute("ROLLBACK TO SAVEPOINT direct;")
        return None

    def assertTheTriggersWords(self, document, path):
        (found_path, message), = self.reasons(self.apply([document], dry_run=True))
        self.assertEqual(found_path, path)
        self.assertEqual(message, self.direct(document))
        return message

    def test_the_wrong_datatype_of_an_input(self):
        self.assertTheTriggersWords(rate(input=MODE), "$[0].input")
        self.assertTheTriggersWords(rate(input=DOOR), "$[0].input")
        self.assertTheTriggersWords(share(input=PARTS), "$[0].input")
        self.assertTheTriggersWords(total(f"{T}/Bad_Sum", (PHASE_A, 1), (MODE, 1)), "$[0].inputs[1].metric")

    def test_a_state_the_input_cannot_report(self):
        message = self.assertTheTriggersWords(share(states=["AUTO", "EXPLODING"]), "$[0].states")
        self.assertIn("AUTO, MANUAL, STOPPED", message)
        self.assertTheTriggersWords(share(input=DOOR, states=["open"]), "$[0].states")

    def test_the_inputs_of_a_sum_share_a_unit(self):
        message = self.assertTheTriggersWords(total(f"{T}/Mixed", (PHASE_A, 1), (PHASE_KW, 1)), "$[0].inputs")
        self.assertIn("must share one unit", message)

    def test_a_group_spelled_in_another_case(self):
        message = self.assertTheTriggersWords(rate(f"{T.lower()}/Another_Rate"), "$[0].name")
        self.assertIn("differs only in case", message)

    def test_a_name_a_device_declares(self):
        gateway = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment, is_simulated, is_shadow)"
            " VALUES (%s, %s, 'cell', 'remote', false, false);", (gateway, f"T297_GW_{gateway[:8]}"))
        for n in range(2):
            self.cur.execute(
                "INSERT INTO public.devices (id, name, gateway_id, last_birth_metrics, last_birth_metrics_at)"
                " VALUES (%s, %s, %s, %s, now());", (str(uuid.uuid4()), f"T297_Press_{n}", gateway, [f"{T}/Declared"]))
        message = self.assertTheTriggersWords(rate(f"{T}/Declared"), "$[0].name")
        self.assertIn("the device T297_Press_0 and 1 more declare", message)

    def test_the_words_of_a_missing_and_of_a_derived_input_are_the_triggers(self):
        for document in (rate(input=NOTHING), rate(input=RATE), total(f"{T}/Gone", (PHASE_A, 1), (NOTHING, 1)),
                         total(f"{T}/Layered", (PHASE_A, 1), (RATE, 1))):
            with self.subTest(document=document["name"]):
                (path, message), = self.reasons(self.apply([document], dry_run=True))
                self.assertEqual(message, self.direct(document))

    def test_a_refused_trial_leaves_no_row_and_no_audit_row(self):
        before = (self.derived_rows(), self.audit())
        self.apply([share(states=["EXPLODING"]), rate()], dry_run=True)
        self.apply([share(states=["EXPLODING"]), rate()])
        self.assertEqual((self.derived_rows(), self.audit()), before)


class AuditTrail(DerivedBase):
    def test_one_insert_row_for_each_metric_added_naming_the_person(self):
        before = len(self.audit())
        results = self.apply([rate(), share(), total()])
        rows = self.audit()[before:]
        self.assertEqual([(a, n) for a, _, _, _, n in rows], [("INSERT", f"{T}/New_Rate"), ("INSERT", f"{T}/New_Share"),
                                                             ("INSERT", f"{T}/New_Sum")])
        self.assertEqual([entity for _, entity, _, _, _ in rows], [r["id"] for r in results])
        self.assertEqual({(changed_by, source) for _, _, changed_by, source, _ in rows}, {(ADMIN_ID, "user")})

    def test_a_dry_run_an_unchanged_metric_and_a_refusal_write_none(self):
        before = self.audit()
        self.apply([rate()], dry_run=True)
        self.apply([rate(RATE, description=RATE_DESCRIPTION)])
        self.apply([rate(f"{T}/Gone", NOTHING)])
        self.assertEqual(self.audit(), before)


class RoundTrip(DerivedBase):
    def test_the_document_is_in_name_order_and_leaves_a_deprecated_metric_out(self):
        self.apply([total(f"{T}/A_Sum"), share(f"{T}/B_Share", MODE, ["MANUAL", "AUTO"], description="Time in manual.")])
        document = self.document()
        self.assertEqual([m["name"] for m in document], [f"{T}/A_Sum", f"{T}/B_Share", RATE])
        self.assertEqual(document[1], {"name": f"{T}/B_Share", "description": "Time in manual.", "kind": "time_in_state",
                                       "input": MODE, "states": ["MANUAL", "AUTO"]})
        self.assertEqual(document[0], {"name": f"{T}/A_Sum", "kind": "sum", "inputs": [
            {"metric": PHASE_A, "sign": 1}, {"metric": PHASE_B, "sign": -1}]})
        self.assertEqual(document[2], {"name": RATE, "description": RATE_DESCRIPTION, "kind": "counter_rate", "input": PARTS})
        self.assertNotIn(RETIRED, [m["name"] for m in document])
        for metric in document:
            self.assertFalse({"units", "datatype", "id"} & set(metric))

    def test_the_ids_pick_what_is_exported(self):
        self.apply([rate(), share()])
        ids = [self.row(f"{T}/New_Share")[0], self.row(PARTS)[0], self.row(RETIRED)[0]]
        self.assertEqual([m["name"] for m in self.document(ids)], [f"{T}/New_Share"])
        self.assertEqual(self.document([]), [])

    def test_the_document_applied_again_reports_every_metric_unchanged(self):
        self.apply([rate(description="One."), share(), total()])
        document = self.document()
        before = (self.derived_rows(), self.audit())
        results = self.apply(document)
        self.assertEqual(len(results), 4)
        self.assertEqual({r["status"] for r in results}, {"unchanged"})
        self.assertEqual((self.derived_rows(), self.audit()), before)

    def test_a_document_taken_to_a_site_without_the_metrics_adds_them(self):
        """Another site: the same file, a catalogue that has the inputs and not the derived metrics."""
        self.apply([rate(description="One."), share(), total()])
        document = self.document()
        self.owner()
        self.cur.execute("DELETE FROM public.metric_catalog WHERE name LIKE %s AND derivation IS NOT NULL;", (f"{T}/%",))
        self.assertEqual(self.document(), [])
        results = self.apply(document)
        self.assertEqual({r["status"] for r in results}, {"new"})
        self.assertEqual([m["name"] for m in self.document()], [m["name"] for m in document])


if __name__ == "__main__":
    unittest.main(verbosity=2)

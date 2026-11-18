# suite:
#   lanes: db
#   why: 0306 -- site_vocabularies and site_vocabulary_concepts (every signed-in role reads, nobody writes but
#     the three functions, anon nothing), who may import, remove and share and behind which second factor, the
#     re-checks of every row, the ids an import skips and why, a file imported once, the Audit Trail rows in
#     the asset lane with their classes, the site arm of concept_definitions that shows a shared vocabulary
#     only, a metric's link to its file and its clearing, the id-shape rule, and a replay that changes nothing.

"""
A site can import a vocabulary from AAS ConceptDescriptions (0306).

    python supabase/migrations/test_a_site_can_import_a_vocabulary_from_aas_concept_descriptions.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * Access: every signed-in role reads both tables, anon neither; no role writes either table or calls
    the three functions but an Administrator, and with the second factor required, one whose session
    gave its code.
  * import_site_vocabulary(): it checks every row again (the id's shape and type, the required fields, the
    lengths, the keys), refuses a file whose SHA-256 is held and names the row that holds it, skips each id
    a seeded vocabulary, another file or the file itself already defines and says which, and files one
    SITE_VOCABULARY_IMPORTED row in the asset lane, classed created.
  * remove_site_vocabulary(): the concepts go with the file, a metric started from it keeps its id and
    loses the link, and the row says how many metrics were linked. set_site_vocabulary_sharing() changes
    the answer and files a row; the answer it already has files none.
  * concept_definitions: a shared vocabulary's concepts are there with no standard, an unshared one's
    are not, and a published standard's definition wins over a site's for one id.
  * metric_catalog.site_vocabulary_id: a metric started from a file links to it only with no standard.
  * The classifiers list the three new acts and keep the arms of the files before.
  * A replay of the file changes no object and loses no row.

EVERY TEST ROLLS BACK.
"""
import hashlib
import json
import os
import re
import unittest
from pathlib import Path

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATION = Path(__file__).resolve().parent / "0306_a_site_can_import_a_vocabulary_from_aas_concept_descriptions.sql"

ADMIN_ID = "a0d17306-0000-4000-8000-0000000306a1"
MANAGER_ID = "a0d17306-0000-4000-8000-0000000306a2"
OPERATOR_ID = "a0d17306-0000-4000-8000-0000000306a3"
AUDITOR_ID = "a0d17306-0000-4000-8000-0000000306a4"
MACHINE_ID = "a0d17306-0000-4000-8000-0000000306a5"
NOBODY_ID = "a0d17306-0000-4000-8000-0000000306a6"
PEOPLE = ((ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager"), (OPERATOR_ID, "Operator"),
          (AUDITOR_ID, "Auditor"))
SWITCH = "security.require_mfa_for_managers"

T = "Test_0306"
BASE = "https://example.test/0306/"
ECLASS = "0173-1#02-AAO677#002"
NODE = "nsu=http://opcfoundation.org/UA/Machinery/;i=6003"


def sha(n):
    return hashlib.sha256(f"0306-{n}".encode()).hexdigest()


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class SiteVocabularyBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regclass('public.site_vocabularies') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0306 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;", (user_id, self.email(user_id)))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                         (NOBODY_ID, self.email(NOBODY_ID)))
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, NULL, '', now()) ON CONFLICT (id) DO NOTHING;", (MACHINE_ID,))
        self.cur.execute("INSERT INTO public.principal_permissions (principal_id, permission_id)"
                         " SELECT %s, id FROM public.permissions WHERE name = 'schema:manage';", (MACHINE_ID,))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    @staticmethod
    def email(user_id):
        return f"{user_id[-4:]}@site-vocabularies.test"

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
        """Run `sql` as PostgREST would for a person's token. A refusal rolls back to the savepoint, so
        the test can go on, and is raised. A statement that matches no row returns its row count."""
        self.cur.execute("SAVEPOINT site_vocabulary_call;")
        try:
            self.claims(user_id, aal)
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else self.cur.rowcount
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT site_vocabulary_call;")
            raise
        finally:
            self.owner()
        self.cur.execute("RELEASE SAVEPOINT site_vocabulary_call;")
        return rows

    @staticmethod
    def file(n=1, **over):
        described = {"name": f"{T} file {n}", "source_format": "aas-json", "kind": "site_own", "sha256": sha(n)}
        described.update(over)
        return {k: v for k, v in described.items() if v is not None}

    @staticmethod
    def published(n=1, **over):
        described = SiteVocabularyBase.file(n, kind="published_standard", standard_name="ISO 22400-2",
                                            standard_edition="2014", standard_publisher="ISO")
        described.update(over)
        return {k: v for k, v in described.items() if v is not None}

    @staticmethod
    def concept(n, **over):
        row = {"semantic_id": f"{BASE}Concept{n}", "semantic_id_type": "IRI", "preferred_name": f"Concept {n}",
               "definition": f"What concept {n} is.", "unit": None, "unit_id": None, "data_type": None}
        row.update(over)
        return {k: v for k, v in row.items() if v is not None}

    def do_import(self, file=None, concepts=None, user_id=ADMIN_ID, aal="aal1"):
        file = self.file() if file is None else file
        concepts = [self.concept(1), self.concept(2)] if concepts is None else concepts
        return self.as_person(user_id, "SELECT public.import_site_vocabulary(%s::jsonb, %s::jsonb);",
                              (json.dumps(file), json.dumps(concepts)), aal)[0][0]

    def imported(self, file=None, concepts=None):
        """A vocabulary in place, imported by an Administrator; its id."""
        return self.do_import(file, concepts)["id"]

    def trail(self, vocabulary_id=None):
        self.cur.execute(
            "SELECT action, entity_id::text, changed_by::text, actor_source, audit_domain,"
            "       public.audit_event_class(action, entity_type, audit_domain, old_data, new_data),"
            "       new_data, old_data"
            "  FROM public.audit_trail WHERE entity_type = 'site_vocabularies'"
            "   AND (%s::uuid IS NULL OR entity_id = %s::uuid) ORDER BY id;", (vocabulary_id, vocabulary_id))
        return self.cur.fetchall()

    def concepts_of(self, vocabulary_id):
        self.cur.execute("SELECT semantic_id FROM public.site_vocabulary_concepts WHERE vocabulary_id = %s"
                         " ORDER BY semantic_id;", (vocabulary_id,))
        return [row[0] for row in self.cur.fetchall()]

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, str(caught.exception))
        return caught.exception


class Access(SiteVocabularyBase):
    TABLES = ("site_vocabularies", "site_vocabulary_concepts")
    FUNCTIONS = ("import_site_vocabulary(jsonb, jsonb)", "remove_site_vocabulary(uuid)",
                 "set_site_vocabulary_sharing(uuid, boolean)")

    def test_anon_reads_and_writes_neither_table(self):
        for table in self.TABLES:
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                with self.subTest(table=table, privilege=privilege):
                    self.cur.execute("SELECT has_table_privilege('anon', %s, %s);", (f"public.{table}", privilege))
                    self.assertFalse(self.cur.fetchone()[0])

    def test_a_signed_in_role_reads_and_writes_nothing_else(self):
        for table in self.TABLES:
            self.cur.execute("SELECT has_table_privilege('authenticated', %s, 'SELECT'),"
                             "       has_table_privilege('authenticated', %s, 'INSERT'),"
                             "       has_table_privilege('authenticated', %s, 'UPDATE'),"
                             "       has_table_privilege('authenticated', %s, 'DELETE'),"
                             "       has_table_privilege('authenticated', %s, 'TRUNCATE');", (f"public.{table}",) * 5)
            self.assertEqual(self.cur.fetchone(), (True, False, False, False, False), table)

    def test_the_functions_are_for_a_signed_in_caller_and_the_helper_is_for_them(self):
        for signature in self.FUNCTIONS:
            with self.subTest(function=signature):
                self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'),"
                                 "       has_function_privilege('service_role', %s, 'EXECUTE'),"
                                 "       has_function_privilege('authenticated', %s, 'EXECUTE');",
                                 (f"public.{signature}",) * 3)
                self.assertEqual(self.cur.fetchone(), (False, False, True))
        self.cur.execute("SELECT has_function_privilege('authenticated', 'public.semantic_id_shape(text)', 'EXECUTE'),"
                         "       has_function_privilege('anon', 'public.site_vocabulary_holders(text[])', 'EXECUTE');")
        self.assertEqual(self.cur.fetchone(), (False, False))

    def test_every_signed_in_role_reads_both_tables(self):
        vocabulary = self.imported()
        for user_id in (ADMIN_ID, MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NOBODY_ID, MACHINE_ID):
            with self.subTest(user=user_id):
                self.assertEqual(self.as_person(user_id, "SELECT name FROM public.site_vocabularies WHERE id = %s;",
                                                (vocabulary,)), [(f"{T} file 1",)])
                self.assertEqual(self.as_person(user_id, "SELECT count(*) FROM public.site_vocabulary_concepts"
                                                         " WHERE vocabulary_id = %s;", (vocabulary,)), [(2,)])

    def test_nobody_writes_the_tables_directly_not_even_an_administrator(self):
        vocabulary = self.imported()
        for sql, args in (
            ("INSERT INTO public.site_vocabularies (name, source_format, kind, sha256)"
             " VALUES ('x', 'aas-json', 'site_own', %s);", (sha(99),)),
            ("UPDATE public.site_vocabularies SET definitions_shareable = true WHERE id = %s;", (vocabulary,)),
            ("DELETE FROM public.site_vocabularies WHERE id = %s;", (vocabulary,)),
            ("INSERT INTO public.site_vocabulary_concepts (vocabulary_id, semantic_id, semantic_id_type, preferred_name)"
             " VALUES (%s, 'https://example.test/x', 'IRI', 'x');", (vocabulary,)),
            ("DELETE FROM public.site_vocabulary_concepts WHERE vocabulary_id = %s;", (vocabulary,)),
        ):
            with self.subTest(sql=sql):
                self.assertRefused("42501", self.as_person, ADMIN_ID, sql, args)

    def test_only_an_administrator_imports_removes_and_shares(self):
        vocabulary = self.imported()
        for user_id in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NOBODY_ID, MACHINE_ID):
            with self.subTest(user=user_id):
                self.assertRefused("42501", self.do_import, self.file(7), [self.concept(7)], user_id)
                self.assertRefused("42501", self.as_person, user_id, "SELECT public.remove_site_vocabulary(%s);", (vocabulary,))
                self.assertRefused("42501", self.as_person, user_id,
                                   "SELECT public.set_site_vocabulary_sharing(%s, true);", (vocabulary,))
        self.assertEqual(self.concepts_of(vocabulary), [f"{BASE}Concept1", f"{BASE}Concept2"])
        self.assertEqual(len(self.trail()), 1)

    def test_with_no_person_behind_the_request_it_is_refused(self):
        self.owner()
        self.assertRefused("42501", self.cur.execute, "SELECT public.import_site_vocabulary('{}'::jsonb, '[]'::jsonb);")

    def test_with_the_second_factor_required_an_administrator_needs_a_session_that_gave_its_code(self):
        vocabulary = self.imported()
        self.cur.execute("UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = %s;", (SWITCH,))
        for sql, args in (("SELECT public.set_site_vocabulary_sharing(%s, true);", (vocabulary,)),
                          ("SELECT public.remove_site_vocabulary(%s);", (vocabulary,))):
            error = self.assertRefused("42501", self.as_person, ADMIN_ID, sql, args, "aal1")
            self.assertIn("MFA is required", str(error))
        self.assertRefused("42501", self.do_import, self.file(8), [self.concept(8)], ADMIN_ID, "aal1")
        self.assertEqual(self.do_import(self.file(8), [self.concept(8)], ADMIN_ID, "aal2")["concepts"], 1)
        self.assertEqual(self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, true);",
                                        (vocabulary,), "aal2")[0][0]["definitions_shareable"], True)
        self.assertEqual(self.as_person(ADMIN_ID, "SELECT public.remove_site_vocabulary(%s);",
                                        (vocabulary,), "aal2")[0][0]["concepts"], 2)


class Rechecks(SiteVocabularyBase):
    def refused(self, file=None, concepts=None, code="22023"):
        error = self.assertRefused(code, self.do_import, file, concepts)
        self.cur.execute("SELECT count(*) FROM public.site_vocabularies WHERE name LIKE %s;", (f"{T}%",))
        self.assertEqual(self.cur.fetchone(), (0,), "a refused import leaves no file behind")
        self.assertEqual(self.trail(), [], "a refused import leaves no Audit Trail row")
        return error.diag.message_primary

    def test_a_good_file_is_stored_as_described(self):
        result = self.do_import(self.published(3, version="2.1", licence_note="Single-site licence."),
                                [self.concept(1, unit="%", unit_id="0173-1#05-AAA#001", data_type="REAL_MEASURE")])
        self.assertEqual((result["concepts"], result["skipped"]), (1, []))
        self.cur.execute("SELECT name, source_format, kind, standard_name, standard_edition, standard_publisher,"
                         "       sha256, version, licence_note, definitions_shareable, imported_by::text, imported_at IS NOT NULL"
                         "  FROM public.site_vocabularies WHERE id = %s;", (result["id"],))
        self.assertEqual(self.cur.fetchone(), (f"{T} file 3", "aas-json", "published_standard", "ISO 22400-2", "2014",
                                               "ISO", sha(3), "2.1", "Single-site licence.", False, ADMIN_ID, True))
        self.cur.execute("SELECT semantic_id, semantic_id_type, preferred_name, definition, unit, unit_id, data_type"
                         "  FROM public.site_vocabulary_concepts WHERE vocabulary_id = %s;", (result["id"],))
        self.assertEqual(self.cur.fetchall(), [(f"{BASE}Concept1", "IRI", "Concept 1", "What concept 1 is.", "%",
                                                "0173-1#05-AAA#001", "REAL_MEASURE")])

    def test_the_importer_is_the_caller_and_the_file_cannot_say_otherwise(self):
        self.assertIn("`imported_by`", self.refused(self.file(2, imported_by=MANAGER_ID)))
        result = self.do_import(self.file(2))
        self.cur.execute("SELECT imported_by::text FROM public.site_vocabularies WHERE id = %s;", (result["id"],))
        self.assertEqual(self.cur.fetchone(), (ADMIN_ID,))

    def test_a_file_that_is_not_described_is_refused(self):
        for bad, said in (
            (self.file(1, kind="neither"), "published_standard or site_own"),
            (self.file(1, source_format="csv"), "aasx, aas-json or aas-xml"),
            (self.file(1, sha256="ABC"), "SHA-256"),
            (self.file(1, sha256=sha(1).upper()), "SHA-256"),
            (self.file(1, name=None), "The name is required"),
            (self.file(1, name=" padded "), "space or a line break"),
            (self.file(1, name="N" * 201), "longer than 200"),
            (self.file(1, version=""), "empty"),
            (self.file(1, licence_note="L" * 2001), "longer than 2000"),
            (self.file(1, standard_name="ISO 22400-2"), "names no standard"),
            (self.published(1, standard_edition=None), "edition is required"),
            (self.published(1, standard_publisher=None), "publisher is required"),
            (self.published(1, standard_name=None), "name is required"),
            (self.file(1, bogus="x"), "`bogus`"),
        ):
            with self.subTest(file=bad):
                self.assertIn(said, self.refused(bad))
        self.assertRefused("22023", self.as_person, ADMIN_ID, "SELECT public.import_site_vocabulary('[]'::jsonb, '[]'::jsonb);")

    def test_every_row_is_checked_again(self):
        for bad, said in (
            (self.concept(1, semantic_id="just a word", semantic_id_type="IRI"), "neither an IRI, an IRDI nor an ExpandedNodeId"),
            (self.concept(1, semantic_id_type="IRDI"), "is an IRI, but it is declared as IRDI"),
            (self.concept(1, semantic_id=ECLASS, semantic_id_type="IRI"), "is an IRDI, but it is declared as IRI"),
            (self.concept(1, semantic_id=NODE, semantic_id_type="IRI"), "is an ExpandedNodeId, but it is declared as IRI"),
            (self.concept(1, semantic_id_type="URL"), "URL"),
            (self.concept(1, semantic_id=None), "Its id is required"),
            (self.concept(1, semantic_id=f" {BASE}Padded"), "space or a line break"),
            (self.concept(1, semantic_id=BASE + "x" * 2000), "longer than 2000"),
            (self.concept(1, preferred_name=None), "preferred name is required"),
            (self.concept(1, preferred_name="N" * 256), "longer than 255"),
            (self.concept(1, definition="D" * 1024), "longer than 1023"),
            (self.concept(1, definition=""), "empty"),
            (self.concept(1, unit="U" * 256), "longer than 255"),
            (self.concept(1, unit_id="U" * 2001), "longer than 2000"),
            (self.concept(1, data_type="T" * 101), "longer than 100"),
            (self.concept(1, bogus="x"), "`bogus`"),
            ("not an object", "must be an object"),
        ):
            with self.subTest(row=bad):
                self.assertIn("Concept 1", self.refused(self.file(), [bad]))
                self.assertIn(said, self.refused(self.file(), [bad]))

    def test_the_refusal_names_the_row_and_its_id_and_stops_at_five(self):
        rows = [self.concept(n) for n in range(1, 4)] + [self.concept(n, preferred_name=None) for n in range(4, 12)]
        message = self.refused(self.file(), rows)
        self.assertIn(f"Concept 4 ({BASE}Concept4): Its preferred name is required.", message)
        self.assertEqual(len(message.split("\n")), 5)

    def test_a_list_of_no_concept_or_too_many_is_refused(self):
        self.assertIn("no concept", self.refused(self.file(), []))
        self.assertIn("must be a list", self.refused(self.file(), {"not": "a list"}))
        many = [self.concept(n) for n in range(10001)]
        self.assertIn("at most 10000", self.refused(self.file(), many))

    def test_ten_thousand_concepts_are_taken(self):
        self.assertEqual(self.do_import(self.file(), [self.concept(n) for n in range(10000)])["concepts"], 10000)


class Skips(SiteVocabularyBase):
    def seeded(self):
        self.cur.execute("SELECT semantic_id FROM public.mtconnect_vocabulary WHERE semantic_id IS NOT NULL"
                         " AND description IS NOT NULL ORDER BY semantic_id LIMIT 1;")
        mtconnect = self.cur.fetchone()[0]
        self.cur.execute("SELECT semantic_id FROM public.iso22400_vocabulary ORDER BY semantic_id LIMIT 1;")
        iso = self.cur.fetchone()[0]
        self.cur.execute("SELECT semantic_id FROM public.opcua_vocabulary ORDER BY semantic_id LIMIT 1;")
        opcua = self.cur.fetchone()[0]
        # A field of a seeded vocabulary with no text: concept_definitions leaves it out, and the table holds it.
        self.cur.execute("SELECT semantic_id FROM public.vda5050_vocabulary WHERE description IS NULL ORDER BY name LIMIT 1;")
        undefined = self.cur.fetchone()[0]
        self.cur.execute("SELECT count(*) FROM public.concept_definitions WHERE semantic_id = %s;", (undefined,))
        self.assertEqual(self.cur.fetchone(), (0,))
        return mtconnect, iso, opcua, undefined

    def test_an_id_a_seeded_vocabulary_defines_is_skipped_with_the_vocabulary_named(self):
        mtconnect, iso, opcua, undefined = self.seeded()
        result = self.do_import(self.file(), [self.concept(1), self.concept(2, semantic_id=mtconnect),
                                              self.concept(3, semantic_id=iso), self.concept(4, semantic_id=opcua, semantic_id_type="ExpandedNodeId"),
                                              self.concept(5, semantic_id=undefined)])
        self.assertEqual(result["concepts"], 1)
        self.assertEqual([(s["semantic_id"], s["reason"], s["held_by"]) for s in result["skipped"]], [
            (mtconnect, "already_defined", "MTConnect"), (iso, "already_defined", "ISO 22400"),
            (opcua, "already_defined", "OPC UA"), (undefined, "already_defined", "VDA 5050")])
        self.assertEqual(self.concepts_of(result["id"]), [f"{BASE}Concept1"])

    def test_an_id_another_site_vocabulary_holds_is_skipped_with_its_file_named(self):
        first = self.imported(self.file(1), [self.concept(1), self.concept(2)])
        result = self.do_import(self.file(2), [self.concept(2), self.concept(3)])
        self.assertEqual(result["skipped"], [{"semantic_id": f"{BASE}Concept2", "reason": "already_defined", "held_by": f"{T} file 1"}])
        self.assertEqual(self.concepts_of(first), [f"{BASE}Concept1", f"{BASE}Concept2"])
        self.assertEqual(self.concepts_of(result["id"]), [f"{BASE}Concept3"])

    def test_an_id_stated_twice_in_the_file_is_kept_once_and_the_first_is_the_one(self):
        result = self.do_import(self.file(), [self.concept(1, preferred_name="First"), self.concept(2),
                                              self.concept(1, preferred_name="Second")])
        self.assertEqual(result["skipped"], [{"semantic_id": f"{BASE}Concept1", "reason": "repeated_in_file", "held_by": None}])
        self.cur.execute("SELECT preferred_name FROM public.site_vocabulary_concepts WHERE semantic_id = %s;", (f"{BASE}Concept1",))
        self.assertEqual(self.cur.fetchone(), ("First",))

    def test_a_file_whose_every_concept_is_defined_adds_nothing_and_is_refused(self):
        self.imported(self.file(1), [self.concept(1)])
        self.assertRefused("22023", self.do_import, self.file(2), [self.concept(1)])
        self.cur.execute("SELECT count(*) FROM public.site_vocabularies WHERE name = %s;", (f"{T} file 2",))
        self.assertEqual(self.cur.fetchone(), (0,))

    def test_the_holders_function_answers_what_the_import_asks(self):
        mtconnect, iso, _, undefined = self.seeded()
        self.imported(self.file(1), [self.concept(1)])
        rows = self.as_person(MANAGER_ID, "SELECT semantic_id, held_by FROM public.site_vocabulary_holders(%s) ORDER BY 1;",
                              ([mtconnect, iso, undefined, f"{BASE}Concept1", f"{BASE}Nothing"],))
        self.assertEqual(dict(rows), {mtconnect: "MTConnect", iso: "ISO 22400", undefined: "VDA 5050", f"{BASE}Concept1": f"{T} file 1"})

    def test_a_seeded_definition_wins_over_a_site_concept_that_names_the_same_id(self):
        # Not reachable through an import, which skips the id; reachable when a vocabulary is added after one is imported.
        _, iso, _, _ = self.seeded()
        vocabulary = self.imported(self.file(), [self.concept(1)])
        self.cur.execute("UPDATE public.site_vocabularies SET definitions_shareable = true WHERE id = %s;", (vocabulary,))
        self.cur.execute("UPDATE public.site_vocabulary_concepts SET semantic_id = %s WHERE vocabulary_id = %s;", (iso, vocabulary))
        self.cur.execute("SELECT standard FROM public.concept_definitions WHERE semantic_id = %s;", (iso,))
        self.assertEqual(self.cur.fetchall(), [("ISO 22400",)])


class DuplicateFile(SiteVocabularyBase):
    def test_a_file_already_imported_is_refused_and_names_the_row_that_holds_it(self):
        first = self.imported(self.file(1), [self.concept(1)])
        error = self.assertRefused("23505", self.do_import, self.file(1, name="Another name"), [self.concept(9)])
        self.assertIn(f"{T} file 1", str(error))
        self.assertEqual(error.diag.message_detail, first)
        self.cur.execute("SELECT count(*) FROM public.site_vocabularies WHERE name = 'Another name';")
        self.assertEqual(self.cur.fetchone(), (0,))

    def test_after_it_is_removed_the_same_file_can_be_imported_again(self):
        first = self.imported(self.file(1), [self.concept(1)])
        self.as_person(ADMIN_ID, "SELECT public.remove_site_vocabulary(%s);", (first,))
        again = self.do_import(self.file(1), [self.concept(1)])
        self.assertNotEqual(again["id"], first)
        self.assertEqual(again["concepts"], 1)


class Acts(SiteVocabularyBase):
    def test_an_import_files_one_row_in_the_asset_lane_classed_created(self):
        result = self.do_import(self.published(1, version="2"), [self.concept(1), self.concept(2), self.concept(2)])
        rows = self.trail()
        self.assertEqual(len(rows), 1)
        action, entity, who, source, lane, klass, new, old = rows[0]
        self.assertEqual((action, entity, who, source, lane, klass, old), ("SITE_VOCABULARY_IMPORTED", result["id"], ADMIN_ID,
                                                                           "user", "asset", "created", None))
        self.assertEqual((new["name"], new["kind"], new["standard_name"], new["standard_edition"], new["version"],
                          new["sha256"], new["concepts"], new["skipped"], new["definitions_shareable"],
                          new["imported_by_email"]),
                         (f"{T} file 1", "published_standard", "ISO 22400-2", "2014", "2", sha(1), 2, 1, False, self.email(ADMIN_ID)))

    def test_sharing_changes_the_answer_and_files_a_row_and_the_answer_it_has_files_none(self):
        vocabulary = self.imported()
        self.assertEqual(self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, false);", (vocabulary,))[0][0]
                         ["definitions_shareable"], False)
        self.assertEqual(len(self.trail(vocabulary)), 1)
        result = self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, true);", (vocabulary,))[0][0]
        self.assertEqual((result["id"], result["name"], result["definitions_shareable"]), (vocabulary, f"{T} file 1", True))
        self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, true);", (vocabulary,))
        rows = self.trail(vocabulary)
        self.assertEqual([r[0] for r in rows], ["SITE_VOCABULARY_IMPORTED", "SITE_VOCABULARY_SHARING_CHANGED"])
        self.assertEqual(rows[1][2:6], (ADMIN_ID, "user", "asset", "configuration"))
        self.assertEqual((rows[1][7]["definitions_shareable"], rows[1][6]["definitions_shareable"]), (False, True))
        self.cur.execute("SELECT definitions_shareable FROM public.site_vocabularies WHERE id = %s;", (vocabulary,))
        self.assertEqual(self.cur.fetchone(), (True,))

    def test_sharing_needs_a_yes_or_a_no_and_a_vocabulary(self):
        vocabulary = self.imported()
        self.assertRefused("22023", self.as_person, ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, NULL);", (vocabulary,))
        self.assertRefused("P0002", self.as_person, ADMIN_ID,
                           "SELECT public.set_site_vocabulary_sharing('00000000-0000-4000-8000-000000000000', true);")

    def test_a_removal_takes_the_concepts_and_files_a_lifecycle_row_that_says_what_went(self):
        vocabulary = self.imported()
        result = self.as_person(ADMIN_ID, "SELECT public.remove_site_vocabulary(%s);", (vocabulary,))[0][0]
        self.assertEqual(result, {"id": vocabulary, "name": f"{T} file 1", "concepts": 2, "metrics_linked": 0})
        self.assertEqual(self.concepts_of(vocabulary), [])
        self.cur.execute("SELECT count(*) FROM public.site_vocabularies WHERE id = %s;", (vocabulary,))
        self.assertEqual(self.cur.fetchone(), (0,))
        rows = self.trail(vocabulary)
        self.assertEqual([(r[0], r[5]) for r in rows], [("SITE_VOCABULARY_IMPORTED", "created"), ("SITE_VOCABULARY_REMOVED", "lifecycle")])
        removed = rows[1]
        self.assertEqual((removed[2], removed[3], removed[4], removed[6]), (ADMIN_ID, "user", "asset", None))
        self.assertEqual((removed[7]["name"], removed[7]["concepts"], removed[7]["metrics_linked"]), (f"{T} file 1", 2, 0))
        self.assertRefused("P0002", self.as_person, ADMIN_ID, "SELECT public.remove_site_vocabulary(%s);", (vocabulary,))

    def test_a_refused_act_leaves_no_row(self):
        vocabulary = self.imported()
        self.assertRefused("42501", self.as_person, MANAGER_ID, "SELECT public.remove_site_vocabulary(%s);", (vocabulary,))
        self.assertRefused("22023", self.do_import, self.file(5, kind="x"), [self.concept(5)])
        self.assertEqual(len(self.trail()), 1)


class SiteArm(SiteVocabularyBase):
    def definition(self, semantic_id):
        self.cur.execute("SELECT standard, name, definition FROM public.concept_definitions WHERE semantic_id = %s;", (semantic_id,))
        return self.cur.fetchall()

    def test_a_vocabulary_whose_definitions_are_not_shared_defines_nothing(self):
        vocabulary = self.imported()
        self.assertEqual(self.concepts_of(vocabulary), [f"{BASE}Concept1", f"{BASE}Concept2"])
        self.assertEqual(self.definition(f"{BASE}Concept1"), [])

    def test_once_shared_its_concepts_are_defined_by_the_files_text_with_no_standard(self):
        vocabulary = self.imported()
        self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, true);", (vocabulary,))
        self.assertEqual(self.definition(f"{BASE}Concept1"), [(None, "Concept 1", "What concept 1 is.")])
        self.assertEqual(self.definition(f"{BASE}Concept2"), [(None, "Concept 2", "What concept 2 is.")])

    def test_it_follows_the_confirmation_in_both_directions_and_the_removal(self):
        vocabulary = self.imported()
        self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, true);", (vocabulary,))
        self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, false);", (vocabulary,))
        self.assertEqual(self.definition(f"{BASE}Concept1"), [])
        self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, true);", (vocabulary,))
        self.as_person(ADMIN_ID, "SELECT public.remove_site_vocabulary(%s);", (vocabulary,))
        self.assertEqual(self.definition(f"{BASE}Concept1"), [])

    def test_only_the_shared_file_of_two_is_there(self):
        shared = self.imported(self.file(1), [self.concept(1)])
        self.imported(self.file(2), [self.concept(2)])
        self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, true);", (shared,))
        self.assertEqual(len(self.definition(f"{BASE}Concept1")), 1)
        self.assertEqual(self.definition(f"{BASE}Concept2"), [])

    def test_a_concept_with_no_text_defines_nothing_even_when_shared(self):
        vocabulary = self.imported(self.file(), [self.concept(1, definition=None)])
        self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, true);", (vocabulary,))
        self.assertEqual(self.definition(f"{BASE}Concept1"), [])

    def test_every_role_reads_the_view_as_the_vocabularies_it_shows(self):
        vocabulary = self.imported()
        self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, true);", (vocabulary,))
        for user_id in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, MACHINE_ID):
            with self.subTest(user=user_id):
                self.assertEqual(self.as_person(user_id, "SELECT definition FROM public.concept_definitions WHERE semantic_id = %s;",
                                                (f"{BASE}Concept1",)), [("What concept 1 is.",)])

    def test_the_view_keeps_its_four_columns_and_holds_one_row_for_an_id(self):
        self.cur.execute("SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute"
                         " WHERE attrelid = 'public.concept_definitions'::regclass AND attnum > 0 AND NOT attisdropped;")
        self.assertEqual(self.cur.fetchone()[0], ["semantic_id", "name", "definition", "standard"])
        self.cur.execute("SELECT count(*) FROM (SELECT semantic_id FROM public.concept_definitions"
                         " GROUP BY semantic_id HAVING count(*) > 1) d;")
        self.assertEqual(self.cur.fetchone(), (0,))


class MetricLink(SiteVocabularyBase):
    def metric(self, name, **cols):
        cols = {"name": f"{T}/{name}", "datatype": 10, **cols}
        keys = ", ".join(cols)
        self.cur.execute(f"INSERT INTO public.metric_catalog ({keys}) VALUES ({', '.join(['%s'] * len(cols))}) RETURNING id::text;",
                         tuple(cols.values()))
        return self.cur.fetchone()[0]

    def as_admin_metric(self, name, **cols):
        cols = {"name": f"{T}/{name}", "datatype": 10, **cols}
        keys = ", ".join(cols)
        return self.as_person(ADMIN_ID, f"INSERT INTO public.metric_catalog ({keys}) VALUES ({', '.join(['%s'] * len(cols))}) RETURNING id::text;",
                              tuple(cols.values()))[0][0]

    def link_of(self, metric):
        self.cur.execute("SELECT site_vocabulary_id::text, semantic_id, standard FROM public.metric_catalog WHERE id = %s;", (metric,))
        return self.cur.fetchone()

    def test_a_metric_started_from_a_file_links_to_it_with_no_standard(self):
        vocabulary = self.imported()
        metric = self.as_admin_metric("Oee", semantic_id=f"{BASE}Concept1", semantic_id_type="IRI", site_vocabulary_id=vocabulary)
        self.assertEqual(self.link_of(metric), (vocabulary, f"{BASE}Concept1", None))

    def test_a_link_and_a_standard_together_are_refused(self):
        vocabulary = self.imported()
        self.assertRefused("23514", self.as_admin_metric, "Typed", site_vocabulary_id=vocabulary, standard="ISO 22400")
        metric = self.as_admin_metric("Plain", site_vocabulary_id=vocabulary)
        self.assertRefused("23514", self.as_person, ADMIN_ID, "UPDATE public.metric_catalog SET standard = 'ISO 22400' WHERE id = %s;", (metric,))

    def test_a_link_to_a_file_that_is_not_there_is_refused(self):
        self.assertRefused("23503", self.as_admin_metric, "Orphan", site_vocabulary_id="00000000-0000-4000-8000-000000000000")

    def test_a_metric_with_no_link_is_as_it_was(self):
        metric = self.as_admin_metric("Seeded", standard="ISO 22400")
        self.assertEqual(self.link_of(metric), (None, None, "ISO 22400"))

    def test_removing_the_file_clears_the_link_and_keeps_the_metric_and_its_id(self):
        vocabulary = self.imported()
        linked = [self.as_admin_metric(f"M{n}", semantic_id=f"{BASE}Concept1", semantic_id_type="IRI", site_vocabulary_id=vocabulary)
                  for n in (1, 2)]
        removed = self.as_person(ADMIN_ID, "SELECT public.remove_site_vocabulary(%s);", (vocabulary,))[0][0]
        self.assertEqual(removed["metrics_linked"], 2)
        for metric in linked:
            self.assertEqual(self.link_of(metric), (None, f"{BASE}Concept1", None))
        self.assertEqual(self.trail(vocabulary)[-1][7]["metrics_linked"], 2)

    def test_the_clearing_is_recorded_as_a_change_to_each_metric(self):
        vocabulary = self.imported()
        metric = self.as_admin_metric("Oee", site_vocabulary_id=vocabulary)
        self.as_person(ADMIN_ID, "SELECT public.remove_site_vocabulary(%s);", (vocabulary,))
        self.cur.execute("SELECT old_data ->> 'site_vocabulary_id', new_data ->> 'site_vocabulary_id' FROM public.audit_trail"
                         " WHERE entity_type = 'metric_catalog' AND entity_id = %s AND action = 'UPDATE';", (metric,))
        self.assertEqual(self.cur.fetchall(), [(vocabulary, None)])

    def test_a_signed_in_role_reads_the_link(self):
        vocabulary = self.imported()
        metric = self.as_admin_metric("Oee", site_vocabulary_id=vocabulary)
        self.assertEqual(self.as_person(OPERATOR_ID, "SELECT site_vocabulary_id::text FROM public.metric_catalog WHERE id = %s;", (metric,)),
                         [(vocabulary,)])


class Shape(SiteVocabularyBase):
    VECTORS = (
        ("https://admin-shell.io/idta/x", "IRI"), ("http://example.com", "IRI"), ("urn:uuid:1234", "IRI"), ("URN:iso:std:iso:22400", "IRI"),
        ("HTTPS://EXAMPLE.COM/x", "IRI"),
        ("0173-1#02-AAO677#002", "IRDI"), ("0112/2///61987#ABA951#009", "IRDI"),
        ("0173-1#02-AAO677#002/0173-1#07-AAA123#001", "IRDI"),
        ("nsu=http://opcfoundation.org/UA/Machinery/;i=6003", "ExpandedNodeId"), ("nsu=urn:x;s=Name", "ExpandedNodeId"),
        ("plain", None), ("ns=2;i=5", None), ("", None), ("nsu=;i=1", None), ("ftp://example.com/x", None),
        ("0173-1#02-AAO677", None), ("173-1#02-AAO677#002", None),
    )

    def test_the_rule_is_the_dashboards(self):
        for value, shape in self.VECTORS:
            with self.subTest(value=value):
                self.cur.execute("SELECT public.semantic_id_shape(%s);", (value,))
                self.assertEqual(self.cur.fetchone()[0], shape)
        self.cur.execute("SELECT public.semantic_id_shape(NULL);")
        self.assertIsNone(self.cur.fetchone()[0])


class Classifiers(SiteVocabularyBase):
    def test_the_lane_files_the_new_kind_in_the_asset_lane_and_keeps_every_other_arm(self):
        for kind, action, lane in (
            ("site_vocabularies", "SITE_VOCABULARY_IMPORTED", "asset"), ("metric_semantic_ids", "INSERT", "asset"),
            ("metric_catalog", "UPDATE", "asset"), ("automations", "AUTOMATION_CREATED", "asset"),
            ("telemetry", "TELEMETRY_EXPORTED", "asset"), ("platform_alerts", "ALERT_ACKNOWLEDGED", "asset"),
            ("user_roles", "ROLE_GRANTED", "security"), ("notification_channels", "SIGNING_KEY_ISSUED", "security"),
            ("a_kind_nobody_classified", "INSERT", "security"),
        ):
            with self.subTest(kind=kind):
                self.cur.execute("SELECT public.audit_domain_for(%s, %s);", (kind, action))
                self.assertEqual(self.cur.fetchone()[0], lane)

    def test_each_act_is_in_the_class_the_map_lists_for_it(self):
        self.cur.execute("SELECT action, classes FROM public.audit_trail_action_kinds() WHERE entity_type = 'site_vocabularies' ORDER BY action;")
        self.assertEqual(self.cur.fetchall(), [("SITE_VOCABULARY_IMPORTED", ["created"]), ("SITE_VOCABULARY_REMOVED", ["lifecycle"]),
                                               ("SITE_VOCABULARY_SHARING_CHANGED", ["configuration"])])
        for action, klass in (("SITE_VOCABULARY_IMPORTED", "created"), ("SITE_VOCABULARY_REMOVED", "lifecycle"),
                              ("SITE_VOCABULARY_SHARING_CHANGED", "configuration")):
            with self.subTest(action=action):
                self.cur.execute("SELECT public.audit_event_class(%s, 'site_vocabularies', 'asset', '{}', '{}');", (action,))
                self.assertEqual(self.cur.fetchone()[0], klass)

    def test_the_earlier_arms_are_kept(self):
        for action, kind, klass in (("TELEMETRY_EXPORTED", "telemetry", "read"), ("AUTOMATION_DELETED", "automations", "lifecycle"),
                                    ("AUTOMATION_CHANGED", "automations", "configuration"), ("ALERT_ACKNOWLEDGED", "platform_alerts", "operational"),
                                    ("SERVICE_LOGS_READ", "service_logs", "read"), ("DELETE", "areas", "lifecycle"),
                                    ("INSERT", "areas", "created"), ("CAPTURE_STARTED", "capture_jobs", "created")):
            with self.subTest(action=action):
                self.cur.execute("SELECT public.audit_event_class(%s, %s, 'asset', '{}', '{}');", (action, kind))
                self.assertEqual(self.cur.fetchone()[0], klass)
        for action, kind in (("SIGNING_KEY_ISSUED", "notification_channels"), ("AUTOMATION_CHANGED", "automations"),
                             ("TELEMETRY_EXPORTED", "telemetry"), ("ALERT_ACKNOWLEDGED", "service_principals"),
                             ("BACKUP_TAKEN", "backups"), ("INSERT", "metric_semantic_ids")):
            with self.subTest(map=action):
                self.cur.execute("SELECT count(*) FROM public.audit_trail_action_kinds() WHERE action = %s AND entity_type = %s;", (action, kind))
                self.assertEqual(self.cur.fetchone(), (1,))

    def test_the_class_function_is_still_the_inlinable_one_the_class_indexes_are_built_on(self):
        self.cur.execute("SELECT l.lanname, p.provolatile, p.prosecdef, p.proconfig IS NULL"
                         "  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang"
                         " WHERE p.oid = 'public.audit_event_class(text, text, text, jsonb, jsonb)'::regprocedure;")
        self.assertEqual(self.cur.fetchone(), ("sql", "i", False, True))


class Replay(SiteVocabularyBase):
    OBJECTS = (
        "SELECT 'constraint', c.conname, c.oid FROM pg_constraint c"
        " WHERE c.conrelid IN ('public.site_vocabularies'::regclass, 'public.site_vocabulary_concepts'::regclass)"
        " UNION ALL SELECT 'policy', p.polname, p.oid FROM pg_policy p"
        " WHERE p.polrelid IN ('public.site_vocabularies'::regclass, 'public.site_vocabulary_concepts'::regclass)"
        " UNION ALL SELECT 'index', i.indexname, c.oid FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname"
        " WHERE i.tablename IN ('site_vocabularies', 'site_vocabulary_concepts', 'metric_catalog')"
        "   AND i.indexname LIKE '%site_vocabular%'"
        " UNION ALL SELECT 'constraint', c.conname, c.oid FROM pg_constraint c"
        " WHERE c.conrelid = 'public.metric_catalog'::regclass AND c.conname LIKE '%site_vocabulary%' ORDER BY 1, 2;")

    @staticmethod
    def without_psql_commands(text):
        """The file as plain SQL: psycopg2 cannot run `\\gset`, and the rebuild it gates has nothing to rebuild."""
        start = text.index("SELECT EXISTS (SELECT 1 FROM public.audit_trail\n                WHERE action IN ('SITE_VOCABULARY_IMPORTED'")
        end = text.index("\\endif\n") + len("\\endif\n")
        return text[:start] + text[end:]

    def test_the_migration_replays_to_the_same_objects_and_keeps_every_row(self):
        vocabulary = self.imported(self.published(1), [self.concept(1), self.concept(2)])
        self.as_person(ADMIN_ID, "SELECT public.set_site_vocabulary_sharing(%s, true);", (vocabulary,))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, site_vocabulary_id) VALUES (%s, 10, %s);",
                         (f"{T}/Replayed", vocabulary))
        self.cur.execute("SELECT id::text, name, sha256, definitions_shareable, imported_at, imported_by::text FROM public.site_vocabularies"
                         " WHERE name LIKE %s;", (f"{T}%",))
        files = self.cur.fetchall()
        self.cur.execute("SELECT semantic_id, preferred_name, definition FROM public.site_vocabulary_concepts WHERE vocabulary_id = %s"
                         " ORDER BY 1;", (vocabulary,))
        concepts = self.cur.fetchall()
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'site_vocabularies';")
        trail = self.cur.fetchone()
        self.cur.execute(self.OBJECTS)
        objects = self.cur.fetchall()
        self.assertGreaterEqual(len(objects), 20)

        text = MIGRATION.read_text(encoding="utf-8")
        self.assertNotIn("\r", text)
        self.cur.execute(self.without_psql_commands(text))

        self.cur.execute("SELECT id::text, name, sha256, definitions_shareable, imported_at, imported_by::text FROM public.site_vocabularies"
                         " WHERE name LIKE %s;", (f"{T}%",))
        self.assertEqual(self.cur.fetchall(), files)
        self.cur.execute("SELECT semantic_id, preferred_name, definition FROM public.site_vocabulary_concepts WHERE vocabulary_id = %s"
                         " ORDER BY 1;", (vocabulary,))
        self.assertEqual(self.cur.fetchall(), concepts)
        self.cur.execute("SELECT site_vocabulary_id::text FROM public.metric_catalog WHERE name = %s;", (f"{T}/Replayed",))
        self.assertEqual(self.cur.fetchone(), (vocabulary,))
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'site_vocabularies';")
        self.assertEqual(self.cur.fetchone(), trail, "a replay writes no Audit Trail row")
        self.cur.execute(self.OBJECTS)
        self.assertEqual(self.cur.fetchall(), objects)
        # The site arm is still in the view, and the rules still hold.
        self.cur.execute("SELECT count(*) FROM public.concept_definitions WHERE semantic_id = %s;", (f"{BASE}Concept1",))
        self.assertEqual(self.cur.fetchone(), (1,))
        self.assertRefused("23505", self.do_import, self.published(1), [self.concept(9)])

    def test_the_format_check_is_not_asserted_again_so_a_later_file_can_widen_it(self):
        text = MIGRATION.read_text(encoding="utf-8")
        self.assertEqual(len(re.findall(r"site_vocabularies_source_format_valid", text)), 2,
                         "named once where the table declares it and once in the self-check, which looks for the name alone")
        self.assertNotIn("DROP CONSTRAINT", text)


if __name__ == "__main__":
    unittest.main()

# suite:
#   lanes: db
#   why: 0299 -- metric_semantic_ids (who reads and who writes, the second factor, the limit of ten, a
#     row equal to the metric's own id or for a metric with none refused, a row fixed once saved, who
#     added it and when), the rules on the metric's own id beside it, the Audit Trail rows in the
#     catalogue's lane under the metric's id, the cascade from a deleted metric, the crosswalk view, the
#     classifiers keeping every arm they had, and a replay that changes nothing and keeps every row.

"""
A metric can carry more than one semantic id (0299).

    python supabase/migrations/test_a_metric_can_carry_more_than_one_semantic_id.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * Who reads and who writes: every signed-in role reads metric_semantic_ids and the crosswalk, anon
    neither. Only an Administrator writes (add, change, remove), as the catalogue's policies ask; a
    Shopfloor Manager, an Operator, an Auditor, a person with no role and a machine identity are refused
    or match no row. With security.require_mfa_for_managers on, an Administrator needs a session that
    gave its code. authenticated holds no TRUNCATE.
  * The rules: a row needs a metric with an id of its own, may not equal it, and a metric carries at
    most ten. A type outside the three, an id or a source with a space at its end or too long, and a
    repeated id are refused. Which metric and which id a row is cannot change; its type and source can.
    The database stamps when and by whom, whatever the writer sends.
  * The metric's own id beside them: it cannot be cleared while further ids exist or become one of them,
    and changes freely otherwise.
  * The Audit Trail: an INSERT and a DELETE row for each add and remove, under the metric's id, in the
    asset lane, classed created and lifecycle, naming the person; a deleted metric's rows go with it and
    each is recorded.
  * metric_semantic_id_crosswalk: a primary row for each metric with an id and a supplemental row for
    each further one, with the source; a metric with no id has none.
  * The classifiers: the lane and the map list the new kind and keep the arms of the files before.
  * A replay of the file changes no object and loses no row.

EVERY TEST ROLLS BACK.
"""
import json
import os
import unittest
from pathlib import Path

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATION = Path(__file__).resolve().parent / "0299_a_metric_can_carry_more_than_one_semantic_id.sql"

ADMIN_ID = "a0d17299-0000-4000-8000-0000000299a1"
MANAGER_ID = "a0d17299-0000-4000-8000-0000000299a2"
OPERATOR_ID = "a0d17299-0000-4000-8000-0000000299a3"
AUDITOR_ID = "a0d17299-0000-4000-8000-0000000299a4"
MACHINE_ID = "a0d17299-0000-4000-8000-0000000299a5"
NOBODY_ID = "a0d17299-0000-4000-8000-0000000299a6"
PEOPLE = ((ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager"), (OPERATOR_ID, "Operator"),
          (AUDITOR_ID, "Auditor"))
SWITCH = "security.require_mfa_for_managers"

T = "Test_0299"
TEMPERATURE = f"{T}/Temperature"
PRESSURE = f"{T}/Pressure"
BARE = f"{T}/Local_Extension"
PARTS = f"{T}/Part_Count"
RATE = f"{T}/Parts_Per_Hour"

OWN = "nsu=http://opcfoundation.org/UA/Machinery/;i=6003"
ECLASS = "0112/2///61987#ABA951#009"
CDD = "0112/2///62683#ACE000#001"
TEMPLATE = "https://admin-shell.io/idta/nameplate/3/0/Nameplate/SerialNumber"
QUDT = "http://qudt.org/vocab/quantitykind/Temperature"


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class SupplementalBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regclass('public.metric_semantic_ids') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0299 is not applied to this database")
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

        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, units, semantic_id, semantic_id_type)"
                         " VALUES (%s, 10, 'CELSIUS', %s, 'ExpandedNodeId') RETURNING id::text;", (TEMPERATURE, OWN))
        self.temperature = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, semantic_id, semantic_id_type)"
                         " VALUES (%s, 10, %s, 'IRDI') RETURNING id::text;", (PRESSURE, CDD))
        self.pressure = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, 10) RETURNING id::text;", (BARE,))
        self.bare = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, 10);", (PARTS,))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, 10, %s::jsonb)"
                         " RETURNING id::text;", (RATE, json.dumps({"kind": "counter_rate", "input": PARTS})))
        self.derived = self.cur.fetchone()[0]

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    @staticmethod
    def email(user_id):
        return f"{user_id[-4:]}@supplemental-semantic-ids.test"

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
        self.cur.execute("SAVEPOINT supplemental_call;")
        try:
            self.claims(user_id, aal)
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else self.cur.rowcount
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT supplemental_call;")
            raise
        finally:
            self.owner()
        self.cur.execute("RELEASE SAVEPOINT supplemental_call;")
        return rows

    def add(self, metric_id, semantic_id, semantic_id_type="IRDI", source=None, user_id=ADMIN_ID, aal="aal1"):
        return self.as_person(
            user_id,
            "INSERT INTO public.metric_semantic_ids (metric_id, semantic_id, semantic_id_type, source)"
            " VALUES (%s, %s, %s, %s) RETURNING metric_id::text, semantic_id;",
            (metric_id, semantic_id, semantic_id_type, source), aal)

    def add_as_owner(self, metric_id, semantic_id, semantic_id_type="IRDI", source=None):
        self.cur.execute("SAVEPOINT owner_call;")
        try:
            self.cur.execute(
                "INSERT INTO public.metric_semantic_ids (metric_id, semantic_id, semantic_id_type, source)"
                " VALUES (%s, %s, %s, %s);", (metric_id, semantic_id, semantic_id_type, source))
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT owner_call;")
            raise
        self.cur.execute("RELEASE SAVEPOINT owner_call;")

    def ids_of(self, metric_id):
        self.cur.execute("SELECT semantic_id FROM public.metric_semantic_ids WHERE metric_id = %s"
                         " ORDER BY semantic_id;", (metric_id,))
        return [row[0] for row in self.cur.fetchall()]

    def set_own(self, metric_id, semantic_id, semantic_id_type="IRDI", user_id=ADMIN_ID):
        return self.as_person(user_id, "UPDATE public.metric_catalog SET semantic_id = %s, semantic_id_type = %s"
                              " WHERE id = %s RETURNING id::text;", (semantic_id, semantic_id_type, metric_id))

    def trail(self, metric_id=None, kind="metric_semantic_ids"):
        self.cur.execute(
            "SELECT action, entity_id::text, changed_by::text, actor_source, audit_domain,"
            "       new_data ->> 'semantic_id', old_data ->> 'semantic_id',"
            "       public.audit_event_class(action, entity_type, audit_domain, old_data, new_data)"
            "  FROM public.audit_trail WHERE entity_type = %s AND (%s::uuid IS NULL OR entity_id = %s::uuid)"
            "  ORDER BY id;", (kind, metric_id, metric_id))
        return self.cur.fetchall()

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, str(caught.exception))
        return caught.exception


class Access(SupplementalBase):
    def test_anon_reads_and_writes_neither_table_nor_view(self):
        for relation in ("metric_semantic_ids", "metric_semantic_id_crosswalk"):
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                with self.subTest(relation=relation, privilege=privilege):
                    self.cur.execute("SELECT has_table_privilege('anon', %s, %s);", (f"public.{relation}", privilege))
                    self.assertFalse(self.cur.fetchone()[0])

    def test_a_signed_in_role_may_not_truncate_which_row_security_does_not_govern(self):
        self.cur.execute("SELECT has_table_privilege('authenticated', 'public.metric_semantic_ids', 'TRUNCATE'),"
                         "       has_table_privilege('authenticated', 'public.metric_semantic_ids', 'SELECT');")
        self.assertEqual(self.cur.fetchone(), (False, True))

    def test_the_trigger_functions_are_no_browsers(self):
        for signature in ("enforce_metric_semantic_id()", "enforce_metric_own_semantic_id()"):
            with self.subTest(function=signature):
                self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'),"
                                 "       has_function_privilege('authenticated', %s, 'EXECUTE');",
                                 (f"public.{signature}", f"public.{signature}"))
                self.assertEqual(self.cur.fetchone(), (False, False))

    def test_every_signed_in_role_reads_the_rows_and_the_crosswalk(self):
        self.add_as_owner(self.temperature, ECLASS, "IRDI", "ECLASS 14.0")
        for user_id in (ADMIN_ID, MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NOBODY_ID, MACHINE_ID):
            with self.subTest(user=user_id):
                rows = self.as_person(user_id, "SELECT semantic_id FROM public.metric_semantic_ids WHERE metric_id = %s;",
                                      (self.temperature,))
                self.assertEqual(rows, [(ECLASS,)])
                rows = self.as_person(user_id, "SELECT metric_name FROM public.metric_semantic_id_crosswalk"
                                               " WHERE semantic_id = %s;", (ECLASS,))
                self.assertEqual(rows, [(TEMPERATURE,)])

    def test_only_an_administrator_adds(self):
        for user_id in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NOBODY_ID, MACHINE_ID):
            with self.subTest(user=user_id):
                self.assertRefused("42501", self.add, self.temperature, ECLASS, user_id=user_id)
        self.assertEqual(self.ids_of(self.temperature), [])
        self.assertEqual(self.add(self.temperature, ECLASS), [(self.temperature, ECLASS)])
        self.assertEqual(self.ids_of(self.temperature), [ECLASS])

    def test_only_an_administrator_changes_and_removes(self):
        self.add_as_owner(self.temperature, ECLASS, "IRDI", "ECLASS 14.0")
        for user_id in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID, NOBODY_ID, MACHINE_ID):
            with self.subTest(user=user_id):
                # Row security hides the row from an UPDATE or DELETE rather than raising: no row matches.
                self.assertEqual(self.as_person(user_id, "UPDATE public.metric_semantic_ids SET source = 'Mine'"
                                                         " WHERE metric_id = %s;", (self.temperature,)), 0)
                self.assertEqual(self.as_person(user_id, "DELETE FROM public.metric_semantic_ids WHERE metric_id = %s;",
                                                (self.temperature,)), 0)
        self.cur.execute("SELECT source FROM public.metric_semantic_ids WHERE metric_id = %s;", (self.temperature,))
        self.assertEqual(self.cur.fetchall(), [("ECLASS 14.0",)])
        self.assertEqual(self.as_person(ADMIN_ID, "UPDATE public.metric_semantic_ids SET source = 'ECLASS 15'"
                                                  " WHERE metric_id = %s;", (self.temperature,)), 1)
        self.assertEqual(self.as_person(ADMIN_ID, "DELETE FROM public.metric_semantic_ids WHERE metric_id = %s;",
                                        (self.temperature,)), 1)
        self.assertEqual(self.ids_of(self.temperature), [])

    def test_with_the_second_factor_required_an_administrator_needs_a_session_that_gave_its_code(self):
        self.cur.execute("UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = %s;", (SWITCH,))
        self.add_as_owner(self.temperature, ECLASS)
        error = self.assertRefused("42501", self.add, self.temperature, CDD, aal="aal1")
        self.assertIn("MFA is required", str(error))
        with self.assertRaises(psycopg2.Error) as caught:
            self.as_person(ADMIN_ID, "DELETE FROM public.metric_semantic_ids WHERE metric_id = %s;", (self.temperature,))
        self.assertEqual(caught.exception.pgcode, "42501")
        self.assertEqual(self.add(self.temperature, CDD, aal="aal2"), [(self.temperature, CDD)])
        self.assertEqual(self.as_person(ADMIN_ID, "DELETE FROM public.metric_semantic_ids WHERE metric_id = %s;",
                                        (self.temperature,), aal="aal2"), 2)


class Rules(SupplementalBase):
    def test_a_metric_with_no_id_of_its_own_carries_no_others(self):
        error = self.assertRefused("23514", self.add, self.bare, ECLASS)
        self.assertIn("has no semantic id of its own", str(error))
        self.assertIn(BARE, str(error))
        self.assertEqual(self.ids_of(self.bare), [])

    def test_a_derived_metric_has_no_id_so_it_carries_none(self):
        self.assertRefused("23514", self.add, self.derived, ECLASS)

    def test_an_id_equal_to_the_metrics_own_is_refused(self):
        error = self.assertRefused("23514", self.add, self.temperature, OWN, "ExpandedNodeId")
        self.assertIn("already the semantic id", str(error))
        self.assertEqual(self.ids_of(self.temperature), [])

    def test_the_same_id_may_be_further_to_two_metrics_and_primary_to_a_third(self):
        self.add(self.temperature, ECLASS)
        self.add(self.pressure, ECLASS)
        self.add(self.pressure, OWN, "ExpandedNodeId")
        self.assertEqual(self.ids_of(self.temperature), [ECLASS])
        self.assertEqual(self.ids_of(self.pressure), sorted([ECLASS, OWN]))

    def test_an_id_is_listed_once_for_a_metric(self):
        self.add(self.temperature, ECLASS)
        self.assertRefused("23505", self.add, self.temperature, ECLASS, "IRI")

    def test_a_metric_carries_ten_and_not_an_eleventh(self):
        ids = [f"https://example.org/concept/{n:02d}" for n in range(10)]
        for semantic_id in ids:
            self.add(self.temperature, semantic_id, "IRI")
        error = self.assertRefused("23514", self.add, self.temperature, "https://example.org/concept/10", "IRI")
        self.assertIn("the most a metric may", str(error))
        self.assertEqual(self.ids_of(self.temperature), ids)
        # The limit is the metric's: another metric takes its own, and a removal frees a place.
        self.add(self.pressure, ids[0], "IRI")
        self.assertEqual(self.as_person(ADMIN_ID, "DELETE FROM public.metric_semantic_ids"
                                                  " WHERE metric_id = %s AND semantic_id = %s;",
                                        (self.temperature, ids[0])), 1)
        self.add(self.temperature, "https://example.org/concept/10", "IRI")
        self.assertEqual(len(self.ids_of(self.temperature)), 10)

    def test_the_type_is_one_of_the_three_and_is_required(self):
        for semantic_id_type in ("IRI", "IRDI", "ExpandedNodeId"):
            with self.subTest(type=semantic_id_type):
                self.add(self.temperature, f"{ECLASS}/{semantic_id_type}", semantic_id_type)
        for semantic_id_type in ("ModelReference", "iri", "", None):
            with self.subTest(type=semantic_id_type):
                self.assertRefused("23514" if semantic_id_type is not None else "23502",
                                   self.add, self.temperature, f"{ECLASS}/x", semantic_id_type)

    def test_an_id_and_a_source_have_no_space_at_their_ends_and_are_not_empty_or_too_long(self):
        for semantic_id in (" " + ECLASS, ECLASS + " ", "", "x" * 2001):
            with self.subTest(semantic_id=semantic_id[:12]):
                self.assertRefused("23514", self.add, self.temperature, semantic_id)
        for source in (" ECLASS", "ECLASS ", "", "x" * 501):
            with self.subTest(source=source[:12]):
                self.assertRefused("23514", self.add, self.temperature, ECLASS, "IRDI", source)
        self.add(self.temperature, "x" * 2000, "IRI", "y" * 500)
        self.add(self.temperature, ECLASS, "IRDI", None)

    def test_which_metric_and_which_id_a_row_is_cannot_change_but_its_type_and_source_can(self):
        self.add(self.temperature, ECLASS, "IRDI", "ECLASS 14.0")
        error = self.assertRefused("23514", self.as_person, ADMIN_ID,
                                   "UPDATE public.metric_semantic_ids SET semantic_id = %s WHERE metric_id = %s;",
                                   (CDD, self.temperature))
        self.assertIn("fixed once saved", str(error))
        self.assertRefused("23514", self.as_person, ADMIN_ID,
                           "UPDATE public.metric_semantic_ids SET metric_id = %s WHERE metric_id = %s;",
                           (self.pressure, self.temperature))
        self.assertEqual(self.as_person(ADMIN_ID, "UPDATE public.metric_semantic_ids SET semantic_id_type = 'IRI',"
                                                  " source = 'The template' WHERE metric_id = %s;", (self.temperature,)), 1)
        self.cur.execute("SELECT semantic_id_type, source FROM public.metric_semantic_ids WHERE metric_id = %s;",
                         (self.temperature,))
        self.assertEqual(self.cur.fetchone(), ("IRI", "The template"))

    def test_the_database_stamps_who_added_a_row_and_when_whatever_the_writer_sends(self):
        self.as_person(ADMIN_ID, "INSERT INTO public.metric_semantic_ids (metric_id, semantic_id, semantic_id_type,"
                                 " created_at, created_by) VALUES (%s, %s, 'IRDI', '2001-01-01', %s);",
                       (self.temperature, ECLASS, MANAGER_ID))
        self.cur.execute("SELECT created_by::text, created_at > now() - interval '1 minute'"
                         "  FROM public.metric_semantic_ids WHERE metric_id = %s;", (self.temperature,))
        self.assertEqual(self.cur.fetchone(), (ADMIN_ID, True))
        # An update keeps the first write's stamp.
        self.as_person(ADMIN_ID, "UPDATE public.metric_semantic_ids SET created_by = %s, created_at = '2001-01-01'"
                                 " WHERE metric_id = %s;", (MANAGER_ID, self.temperature))
        self.cur.execute("SELECT created_by::text, created_at > now() - interval '1 minute'"
                         "  FROM public.metric_semantic_ids WHERE metric_id = %s;", (self.temperature,))
        self.assertEqual(self.cur.fetchone(), (ADMIN_ID, True))
        # A write with no session names nobody.
        self.add_as_owner(self.pressure, ECLASS)
        self.cur.execute("SELECT created_by FROM public.metric_semantic_ids WHERE metric_id = %s;", (self.pressure,))
        self.assertEqual(self.cur.fetchone(), (None,))


class OwnId(SupplementalBase):
    def test_a_metrics_own_id_cannot_be_cleared_while_it_carries_others(self):
        self.add(self.temperature, ECLASS)
        for semantic_id_type in ("ExpandedNodeId", None):
            with self.subTest(type=semantic_id_type):
                error = self.assertRefused("23514", self.as_person, ADMIN_ID,
                                           "UPDATE public.metric_catalog SET semantic_id = NULL, semantic_id_type = NULL"
                                           " WHERE id = %s;", (self.temperature,))
                self.assertIn("need an id of its own", str(error))
        self.assertRefused("23514", self.as_person, ADMIN_ID,
                           "UPDATE public.metric_catalog SET semantic_id = '' WHERE id = %s;", (self.temperature,))

    def test_a_further_id_cannot_become_the_metrics_own(self):
        self.add(self.temperature, ECLASS)
        error = self.assertRefused("23514", self.set_own, self.temperature, ECLASS)
        self.assertIn("already one of the further semantic ids", str(error))
        self.cur.execute("SELECT semantic_id FROM public.metric_catalog WHERE id = %s;", (self.temperature,))
        self.assertEqual(self.cur.fetchone(), (OWN,))

    def test_it_changes_to_another_id_and_the_rows_beside_it_stay(self):
        self.add(self.temperature, ECLASS)
        self.assertEqual(self.set_own(self.temperature, QUDT, "IRI"), [(self.temperature,)])
        self.assertEqual(self.ids_of(self.temperature), [ECLASS])

    def test_after_the_rows_are_removed_it_clears_and_takes_the_id_that_was_one_of_them(self):
        self.add(self.temperature, ECLASS)
        self.as_person(ADMIN_ID, "DELETE FROM public.metric_semantic_ids WHERE metric_id = %s;", (self.temperature,))
        self.assertEqual(self.set_own(self.temperature, ECLASS), [(self.temperature,)])
        self.as_person(ADMIN_ID, "UPDATE public.metric_catalog SET semantic_id = NULL, semantic_id_type = NULL"
                                 " WHERE id = %s;", (self.temperature,))

    def test_a_metric_that_carries_none_changes_its_id_as_it_always_did(self):
        self.assertEqual(self.set_own(self.pressure, ECLASS), [(self.pressure,)])
        self.as_person(ADMIN_ID, "UPDATE public.metric_catalog SET semantic_id = NULL, semantic_id_type = NULL"
                                 " WHERE id = %s;", (self.pressure,))

    def test_an_update_that_leaves_the_id_alone_is_not_judged(self):
        self.add(self.temperature, ECLASS)
        self.as_person(ADMIN_ID, "UPDATE public.metric_catalog SET semantic_id = semantic_id, description = 'Heat'"
                                 " WHERE id = %s;", (self.temperature,))


class Audit(SupplementalBase):
    def test_an_add_and_a_remove_are_each_a_row_under_the_metrics_id_in_the_assets_lane(self):
        self.add(self.temperature, ECLASS, "IRDI", "ECLASS 14.0")
        self.as_person(ADMIN_ID, "DELETE FROM public.metric_semantic_ids WHERE metric_id = %s AND semantic_id = %s;",
                       (self.temperature, ECLASS))
        self.assertEqual(self.trail(self.temperature), [
            ("INSERT", self.temperature, ADMIN_ID, "user", "asset", ECLASS, None, "created"),
            ("DELETE", self.temperature, ADMIN_ID, "user", "asset", None, ECLASS, "lifecycle"),
        ])

    def test_a_change_of_type_or_source_is_an_update_row(self):
        self.add(self.temperature, ECLASS)
        self.as_person(ADMIN_ID, "UPDATE public.metric_semantic_ids SET source = 'ECLASS 14.0' WHERE metric_id = %s;",
                       (self.temperature,))
        rows = self.trail(self.temperature)
        self.assertEqual([row[0] for row in rows], ["INSERT", "UPDATE"])
        self.assertEqual(rows[1][1:5], (self.temperature, ADMIN_ID, "user", "asset"))

    def test_a_refused_write_leaves_no_row(self):
        self.assertRefused("23514", self.add, self.bare, ECLASS)
        self.assertRefused("42501", self.add, self.temperature, ECLASS, user_id=MANAGER_ID)
        self.assertEqual(self.trail(), [])

    def test_a_manager_and_an_operator_read_the_rows_as_they_read_the_catalogues(self):
        self.add(self.temperature, ECLASS)
        for user_id in (MANAGER_ID, AUDITOR_ID, ADMIN_ID):
            with self.subTest(user=user_id):
                rows = self.as_person(user_id, "SELECT action FROM public.audit_trail"
                                               " WHERE entity_type = 'metric_semantic_ids' AND entity_id = %s;",
                                      (self.temperature,))
                self.assertEqual(rows, [("INSERT",)])

    def test_a_deleted_metric_takes_its_rows_and_each_is_recorded(self):
        self.add(self.temperature, ECLASS)
        self.add(self.temperature, CDD)
        self.cur.execute("DELETE FROM public.metric_catalog WHERE id = %s;", (self.temperature,))
        self.assertEqual(self.ids_of(self.temperature), [])
        deleted = [row for row in self.trail(self.temperature) if row[0] == "DELETE"]
        self.assertEqual(sorted(row[6] for row in deleted), sorted([ECLASS, CDD]))
        self.assertEqual({row[4] for row in deleted}, {"asset"})

    def test_a_metrics_own_changes_and_its_further_ids_share_one_entity(self):
        self.add(self.temperature, ECLASS)
        self.set_own(self.temperature, QUDT, "IRI")
        self.cur.execute("SELECT entity_type FROM public.audit_trail WHERE entity_id = %s ORDER BY id;", (self.temperature,))
        self.assertEqual([row[0] for row in self.cur.fetchall()], ["metric_catalog", "metric_semantic_ids", "metric_catalog"])


class Crosswalk(SupplementalBase):
    def rows(self, semantic_id):
        self.cur.execute("SELECT metric_name, semantic_id_type, held_as, source, deprecated"
                         "  FROM public.metric_semantic_id_crosswalk WHERE semantic_id = %s ORDER BY metric_name;",
                         (semantic_id,))
        return self.cur.fetchall()

    def test_it_answers_across_both_the_metrics_own_ids_and_the_further_ones(self):
        self.add(self.pressure, OWN, "ExpandedNodeId", "The OPC UA Machinery companion specification")
        self.assertEqual(self.rows(OWN), [
            (PRESSURE, "ExpandedNodeId", "supplemental", "The OPC UA Machinery companion specification", False),
            (TEMPERATURE, "ExpandedNodeId", "primary", None, False),
        ])
        self.assertEqual(self.rows(CDD), [(PRESSURE, "IRDI", "primary", None, False)])

    def test_a_metric_with_no_id_has_no_row_and_a_deprecated_one_says_so(self):
        self.cur.execute("SELECT count(*) FROM public.metric_semantic_id_crosswalk WHERE metric_id IN (%s, %s);",
                         (self.bare, self.derived))
        self.assertEqual(self.cur.fetchone(), (0,))
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE id = %s;", (self.temperature,))
        self.assertEqual(self.rows(OWN), [(TEMPERATURE, "ExpandedNodeId", "primary", None, True)])

    def test_it_runs_as_the_caller_so_a_role_sees_what_the_tables_show_it(self):
        self.add(self.temperature, ECLASS)
        for user_id in (OPERATOR_ID, NOBODY_ID):
            with self.subTest(user=user_id):
                rows = self.as_person(user_id, "SELECT held_as FROM public.metric_semantic_id_crosswalk"
                                               " WHERE semantic_id = %s;", (ECLASS,))
                self.assertEqual(rows, [("supplemental",)])
        self.cur.execute("SELECT reloptions FROM pg_class WHERE oid = 'public.metric_semantic_id_crosswalk'::regclass;")
        self.assertIn("security_invoker=true", self.cur.fetchone()[0])

    def test_the_lookup_by_a_further_id_uses_its_index(self):
        self.cur.execute("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'"
                         " AND indexname = 'idx_metric_semantic_ids_semantic_id';")
        self.assertIn("(semantic_id)", self.cur.fetchone()[0])


class Classifiers(SupplementalBase):
    def test_the_lane_files_the_new_kind_beside_the_catalogue_and_keeps_every_other_arm(self):
        for kind, action, lane in (
            ("metric_semantic_ids", "INSERT", "asset"), ("metric_catalog", "UPDATE", "asset"),
            ("device_submodels", "INSERT", "asset"), ("device_nameplate", "UPDATE", "asset"),
            ("areas", "UPDATE", "asset"), ("schemas", "INSERT", "asset"), ("change_proposals", "PROPOSAL_APPLIED", "asset"),
            ("captures", "CAPTURE_RECORDED", "asset"), ("platform_alerts", "ALERT_ACKNOWLEDGED", "asset"),
            ("automations", "AUTOMATION_CREATED", "asset"), ("telemetry", "TELEMETRY_EXPORTED", "asset"),
            ("user_roles", "ROLE_GRANTED", "security"), ("service_principals", "TOKEN_MINTED", "security"),
            ("system_settings", "UPDATE", "security"), ("notification_channels", "SIGNING_KEY_ISSUED", "security"),
            ("a_kind_nobody_classified", "INSERT", "security"),
        ):
            with self.subTest(kind=kind):
                self.cur.execute("SELECT public.audit_domain_for(%s, %s);", (kind, action))
                self.assertEqual(self.cur.fetchone()[0], lane)

    def test_the_map_lists_the_three_row_acts_of_the_new_kind_and_keeps_every_other_row(self):
        self.cur.execute("SELECT action, classes FROM public.audit_trail_action_kinds()"
                         " WHERE entity_type = 'metric_semantic_ids' ORDER BY action;")
        self.assertEqual(self.cur.fetchall(), [("DELETE", ["lifecycle"]), ("INSERT", ["created"]),
                                               ("UPDATE", ["operational", "configuration", "lifecycle"])])
        self.cur.execute("SELECT action, entity_type, classes FROM public.audit_trail_action_kinds()"
                         " WHERE entity_type = 'metric_catalog' ORDER BY action;")
        self.assertEqual(self.cur.fetchall(), [("DELETE", "metric_catalog", ["lifecycle"]),
                                               ("INSERT", "metric_catalog", ["created"]),
                                               ("UPDATE", "metric_catalog", ["operational", "configuration", "lifecycle"])])
        for action, kind in (("SIGNING_KEY_ISSUED", "notification_channels"), ("AUTOMATION_CHANGED", "automations"),
                             ("TELEMETRY_EXPORTED", "telemetry"), ("SUPPRESSION_WINDOW_ENDED", "gateways"),
                             ("ALERT_ACKNOWLEDGED", "service_principals"), ("CAPTURE_DOWNLOAD_ISSUED", "captures"),
                             ("SERVICE_LOGS_READ", "service_logs"), ("BACKUP_TAKEN", "backups")):
            with self.subTest(action=action):
                self.cur.execute("SELECT count(*) FROM public.audit_trail_action_kinds()"
                                 " WHERE action = %s AND entity_type = %s;", (action, kind))
                self.assertEqual(self.cur.fetchone(), (1,))

    def test_the_class_function_is_still_the_inlinable_one_the_class_indexes_are_built_on(self):
        self.cur.execute("SELECT l.lanname, p.provolatile, p.prosecdef, p.proconfig IS NULL"
                         "  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang"
                         " WHERE p.oid = 'public.audit_event_class(text, text, text, jsonb, jsonb)'::regprocedure;")
        self.assertEqual(self.cur.fetchone(), ("sql", "i", False, True))


class Replay(SupplementalBase):
    OBJECTS = (
        "SELECT 'constraint', c.conname, c.oid FROM pg_constraint c WHERE c.conrelid = 'public.metric_semantic_ids'::regclass"
        " UNION ALL SELECT 'policy', p.polname, p.oid FROM pg_policy p WHERE p.polrelid = 'public.metric_semantic_ids'::regclass"
        " UNION ALL SELECT 'trigger', t.tgname, t.oid FROM pg_trigger t"
        "  WHERE t.tgname IN ('trg_metric_semantic_ids_rules', 'trg_metric_semantic_ids_audit_trail',"
        "                     'trg_metric_catalog_own_semantic_id')"
        " UNION ALL SELECT 'index', i.indexname, c.oid FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname"
        "  WHERE i.tablename = 'metric_semantic_ids' ORDER BY 1, 2;")

    def test_the_migration_replays_to_the_same_objects_and_keeps_every_row(self):
        """db-init replays every file on every boot: the run must neither fail, nor re-create a thing, nor
        lose a row, and what it declares for the Audit Trail must still hold."""
        self.add(self.temperature, ECLASS, "IRDI", "ECLASS 14.0")
        self.add(self.temperature, CDD)
        self.add(self.pressure, OWN, "ExpandedNodeId")
        self.cur.execute("SELECT metric_id::text, semantic_id, semantic_id_type, source, created_at, created_by::text"
                         "  FROM public.metric_semantic_ids ORDER BY metric_id, semantic_id;")
        rows = self.cur.fetchall()
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'metric_semantic_ids';")
        trail = self.cur.fetchone()
        self.cur.execute(self.OBJECTS)
        objects = self.cur.fetchall()
        self.assertGreaterEqual(len(objects), 14)

        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))

        self.cur.execute("SELECT metric_id::text, semantic_id, semantic_id_type, source, created_at, created_by::text"
                         "  FROM public.metric_semantic_ids ORDER BY metric_id, semantic_id;")
        self.assertEqual(self.cur.fetchall(), rows)
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'metric_semantic_ids';")
        self.assertEqual(self.cur.fetchone(), trail, "a replay writes no Audit Trail row")
        self.cur.execute(self.OBJECTS)
        self.assertEqual(self.cur.fetchall(), objects)
        # And the rules still hold afterwards.
        self.assertRefused("23514", self.add, self.temperature, OWN, "ExpandedNodeId")


if __name__ == "__main__":
    unittest.main()

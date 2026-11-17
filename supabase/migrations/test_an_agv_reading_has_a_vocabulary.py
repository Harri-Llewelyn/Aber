# suite:
#   lanes: db
#   why: The VDA 5050 vocabulary (0302): a table of generated rows that anyone signed in reads and
#     nobody writes, a metric group whose first spelling is permanent, and an arm of
#     concept_definitions. A row dropped by the generator, a write policy added by habit or a view
#     that lost an arm breaks nothing at runtime: an AGV metric is still accepted, and an export
#     still defines its concept, by a sentence nobody wrote for it.

"""
`vda5050_vocabulary`, the AGV metric group and the VDA 5050 arm of `concept_definitions`, as 0302
leaves them on a migrated database. Each probe runs in a transaction that is rolled back.

    python supabase/migrations/test_an_agv_reading_has_a_vocabulary.py
"""
import os
import pathlib
import re
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("POSTGRES_PASSWORD", "postgres"))

MIGRATION = next(pathlib.Path(__file__).resolve().parent.glob("0302_*.sql"))
BASE = "https://aber.local/semantics/vda5050/v3.0/State/"

# The 24 readings the issue lists, by path in the state message.
FIELDS = [
    "driving", "paused", "newBaseRequest", "operatingMode", "lastNodeId", "distanceSinceLastNode",
    "velocity.vx", "velocity.vy", "velocity.omega",
    "powerSupply.stateOfCharge", "powerSupply.batteryVoltage", "powerSupply.batteryCurrent",
    "powerSupply.batteryHealth", "powerSupply.charging", "powerSupply.range",
    "safetyState.activeEmergencyStop", "safetyState.fieldViolation",
    "mobileRobotPosition.x", "mobileRobotPosition.y", "mobileRobotPosition.theta",
    "mobileRobotPosition.mapId", "mobileRobotPosition.localized",
    "mobileRobotPosition.localizationScore", "mobileRobotPosition.deviationRange",
]
# What the walk leaves out: the header, the order flow and every list of structures.
LEFT_OUT = ["headerId", "timestamp", "version", "manufacturer", "serialNumber", "orderId",
            "orderUpdateId", "lastNodeSequenceId", "loads", "errors", "actionStates", "nodeStates",
            "edgeStates", "information", "maps", "zoneSets", "plannedPath.trajectory.degree"]
OPERATING_MODES = ["STARTUP", "AUTOMATIC", "SEMIAUTOMATIC", "INTERVENED", "MANUAL", "SERVICE", "TEACH_IN"]


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class Vda5050TestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            connect().close()
        except psycopg2.OperationalError as exc:
            raise unittest.SkipTest(f"cannot reach Supabase Postgres ({exc}); is the stack up?")

    def in_transaction(self, work):
        """Run `work(cur)` on a fresh connection and roll everything back."""
        conn = connect()
        try:
            with conn.cursor() as cur:
                return work(cur)
        finally:
            conn.rollback()
            conn.close()

    def fetch(self, sql, params=None):
        def read(cur):
            cur.execute(sql, params or ())
            return cur.fetchall()
        return self.in_transaction(read)


class TestTheRows(Vda5050TestCase):
    def test_every_reading_the_issue_lists_is_a_row_and_nothing_else(self):
        names = [r[0] for r in self.fetch("SELECT name FROM public.vda5050_vocabulary ORDER BY name")]
        self.assertEqual(names, sorted(FIELDS))
        self.assertEqual(set(names) & set(LEFT_OUT), set())

    def test_an_id_is_minted_under_aber_local_by_the_path(self):
        rows = self.fetch("SELECT name, semantic_id FROM public.vda5050_vocabulary")
        self.assertEqual({name: sid for name, sid in rows}, {name: BASE + name for name in FIELDS})

    def test_the_datatype_follows_the_schemas_type(self):
        types = dict(self.fetch("SELECT name, datatype FROM public.vda5050_vocabulary"))
        self.assertEqual(types["driving"], "Boolean")
        self.assertEqual(types["powerSupply.charging"], "Boolean")
        self.assertEqual(types["powerSupply.stateOfCharge"], "Double")
        self.assertEqual(types["velocity.omega"], "Double")
        self.assertEqual(types["lastNodeId"], "String")
        self.assertEqual(types["mobileRobotPosition.mapId"], "String")
        self.assertEqual(set(types.values()), {"Double", "Boolean", "String"})

    def test_an_enum_is_the_permitted_values_in_the_schemas_order_and_nothing_else_has_any(self):
        values = dict(self.fetch("SELECT name, permitted_values FROM public.vda5050_vocabulary"))
        self.assertEqual(values["operatingMode"], OPERATING_MODES)
        self.assertEqual(values["safetyState.activeEmergencyStop"], ["MANUAL", "REMOTE", "NONE"])
        self.assertEqual([n for n, v in values.items() if v is not None],
                         [n for n in values if n in ("operatingMode", "safetyState.activeEmergencyStop")])

    def test_the_description_is_the_schemas_and_a_field_it_does_not_describe_has_none(self):
        described = dict(self.fetch("SELECT name, description FROM public.vda5050_vocabulary"))
        self.assertTrue(described["driving"].startswith("True: indicates that the mobile robot is driving"))
        self.assertTrue(all("\n" not in text for text in described.values() if text))
        self.assertEqual([n for n, text in described.items() if text is None],
                         ["mobileRobotPosition.theta", "mobileRobotPosition.x", "mobileRobotPosition.y"])

    def test_the_unit_is_the_schemas_own_keyword(self):
        units = {n: u for n, u in self.fetch("SELECT name, unit FROM public.vda5050_vocabulary") if u}
        self.assertEqual(units, {
            "velocity.vx": "m/s", "velocity.vy": "m/s", "velocity.omega": "rad/s",
            "mobileRobotPosition.x": "m", "mobileRobotPosition.y": "m", "mobileRobotPosition.theta": "rad",
            "mobileRobotPosition.deviationRange": "m"})


class TestTheTableIsReferenceData(Vda5050TestCase):
    def test_it_has_row_security_and_one_select_policy_for_authenticated(self):
        self.assertEqual(
            self.fetch("SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.vda5050_vocabulary'::regclass"),
            [(True,)])
        self.assertEqual(
            self.fetch("SELECT policyname, cmd, roles::text FROM pg_policies"
                       " WHERE schemaname = 'public' AND tablename = 'vda5050_vocabulary'"),
            [("vda5050_vocabulary_select_authenticated", "SELECT", "{authenticated}")])

    def test_authenticated_reads_it_and_anon_does_not_and_nobody_writes_it(self):
        grants = self.fetch(
            "SELECT has_table_privilege('authenticated', 'public.vda5050_vocabulary', 'SELECT'),"
            "       has_table_privilege('anon', 'public.vda5050_vocabulary', 'SELECT'),"
            "       has_table_privilege('authenticated', 'public.vda5050_vocabulary', 'INSERT'),"
            "       has_table_privilege('authenticated', 'public.vda5050_vocabulary', 'UPDATE'),"
            "       has_table_privilege('authenticated', 'public.vda5050_vocabulary', 'DELETE'),"
            "       has_table_privilege('service_role', 'public.vda5050_vocabulary', 'SELECT'),"
            "       has_table_privilege('service_role', 'public.vda5050_vocabulary', 'INSERT')")
        self.assertEqual(grants, [(True, False, False, False, False, True, False)])

    def test_a_signed_in_person_reads_every_row_through_the_policy(self):
        def probe(cur):
            cur.execute("SET LOCAL ROLE authenticated")
            cur.execute("SELECT count(*) FROM public.vda5050_vocabulary")
            return cur.fetchone()[0]
        self.assertEqual(self.in_transaction(probe), len(FIELDS))

    def test_a_signed_in_person_cannot_write_a_row(self):
        def probe(cur):
            cur.execute("SET LOCAL ROLE authenticated")
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("INSERT INTO public.vda5050_vocabulary (name, datatype, semantic_id)"
                            " VALUES ('x', 'String', %s)", (BASE + "x",))
        self.in_transaction(probe)

    def test_anon_cannot_read_a_row(self):
        def probe(cur):
            cur.execute("SET LOCAL ROLE anon")
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("SELECT 1 FROM public.vda5050_vocabulary")
        self.in_transaction(probe)

    def test_the_checks_refuse_a_row_that_is_not_what_the_generator_writes(self):
        # (name, datatype, permitted_values, semantic_id)
        bad = {
            "a datatype the form cannot carry": ("x", "Float", None, BASE + "x"),
            "an id the VDA would have issued": ("x", "String", None, "https://www.vda5050.org/x"),
            "an id for another version": ("x", "String", None, "https://aber.local/semantics/vda5050/v2.0/State/x"),
            "an empty enum": ("x", "String", [], BASE + "x"),
            "an enum with a null in it": ("x", "String", ["A", None], BASE + "x"),
            "a field twice": ("driving", "Boolean", None, BASE + "driving"),
        }
        for what, params in bad.items():
            with self.subTest(what=what):
                def probe(cur, params=params):
                    with self.assertRaises((psycopg2.errors.CheckViolation, psycopg2.errors.UniqueViolation)):
                        cur.execute("INSERT INTO public.vda5050_vocabulary (name, datatype, permitted_values, semantic_id)"
                                    " VALUES (%s, %s, %s, %s)", params)
                self.in_transaction(probe)


class TestTheGroup(Vda5050TestCase):
    def test_agv_is_registered_under_vda_5050_and_says_what_the_vda_calls_the_vehicle(self):
        rows = self.fetch("SELECT name, standard, description FROM public.metric_groups WHERE lower(name) = 'agv'")
        self.assertEqual(len(rows), 1)
        name, standard, description = rows[0]
        self.assertEqual((name, standard), ("AGV", "VDA 5050"))
        self.assertIn("VDA 5050 3.0 calls the vehicle a mobile robot", description)

    def test_the_first_spelling_is_permanent(self):
        """enforce_metric_group_spelling() refuses `Agv/...`: the reason the group was registered as AGV."""
        def probe(cur):
            with self.assertRaises(psycopg2.Error) as raised:
                cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES ('Agv/driving', 11)")
            return str(raised.exception)
        self.assertIn("differs only in case from the existing group 'AGV'", self.in_transaction(probe))

    def test_a_metric_named_for_a_field_is_accepted(self):
        def probe(cur):
            cur.execute("INSERT INTO public.metric_catalog (name, datatype, standard, semantic_id, semantic_id_type)"
                        " VALUES ('AGV/powerSupply/stateOfCharge', 10, 'VDA 5050', %s, 'IRI') RETURNING metric_group",
                        (BASE + "powerSupply.stateOfCharge",))
            return cur.fetchone()[0]
        self.assertEqual(self.in_transaction(probe), "AGV")


class TestTheView(Vda5050TestCase):
    def defined(self, cur, semantic_id):
        cur.execute("SELECT name, definition, standard FROM public.concept_definitions WHERE semantic_id = %s",
                    (semantic_id,))
        return cur.fetchall()

    def test_a_field_is_defined_by_the_schemas_text(self):
        def probe(cur):
            cur.execute("SELECT description FROM public.vda5050_vocabulary WHERE name = 'powerSupply.stateOfCharge'")
            text = cur.fetchone()[0]
            return text, self.defined(cur, BASE + "powerSupply.stateOfCharge")
        text, rows = self.in_transaction(probe)
        self.assertEqual(rows, [("powerSupply.stateOfCharge", text, "VDA 5050")])

    def test_a_field_the_schema_does_not_describe_defines_nothing(self):
        self.assertEqual(self.in_transaction(lambda cur: self.defined(cur, BASE + "mobileRobotPosition.x")), [])

    def test_every_described_field_is_in_the_view_with_its_own_text(self):
        self.assertEqual(self.fetch(
            "SELECT v.name FROM public.vda5050_vocabulary v"
            "  LEFT JOIN public.concept_definitions c ON c.semantic_id = v.semantic_id"
            " WHERE NULLIF(btrim(v.description), '') IS NOT NULL"
            "   AND (c.standard IS DISTINCT FROM 'VDA 5050' OR c.definition IS DISTINCT FROM v.description)"), [])

    def test_vda_5050_is_the_last_arm_and_mtconnect_is_still_there(self):
        """An id both an earlier vocabulary and VDA 5050 hold takes the earlier one's text."""
        driving = BASE + "driving"

        def probe(cur):
            cur.execute("INSERT INTO public.mtconnect_vocabulary (kind, name, category, semantic_id, description)"
                        " VALUES ('DATA_ITEM_TYPE', 'FIXTURE_0302', 'EVENT', %s, 'MTConnect text')", (driving,))
            seen = [self.defined(cur, driving)]
            cur.execute("INSERT INTO public.iso22400_vocabulary (name, kpi_id, description, semantic_id)"
                        " VALUES ('FIXTURE_0302', 'F', 'ISO 22400 text', %s)", (driving,))
            seen.append(self.defined(cur, driving))
            cur.execute("SELECT count(*) FROM public.concept_definitions WHERE standard = 'MTConnect'")
            seen.append(cur.fetchone()[0])
            return seen
        mtconnect_over_vda, iso_over_both, mtconnect_rows = self.in_transaction(probe)
        self.assertEqual(mtconnect_over_vda, [("FIXTURE_0302", "MTConnect text", "MTConnect")])
        self.assertEqual(iso_over_both, [("FIXTURE_0302", "ISO 22400 text", "ISO 22400")])
        self.assertGreater(mtconnect_rows, 100)

    def test_each_semantic_id_appears_once_and_the_grants_are_the_views_own(self):
        self.assertEqual(self.fetch("SELECT semantic_id FROM public.concept_definitions"
                                    " GROUP BY semantic_id HAVING count(*) > 1"), [])
        self.assertEqual(
            self.fetch("SELECT has_table_privilege('authenticated', 'public.concept_definitions', 'SELECT'),"
                       "       has_table_privilege('anon', 'public.concept_definitions', 'SELECT'),"
                       "       (SELECT reloptions FROM pg_class WHERE oid = 'public.concept_definitions'::regclass)"),
            [(True, False, ["security_invoker=true"])])


class TestReplay(Vda5050TestCase):
    def test_replaying_the_migration_rewrites_no_row(self):
        """db-init replays the file on every boot. A row whose text is unchanged is not touched."""
        sql = MIGRATION.read_text(encoding="utf-8")

        def probe(cur):
            read = "SELECT name, xmin::text, description FROM public.vda5050_vocabulary ORDER BY name"
            cur.execute(read)
            before = cur.fetchall()
            cur.execute(sql)
            cur.execute(read)
            return before, cur.fetchall()
        before, after = self.in_transaction(probe)
        self.assertEqual(len(before), len(FIELDS))
        self.assertEqual(after, before)

    def test_replay_puts_back_a_row_that_was_changed_or_removed(self):
        sql = MIGRATION.read_text(encoding="utf-8")

        def probe(cur):
            cur.execute("SELECT name, datatype, unit, description, permitted_values, semantic_id"
                        " FROM public.vda5050_vocabulary ORDER BY name")
            before = cur.fetchall()
            cur.execute("UPDATE public.vda5050_vocabulary SET description = 'edited by hand', permitted_values = NULL"
                        " WHERE name = 'operatingMode'")
            cur.execute("DELETE FROM public.vda5050_vocabulary WHERE name = 'driving'")
            cur.execute(sql)
            cur.execute("SELECT name, datatype, unit, description, permitted_values, semantic_id"
                        " FROM public.vda5050_vocabulary ORDER BY name")
            return before, cur.fetchall()
        before, after = self.in_transaction(probe)
        self.assertEqual(after, before)

    def test_replay_does_not_register_the_group_twice_or_disturb_a_sites_own_spelling(self):
        sql = MIGRATION.read_text(encoding="utf-8")

        def probe(cur):
            cur.execute(sql)
            cur.execute("SELECT count(*) FROM public.metric_groups WHERE lower(name) = 'agv'")
            return cur.fetchone()[0]
        self.assertEqual(self.in_transaction(probe), 1)

    def test_the_block_is_the_generators_and_the_group_row_is_outside_it(self):
        text = MIGRATION.read_text(encoding="utf-8")
        block = text[text.index("-- >>> BEGIN GENERATED vda5050_vocabulary"):text.index("-- <<< END GENERATED vda5050_vocabulary")]
        self.assertEqual(len(re.findall(r"^INSERT INTO public\.vda5050_vocabulary ", block, re.M)), len(FIELDS))
        self.assertNotIn("metric_groups", block)


if __name__ == "__main__":
    unittest.main(verbosity=2)

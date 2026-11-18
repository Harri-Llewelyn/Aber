# suite:
#   lanes: db
#   why: Every row of the generated OPC UA blocks reaches opcua_vocabulary, the ProcessValue group
#     takes its new description on an installed database and keeps an Administrator's own, and a replay
#     of 0300 changes nothing. The static check holds the files; only a booted database shows that.

"""
The OPC UA vocabulary seeded in blocks (0002's and 0300's): what db-init leaves in the database.

    python supabase/migrations/test_the_opc_ua_vocabulary_is_seeded_in_blocks.py

`scripts/check-opcua-seed-sync.mjs` holds the generated blocks to their digests and to the rules for a
row. This suite reads the same blocks out of the migration files and holds the database to them: every
row of both is in `opcua_vocabulary` as written, the table's comment names the seven specifications,
and the metric groups 0300 registers or rewords are as it says.

The replay probes run inside a transaction that is rolled back. They run the whole of 0300 again, as
db-init does on every boot, over a database it has already migrated.
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

MIGRATIONS = pathlib.Path(__file__).resolve().parent
SEED = MIGRATIONS / "0002_seed_data.sql"
BLOCK_0300 = next(MIGRATIONS.glob("0300_*.sql"))

PROCESS_VALUE_ID = "57898b0a-5b8f-47da-95e9-bf40b382eba4"
PROCESS_VALUES = "OPC 40001-2 Machinery Process Values"
SPECIFICATIONS = [
    "OPC 30050 PackML", "OPC 40001 Machinery", PROCESS_VALUES, "OPC 40001-4 Machinery Energy",
    "OPC 40010 Robotics", "OPC 40501 Machine Tools", "OPC 40540 Additive Manufacturing",
]
# What 0002 registered the group with, and what 0300 says it is now.
FIRST_DESCRIPTION = "OPC UA Additive Manufacturing (OPC 40540) in-process sensor readings"
NEW_GROUPS = ["Laser", "EDMGenerator", "Stacklight"]

QUOTED = r"'((?:[^']|'')*)'"
ROW = re.compile(
    rf"^INSERT INTO public\.opcua_vocabulary VALUES \({QUOTED}, {QUOTED}, {QUOTED}, {QUOTED}, {QUOTED}, "
    rf"(?:{QUOTED}|NULL), {QUOTED}\)$",
    re.MULTILINE)


def unquote(text):
    return None if text is None else text.replace("''", "'")


def seeded_rows(path):
    """(companion_spec, name) -> (node_id, description, datatype, unit, semantic_id), as a file writes them."""
    text = path.read_text(encoding="utf-8")
    begin = text.index("-- >>> BEGIN GENERATED opcua_vocabulary_rows")
    end = text.index("-- <<< END GENERATED opcua_vocabulary_rows")
    rows = {}
    for m in ROW.finditer(text[begin:end]):
        name, spec, node_id, description, datatype, unit, semantic_id = (unquote(g) for g in m.groups())
        rows[(spec, name)] = (node_id, description, datatype, unit, semantic_id)
    return rows


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = True
    return conn


class OpcUaBlockTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.conn = connect()
        except psycopg2.OperationalError as exc:
            raise unittest.SkipTest(f"cannot reach Supabase Postgres ({exc}); is the stack up?")

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def fetch(self, sql, params=None):
        with self.conn.cursor() as cur:
            cur.execute(sql, params or ())
            return cur.fetchall()

    def in_transaction(self, work):
        """Run `work(cur)` on a fresh connection and roll everything back."""
        conn = connect()
        conn.autocommit = False
        try:
            with conn.cursor() as cur:
                return work(cur)
        finally:
            conn.rollback()
            conn.close()


class TestTheRowsReachTheTable(OpcUaBlockTestCase):
    def test_every_row_of_both_blocks_is_in_the_table_as_written(self):
        expected = {**seeded_rows(SEED), **seeded_rows(BLOCK_0300)}
        self.assertTrue(seeded_rows(BLOCK_0300), "0300's block holds no rows")
        stored = {
            (spec, name): (node_id, description, datatype, unit, semantic_id)
            for name, spec, node_id, description, datatype, unit, semantic_id in self.fetch(
                "SELECT name, companion_spec, node_id, description, datatype, unit, semantic_id"
                "  FROM public.opcua_vocabulary")
        }
        missing = sorted(set(expected) - set(stored))
        different = sorted(key for key in expected if key in stored and stored[key] != expected[key])
        self.assertEqual(missing, [], "rows a block writes that the table lacks")
        self.assertEqual(different, [], "rows the table holds otherwise than a block writes them")

    def test_the_seventh_specification_is_there_under_its_own_namespace(self):
        rows = self.fetch(
            "SELECT name, node_id, semantic_id, datatype FROM public.opcua_vocabulary"
            " WHERE companion_spec = %s ORDER BY name", (PROCESS_VALUES,))
        names = {name for name, *_ in rows}
        for name in ("AnalogSignal", "ProcessValueSetpoint", "Status", "PercentageValue",
                     "HighHighLimit", "HighLimit", "LowLimit", "LowLowLimit"):
            self.assertIn(name, names)
        for name, node_id, semantic_id, _ in rows:
            with self.subTest(name=name):
                self.assertTrue(node_id.startswith("nsu=http://opcfoundation.org/UA/Machinery/ProcessValues/;i="))
                self.assertEqual(node_id, semantic_id)

    def test_the_table_comment_names_every_specification_the_blocks_seed(self):
        (comment,) = self.fetch("SELECT obj_description('public.opcua_vocabulary'::regclass, 'pg_class')")[0]
        for spec in SPECIFICATIONS:
            with self.subTest(spec=spec):
                self.assertIn(spec, comment)


class TestTheGroups(OpcUaBlockTestCase):
    def test_the_new_groups_are_registered_under_opc_ua(self):
        rows = self.fetch("SELECT name, standard FROM public.metric_groups WHERE name = ANY(%s) ORDER BY name",
                          (NEW_GROUPS,))
        self.assertEqual(rows, [(name, "OPC UA") for name in sorted(NEW_GROUPS)])

    def test_process_value_describes_both_specifications(self):
        ((name, description, standard),) = self.fetch(
            "SELECT name, description, standard FROM public.metric_groups WHERE id = %s", (PROCESS_VALUE_ID,))
        self.assertEqual((name, standard), ("ProcessValue", "OPC UA"))
        self.assertIn("OPC 40001-2", description)
        self.assertIn("OPC 40540", description)

    def test_every_group_the_new_rows_are_filed_under_is_registered(self):
        groups = {name for (name,) in self.fetch("SELECT name FROM public.metric_groups WHERE standard = 'OPC UA'")}
        self.assertTrue({"Laser", "EDMGenerator", "Stacklight", "ProcessValue", "Machine"} <= groups)


class TestReplayingTheBlock(OpcUaBlockTestCase):
    """db-init replays 0300 on every boot, over a database that already holds everything it writes."""

    @staticmethod
    def replay(cur):
        cur.execute(BLOCK_0300.read_text(encoding="utf-8"))

    @staticmethod
    def snapshot(cur):
        cur.execute("SELECT * FROM public.opcua_vocabulary ORDER BY companion_spec, name")
        rows = cur.fetchall()
        cur.execute("SELECT * FROM public.metric_groups ORDER BY name")
        return rows, cur.fetchall()

    def test_a_second_application_changes_nothing(self):
        def probe(cur):
            before = self.snapshot(cur)
            self.replay(cur)
            return before, self.snapshot(cur)
        before, after = self.in_transaction(probe)
        self.assertEqual(after, before)

    def test_an_installed_database_takes_the_new_description_and_keeps_an_administrators(self):
        def description(cur):
            cur.execute("SELECT description FROM public.metric_groups WHERE id = %s", (PROCESS_VALUE_ID,))
            return cur.fetchone()[0]

        def probe(cur):
            current = description(cur)
            # A database upgraded from a release that registered the group with the first text.
            cur.execute("UPDATE public.metric_groups SET description = %s WHERE id = %s",
                        (FIRST_DESCRIPTION, PROCESS_VALUE_ID))
            self.replay(cur)
            upgraded = description(cur)
            # An Administrator rewrote it since; 0300 runs again and leaves it alone.
            cur.execute("UPDATE public.metric_groups SET description = %s WHERE id = %s",
                        ("Our own words for process values", PROCESS_VALUE_ID))
            self.replay(cur)
            return current, upgraded, description(cur)

        current, upgraded, kept = self.in_transaction(probe)
        self.assertEqual(upgraded, current, "the UPDATE did not bring the old text to the new one")
        self.assertNotEqual(upgraded, FIRST_DESCRIPTION)
        self.assertEqual(kept, "Our own words for process values")

    def test_a_fresh_database_registers_the_first_text_before_0300_rewords_it(self):
        """0002's block still says what the group was registered with; 0300's UPDATE is what changes it."""
        text = SEED.read_text(encoding="utf-8")
        self.assertIn("'ProcessValue', '" + FIRST_DESCRIPTION + "'", text)
        self.assertIn(f"WHERE id = '{PROCESS_VALUE_ID}' AND description = '{FIRST_DESCRIPTION}'",
                      BLOCK_0300.read_text(encoding="utf-8"))

    def test_the_block_registers_a_group_an_administrator_already_made_in_other_case(self):
        """uq_metric_groups_name_ci would refuse the INSERT; ON CONFLICT DO NOTHING leaves their spelling."""
        def probe(cur):
            cur.execute("DELETE FROM public.metric_groups WHERE name = 'Laser'")
            cur.execute("INSERT INTO public.metric_groups (name, description, standard)"
                        " VALUES ('laser', 'made by hand', 'Custom')")
            self.replay(cur)
            cur.execute("SELECT name, description FROM public.metric_groups WHERE lower(name) = 'laser'")
            return cur.fetchall()
        self.assertEqual(self.in_transaction(probe), [("laser", "made by hand")])


if __name__ == "__main__":
    unittest.main()

"""
The example metrics: `supabase/example-metrics.sql`, the starter catalog db-init applies only with
dbInit.exampleMetrics on, applied here to a migrated database inside a transaction that is rolled
back.

    python supabase/migrations/test_metric_catalog_seed.py

WHAT IS ACTUALLY AT RISK HERE. `metric_catalog.name` is UNIQUE and IMMUTABLE, and the `standard`
and `semantic_id` a row is created with flow into the AAS export and the i3X metric types. A row
registered with the wrong semantic id does not fail anywhere -- it asserts an interoperability
that does not exist, in an artefact handed to a customer, until something notices.

So the assertions below are about PROVENANCE as much as presence: every example row must carry a
semantic id that is still resolvable in the vocabulary table it came from. A vocabulary re-key or a
renamed concept would otherwise leave the file inserting nothing for that concept. The suite also
holds each group to one standard, every name to the metric-name format, the immutability trigger to
freezing name and datatype while semantic_id and permitted_values stay correctable, and a second
application of the file to changing nothing, an operator's later edit included.

That no migration seeds a metric is check 12 of scripts/check-docs-drift.mjs: this lane's database
is shared by every suite, so a count here would read their fixtures.
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

EXAMPLE_FILE = pathlib.Path(__file__).resolve().parents[1] / "example-metrics.sql"

# One top-level segment per standard. The whole point of the taxonomy is that this mapping is a
# function -- a group belonging to two standards is the collision the naming plan exists to stop.
GROUP_STANDARD = {
    "Axes": "MTConnect",
    "Controller": "MTConnect",
    "Systems": "MTConnect",
    "MotionDevice": "OPC UA",
    "Machine": "OPC UA",
    "Energy": "OPC UA",
    "BMS": "ASHRAE 223P",
    "OEE": "ISO 22400",
}

# Every name the file inserts, by the vocabulary its semantic id is SELECTed from, so a missing row
# is named.
EXAMPLES = {
    "mtconnect_vocabulary": [
        "Systems/TEMPERATURE", "Systems/AVAILABILITY",
        "Axes/DISPLACEMENT", "Axes/C/ANGLE",
        "Axes/X/POSITION", "Axes/Y/POSITION", "Axes/Z/POSITION",
        "Axes/S/ROTARY_VELOCITY", "Axes/S/LOAD",
        "Controller/EXECUTION", "Controller/EMERGENCY_STOP", "Controller/FIRMWARE",
        "Controller/PATH_FEEDRATE", "Controller/CONTROLLER_MODE",
        "Controller/PROGRAM", "Controller/PART_COUNT",
        "SERIAL_NUMBER",
    ],
    "opcua_vocabulary": [
        "MotionDevice/ActualPosition", "MotionDevice/ActualSpeed",
        "MotionDevice/EmergencyStop", "MotionDevice/ProtectiveStop",
        "MotionDevice/OnPath", "MotionDevice/TaskProgramName", "MotionDevice/OverridePercent",
        "Machine/OperationalMode", "Machine/SpeedOverride", "Machine/OperatingMode",
        "Energy/Pressure", "Energy/Temperature",
        "Energy/VolumeFlowRate", "Energy/Volume",
    ],
    "ashrae223_vocabulary": [
        "BMS/ZONE_TEMPERATURE", "BMS/ZONE_HUMIDITY",
        "BMS/CO2_CONCENTRATION", "BMS/STATIC_PRESSURE", "BMS/SUPPLY_AIR_FLOW",
    ],
    "iso22400_vocabulary": [
        "OEE/AVAILABILITY", "OEE/EFFECTIVENESS", "OEE/QUALITY",
        "OEE/OEE", "OEE/UTILIZATION", "OEE/SCRAP_RATIO", "OEE/MTBF", "OEE/MTTR",
    ],
}
ALL_EXAMPLES = [name for names in EXAMPLES.values() for name in names]

# What the dev database's history put in 0002's seed and the example set leaves out: a rename
# replayed as a deprecated row, and two local test entries with no standard behind them.
NOT_EXAMPLES = ["OEE/PERFORMANCE", "safety_interlock", "max_temp_threshold"]

ROW_COLUMNS = ("id, name, datatype, description, deprecated, superseded_by, created_at, category, "
               "units, sub_type, standard, semantic_id, semantic_id_type, permitted_values")


def connect():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = True
    return conn


class ExampleTestCase(unittest.TestCase):
    """Each test applies the file on a fresh connection, as db-init's psql does, and rolls back."""

    @classmethod
    def setUpClass(cls):
        try:
            cls.conn = connect()
        except psycopg2.OperationalError as exc:
            raise unittest.SkipTest(f"cannot reach Supabase Postgres ({exc}); is the stack up?")
        cls.sql = EXAMPLE_FILE.read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "conn", None):
            cls.conn.close()

    def applied(self, work, before=None):
        """
        Apply the file, run `work(cur)` in the same transaction, and roll everything back. With
        `before`, its result on the database as found is passed to `work` as a second argument.
        """
        conn = connect()
        conn.autocommit = False
        try:
            with conn.cursor() as cur:
                prior = before(cur) if before else None
                cur.execute(self.sql)
                return work(cur, prior) if before else work(cur)
        finally:
            conn.rollback()
            conn.close()

    @staticmethod
    def fetch(cur, sql, params=None):
        cur.execute(sql, params or ())
        return cur.fetchall()


class TestTheExampleSet(ExampleTestCase):

    def test_every_example_is_registered(self):
        found = {r[0] for r in self.applied(lambda cur: self.fetch(
            cur, "SELECT name FROM public.metric_catalog WHERE name = ANY(%s)", (ALL_EXAMPLES,)))}
        self.assertEqual(set(ALL_EXAMPLES) - found, set(), "the file did not register every example")

    def test_the_file_names_no_deprecated_or_local_row(self):
        """
        The example set is standard metrics only. Asserted on the file, because a database
        seeded by an earlier 0002 still holds these rows and keeps them.
        """
        for name in NOT_EXAMPLES:
            with self.subTest(name=name):
                self.assertNotIn(f"'{name}'", self.sql)

    def test_no_example_is_deprecated(self):
        deprecated = self.applied(lambda cur: self.fetch(
            cur, "SELECT name FROM public.metric_catalog WHERE name = ANY(%s) AND deprecated",
            (ALL_EXAMPLES,)))
        self.assertEqual(deprecated, [])

    def test_permitted_values_arrive_with_the_row(self):
        values = dict(self.applied(lambda cur: self.fetch(
            cur, "SELECT name, permitted_values FROM public.metric_catalog WHERE name = ANY(%s)",
            (["Controller/EXECUTION", "Controller/EMERGENCY_STOP"],))))
        self.assertEqual(values, {
            "Controller/EXECUTION": ["READY", "ACTIVE", "INTERRUPTED", "FEED_HOLD", "STOPPED"],
            "Controller/EMERGENCY_STOP": ["ARMED", "TRIGGERED"],
        })

    def test_each_insert_is_audited_as_migration(self):
        """
        db-init applies the file as the owner with no JWT, which log_audit_trail_event() files as
        `migration`, as it does 0002's seed. One INSERT receipt per row the file added.
        """
        def registered(cur):
            return self.fetch(cur, "SELECT count(*) FROM public.metric_catalog WHERE name = ANY(%s)",
                              (ALL_EXAMPLES,))[0][0]

        def receipts(cur, prior):
            rows = self.fetch(
                cur, "SELECT actor_source, count(*) FROM public.audit_trail"
                     " WHERE entity_type = 'metric_catalog' AND action = 'INSERT'"
                     "   AND causation_id = txid_current() GROUP BY actor_source")
            return registered(cur) - prior, dict(rows)

        added, by_source = self.applied(receipts, before=registered)
        self.assertEqual(by_source, {"migration": added} if added else {})


class TestReplayingChangesNothing(ExampleTestCase):
    """db-init applies the file on every boot, so a second application must be a no-op."""

    def snapshot(self, cur):
        rows = self.fetch(cur, f"SELECT {ROW_COLUMNS} FROM public.metric_catalog"
                               " WHERE name = ANY(%s) ORDER BY name", (ALL_EXAMPLES,))
        receipts = self.fetch(cur, "SELECT count(*) FROM public.audit_trail"
                                   " WHERE entity_type = 'metric_catalog'")[0][0]
        return rows, receipts

    def test_a_second_application_writes_nothing(self):
        def twice(cur):
            first = self.snapshot(cur)
            cur.execute(self.sql)
            return first, self.snapshot(cur)

        first, second = self.applied(twice)
        self.assertEqual(second[0], first[0], "a replay changed an example row")
        self.assertEqual(second[1], first[1], "a replay wrote an audit receipt")

    def test_an_operators_edit_survives_a_replay(self):
        def edited(cur):
            cur.execute("UPDATE public.metric_catalog SET deprecated = true, units = 'KELVIN'"
                        " WHERE name = 'Systems/TEMPERATURE'")
            cur.execute(self.sql)
            return self.fetch(cur, "SELECT deprecated, units FROM public.metric_catalog"
                                   " WHERE name = 'Systems/TEMPERATURE'")

        self.assertEqual(self.applied(edited), [(True, "KELVIN")])


class TestGroupsAndNames(ExampleTestCase):

    def test_every_example_group_is_present(self):
        groups = {r[0] for r in self.applied(lambda cur: self.fetch(
            cur, "SELECT DISTINCT metric_group FROM public.metric_catalog WHERE name = ANY(%s)",
            (ALL_EXAMPLES,)))}
        self.assertEqual(set(GROUP_STANDARD) - groups, set())

    def test_each_group_maps_to_exactly_one_standard(self):
        """
        The collision the taxonomy exists to prevent. Two standards sharing a top-level segment
        means a name could be claimed by either, and whichever lands first owns it permanently.
        """
        def standards(cur):
            return {group: {r[0] for r in self.fetch(
                cur, "SELECT DISTINCT standard FROM public.metric_catalog"
                     " WHERE metric_group = %s AND standard IS NOT NULL", (group,))}
                for group in GROUP_STANDARD}

        found = self.applied(standards)
        for group, standard in GROUP_STANDARD.items():
            with self.subTest(group=group):
                self.assertEqual(found[group], {standard})

    def test_every_metric_group_is_registered_under_its_metrics_standard(self):
        """
        The other direction: one standard spread over two groups. 223P's metrics once sat under an
        unregistered `BMS` while the form filed under `Building` (#456), and the picker showed the
        one under Local and the other under ASHRAE 223P with nothing in it.
        """
        strays = self.applied(lambda cur: self.fetch(
            cur, "SELECT DISTINCT c.metric_group, c.standard, g.standard FROM public.metric_catalog c"
                 "  LEFT JOIN public.metric_groups g ON g.name = c.metric_group"
                 " WHERE c.standard IS NOT NULL AND c.metric_group IS NOT NULL"
                 "   AND g.standard IS DISTINCT FROM c.standard"))
        self.assertEqual(strays, [], "(group, metrics' standard, group's registered standard)")

    def test_ashrae_223p_registers_one_group(self):
        with self.conn.cursor() as cur:
            groups = [r[0] for r in self.fetch(
                cur, "SELECT name FROM public.metric_groups WHERE standard = 'ASHRAE 223P' ORDER BY name")]
        self.assertEqual(groups, ["BMS"])

    def test_no_example_is_missing_its_standard_or_semantic_id(self):
        bad = self.applied(lambda cur: self.fetch(
            cur, "SELECT name FROM public.metric_catalog"
                 " WHERE name = ANY(%s) AND (standard IS NULL OR semantic_id IS NULL"
                 "                          OR semantic_id_type IS NULL)", (ALL_EXAMPLES,)))
        self.assertEqual(bad, [], "example rows without provenance")

    def test_every_name_satisfies_the_factory_plus_format(self):
        """
        `metric_catalog_name_format` enforces this on write. Checked directly rather than trusted,
        because these names are permanent. `BMS/CO2_CONCENTRATION` is 223P's `Constituent-CO2`,
        transliterated because a name cannot carry the hyphen.
        """
        pattern = r"^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$"
        self.assertEqual([n for n in ALL_EXAMPLES if not re.match(pattern, n)], [])
        self.assertIn("BMS/CO2_CONCENTRATION", ALL_EXAMPLES)


class TestWhatStaysCorrectable(ExampleTestCase):
    """
    name and datatype are a wire contract a device is configured against, so the immutability
    trigger freezes them. semantic_id and permitted_values are transcriptions about a standard, and
    must stay correctable in place (docs/vocabularies.md, PackML). Each probe is rolled back.
    """

    ROW = "Controller/EXECUTION"
    CORRECTABLE = (
        "UPDATE public.metric_catalog SET semantic_id = semantic_id || '-corrected' WHERE name = %s",
        "UPDATE public.metric_catalog SET permitted_values = ARRAY['CORRECTED'] WHERE name = %s",
    )
    FROZEN = (
        "UPDATE public.metric_catalog SET name = name || '_RENAMED' WHERE name = %s",
        "UPDATE public.metric_catalog SET datatype = CASE WHEN datatype = 10 THEN 12 ELSE 10 END WHERE name = %s",
    )

    def probe(self, statement):
        def run(cur):
            cur.execute("SAVEPOINT probe")
            try:
                cur.execute(statement, (self.ROW,))
                return cur.rowcount, None
            except psycopg2.Error as exc:
                return 0, exc
            finally:
                cur.execute("ROLLBACK TO SAVEPOINT probe")
        return self.applied(run)

    def test_semantic_id_and_permitted_values_can_be_corrected(self):
        for statement in self.CORRECTABLE:
            with self.subTest(statement=statement):
                rows, error = self.probe(statement)
                self.assertIsNone(error, f"refused: {error}")
                self.assertEqual(rows, 1, f"{self.ROW} is not registered")

    def test_name_and_datatype_are_frozen(self):
        for statement in self.FROZEN:
            with self.subTest(statement=statement):
                _, error = self.probe(statement)
                self.assertIsNotNone(error, "accepted")
                self.assertIn("immutable", str(error))


class TestReferenceTypesAreIriAndIrdi(unittest.TestCase):
    """
    `schemas.semantic_id_type` and `metric_catalog.semantic_id_type` admit IRI and IRDI only: the
    exporter emits every id as an ExternalReference, which a ModelReference is not. Each probe runs
    in its own transaction and is rolled back.
    """

    CONSTRAINTS = (("schemas", "schemas_semantic_id_type_valid"),
                   ("metric_catalog", "metric_catalog_semantic_id_type_valid"))
    INSERTS = {
        "schemas": "INSERT INTO public.schemas (schema_name, schema_definition, semantic_id, semantic_id_type)"
                   " VALUES ('Fixture0012_Schema', '{\"type\": \"object\"}'::jsonb, 'urn:example:fixture', %s)",
        "metric_catalog": "INSERT INTO public.metric_catalog (name, datatype, semantic_id, semantic_id_type)"
                          " VALUES ('Fixture0012/Value', 9, 'urn:example:fixture', %s)",
    }

    @classmethod
    def setUpClass(cls):
        try:
            connect().close()
        except psycopg2.OperationalError as exc:
            raise unittest.SkipTest(f"cannot reach Supabase Postgres ({exc}); is the stack up?")

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

    def test_both_checks_refuse_model_reference(self):
        for table, constraint in self.CONSTRAINTS:
            with self.subTest(table=table):
                def probe(cur, table=table):
                    cur.execute("SAVEPOINT probe")
                    with self.assertRaises(psycopg2.errors.CheckViolation) as refused:
                        cur.execute(self.INSERTS[table], ("ModelReference",))
                    cur.execute("ROLLBACK TO SAVEPOINT probe")
                    # The same row with a type still allowed goes in, so the refusal was the type.
                    for allowed in ("IRI", "IRDI"):
                        cur.execute("SAVEPOINT probe")
                        cur.execute(self.INSERTS[table], (allowed,))
                        cur.execute("ROLLBACK TO SAVEPOINT probe")
                    return refused.exception
                self.assertIn(constraint, str(self.in_transaction(probe)))


class TestProvenanceResolves(ExampleTestCase):
    """
    Every semantic id the file writes must still be findable in the vocabulary it was SELECTed from.

    This is what catches a vocabulary re-key. The file's inner join would then insert nothing for
    that concept, and a catalog registered earlier keeps a row that no longer corresponds to
    anything -- the first visible symptom would be an AAS shell exported to a customer carrying a
    dangling reference.
    """

    def assert_resolves(self, vocabulary):
        names = EXAMPLES[vocabulary]

        def unresolved(cur):
            found = {r[0] for r in self.fetch(
                cur, "SELECT name FROM public.metric_catalog WHERE name = ANY(%s)", (names,))}
            missing = self.fetch(
                cur, "SELECT c.name FROM public.metric_catalog c WHERE c.name = ANY(%s)"
                     "   AND NOT EXISTS (SELECT 1 FROM public." + vocabulary + " v"
                     "                    WHERE v.semantic_id = c.semantic_id)", (names,))
            return set(names) - found, [r[0] for r in missing]

        absent, dangling = self.applied(unresolved)
        self.assertEqual(absent, set(), f"not inserted: the join found no {vocabulary} concept")
        self.assertEqual(dangling, [], f"ids not resolvable in {vocabulary}")

    def test_mtconnect_rows_resolve(self):
        self.assert_resolves("mtconnect_vocabulary")

    def test_opcua_rows_resolve(self):
        self.assert_resolves("opcua_vocabulary")

    def test_ashrae_rows_resolve(self):
        self.assert_resolves("ashrae223_vocabulary")

    def test_iso22400_rows_resolve(self):
        self.assert_resolves("iso22400_vocabulary")

    def test_every_mtconnect_row_carries_its_data_item_types_id(self):
        """
        Every MTConnect metric with an id carries its data item type's vocabulary id. The type is
        the last name segment once a trailing `sub_type` is removed. An id built from the whole
        name (`…/mtconnect/v2.0/Axes/C/ANGLE`) names one data item, not a concept, and fails here
        (#457).
        """
        wrong = self.applied(lambda cur: self.fetch(
            cur, "SELECT c.name, c.semantic_id FROM public.metric_catalog c "
                 "  LEFT JOIN public.mtconnect_vocabulary v "
                 "    ON v.kind = 'DATA_ITEM_TYPE' AND v.semantic_id = c.semantic_id "
                 " WHERE c.standard = 'MTConnect' AND c.semantic_id IS NOT NULL "
                 "   AND v.name IS DISTINCT FROM regexp_replace("
                 "         CASE WHEN NULLIF(c.sub_type, '') IS NOT NULL "
                 "               AND right(c.name, length(c.sub_type) + 1) = '/' || c.sub_type "
                 "              THEN left(c.name, length(c.name) - length(c.sub_type) - 1) "
                 "              ELSE c.name END, '^.*/', '') "
                 " ORDER BY c.name"))
        self.assertEqual(wrong, [], "(name, semantic_id) not its data item type's vocabulary id")

    def test_the_mtconnect_sweep_has_rows_to_check(self):
        """The sweep above passes on an empty catalog, so its subject is counted."""
        count = self.applied(lambda cur: self.fetch(
            cur, "SELECT count(*) FROM public.metric_catalog WHERE standard = 'MTConnect'"))[0][0]
        self.assertGreaterEqual(count, len(EXAMPLES["mtconnect_vocabulary"]))

    def test_opcua_ids_come_from_the_right_companion_spec(self):
        """
        `opcua_vocabulary` is keyed (companion_spec, name) and several names -- `Mass`,
        `Temperature` -- appear under more than one specification. A join that forgot the spec
        would resolve to a real id from the wrong document, which is indistinguishable from a
        correct one by every other test here.
        """
        cases = (("MotionDevice/ActualPosition", "OPC 40010 Robotics"),
                 ("Energy/Temperature", "OPC 40001-4 Machinery Energy"),
                 ("Machine/OperatingMode", "OPC 40001 Machinery"))

        def matched(cur):
            return {name: self.fetch(
                cur, "SELECT count(*) FROM public.metric_catalog c"
                     "  JOIN public.opcua_vocabulary v ON v.semantic_id = c.semantic_id"
                     " WHERE c.name = %s AND v.companion_spec = %s", (name, spec))[0][0]
                for name, spec in cases}

        found = self.applied(matched)
        for name, spec in cases:
            with self.subTest(name=name):
                self.assertEqual(found[name], 1, f"{name} does not resolve within {spec}")


if __name__ == "__main__":
    unittest.main(verbosity=2)

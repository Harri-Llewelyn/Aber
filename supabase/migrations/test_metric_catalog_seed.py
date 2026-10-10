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
renamed concept would otherwise leave the file inserting nothing for that concept. The five 223P
readings are the exception: they carry QUDT quantity kinds, which no table here holds, so they are
held to the exact ids instead, and 0172's repoint of the 223P classes they once carried is tested
on the same rows. The suite also
holds each group to one standard, every name to the metric-name format, the immutability trigger to
freezing name and datatype while semantic_id and permitted_values stay correctable, and a second
application of the file to changing nothing, an operator's later edit included.

That no migration seeds a metric is check 12 of scripts/check-docs-drift.mjs: this lane's database
is shared by every suite, so a count here would read their fixtures.

TestConceptDefinitions holds `concept_definitions` (0169), the vocabularies' own text the AAS
exporter defines a concept by, to its precedence and its grants.

TestOpcUaConceptsCarryTheirExpandedNodeId holds the OPC UA ids to the ExpandedNodeId form and 0171's
move onto them, replayed.
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
    "iso22400_vocabulary": [
        "OEE/AVAILABILITY", "OEE/EFFECTIVENESS", "OEE/QUALITY",
        "OEE/OEE", "OEE/UTILIZATION", "OEE/SCRAP_RATIO", "OEE/MTBF", "OEE/MTTR",
    ],
}
# The 223P readings: the QUDT quantity kind each reports, typed in the file because QUDT is not seeded
# (docs/vocabularies.md), and the 223P class each carried until 0172 repointed it.
QUANTITY_KIND = "http://qudt.org/vocab/quantitykind/"
S223 = "http://data.ashrae.org/standard223#"
BMS_READINGS = {
    "BMS/ZONE_TEMPERATURE": (QUANTITY_KIND + "Temperature", S223 + "TemperatureSensor"),
    "BMS/ZONE_HUMIDITY": (QUANTITY_KIND + "RelativeHumidity", S223 + "HumiditySensor"),
    "BMS/CO2_CONCENTRATION": (QUANTITY_KIND + "MoleFraction", S223 + "Constituent-CO2"),
    "BMS/STATIC_PRESSURE": (QUANTITY_KIND + "Pressure", S223 + "PressureSensor"),
    "BMS/SUPPLY_AIR_FLOW": (QUANTITY_KIND + "VolumeFlowRate", S223 + "FlowSensor"),
}
REPOINT_FILE = pathlib.Path(__file__).resolve().parent / "0172_a_223p_reading_carries_its_quantity_kind.sql"

ALL_EXAMPLES = [name for names in EXAMPLES.values() for name in names] + list(BMS_READINGS)

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


class TestReferenceTypesAreIriIrdiAndExpandedNodeId(unittest.TestCase):
    """
    `schemas.semantic_id_type` and `metric_catalog.semantic_id_type` admit IRI, IRDI and
    ExpandedNodeId only: the exporter emits every id as an ExternalReference, which a ModelReference
    is not. Each probe runs in its own transaction and is rolled back.
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
                    for allowed in ("IRI", "IRDI", "ExpandedNodeId"):
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

    def test_iso22400_rows_resolve(self):
        self.assert_resolves("iso22400_vocabulary")

    def test_the_223p_readings_carry_their_qudt_quantity_kinds(self):
        """223P is a reference here: a reading carries the kind of quantity it is, not a 223P class."""
        rows = self.applied(lambda cur: self.fetch(
            cur, "SELECT name, semantic_id, semantic_id_type, standard FROM public.metric_catalog"
                 " WHERE name = ANY(%s) ORDER BY name", (list(BMS_READINGS),)))
        self.assertEqual(rows, sorted((name, kind, "IRI", "ASHRAE 223P")
                                      for name, (kind, _) in BMS_READINGS.items()))

    def test_no_example_carries_a_223p_class(self):
        held = self.applied(lambda cur: self.fetch(
            cur, "SELECT c.name FROM public.metric_catalog c"
                 "  JOIN public.ashrae223_vocabulary v ON v.semantic_id = c.semantic_id"
                 " WHERE c.name = ANY(%s)", (ALL_EXAMPLES,)))
        self.assertEqual(held, [])

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



class TestTheReadingsMoveToTheirQuantityKinds(ExampleTestCase):
    """
    0172 on a database seeded before 223P became a reference: the five readings hold the 223P class
    the seed gave them. Each probe puts them back on those ids, replays 0172 and rolls back.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.repoint = REPOINT_FILE.read_text(encoding="utf-8")

    def seeded_with_classes(self, cur):
        """The five rows as 1.0.1's seed left them, whether or not this database has them yet."""
        for name, (_, sensor_class) in BMS_READINGS.items():
            cur.execute(
                "INSERT INTO public.metric_catalog (name, datatype, standard, semantic_id, semantic_id_type)"
                " VALUES (%s, 10, 'ASHRAE 223P', %s, 'IRI')"
                " ON CONFLICT (name) DO UPDATE SET semantic_id = EXCLUDED.semantic_id,"
                "                                  semantic_id_type = 'IRI'", (name, sensor_class))

    def ids(self, cur, names):
        return dict(self.fetch(cur, "SELECT name, semantic_id FROM public.metric_catalog"
                                    " WHERE name = ANY(%s)", (list(names),)))

    def in_transaction(self, work):
        conn = connect()
        conn.autocommit = False
        try:
            with conn.cursor() as cur:
                return work(cur)
        finally:
            conn.rollback()
            conn.close()

    def test_each_reading_moves_to_its_quantity_kind(self):
        def probe(cur):
            self.seeded_with_classes(cur)
            cur.execute(self.repoint)
            return self.ids(cur, BMS_READINGS)
        self.assertEqual(self.in_transaction(probe),
                         {name: kind for name, (kind, _) in BMS_READINGS.items()})

    def test_an_id_an_operator_changed_is_left_alone(self):
        def probe(cur):
            self.seeded_with_classes(cur)
            cur.execute("UPDATE public.metric_catalog SET semantic_id = 'urn:example:zone-air'"
                        " WHERE name = 'BMS/ZONE_TEMPERATURE'")
            # The right class on the wrong reading is an operator's choice too.
            cur.execute("UPDATE public.metric_catalog SET semantic_id = %s WHERE name = 'BMS/ZONE_HUMIDITY'",
                        (S223 + "TemperatureSensor",))
            cur.execute(self.repoint)
            return self.ids(cur, ["BMS/ZONE_TEMPERATURE", "BMS/ZONE_HUMIDITY", "BMS/STATIC_PRESSURE"])
        self.assertEqual(self.in_transaction(probe), {
            "BMS/ZONE_TEMPERATURE": "urn:example:zone-air",
            "BMS/ZONE_HUMIDITY": S223 + "TemperatureSensor",
            "BMS/STATIC_PRESSURE": BMS_READINGS["BMS/STATIC_PRESSURE"][0],
        })

    def test_a_metric_of_another_name_keeps_its_223p_class(self):
        """One the Vocabulary page's Use made before 223P became a reference: not the seed's to move."""
        def probe(cur):
            cur.execute("INSERT INTO public.metric_catalog (name, datatype, standard, semantic_id, semantic_id_type)"
                        " VALUES ('BMS/Fixture0172/TemperatureSensor', 10, 'ASHRAE 223P', %s, 'IRI')",
                        (S223 + "TemperatureSensor",))
            cur.execute(self.repoint)
            return self.ids(cur, ["BMS/Fixture0172/TemperatureSensor"])
        self.assertEqual(self.in_transaction(probe),
                         {"BMS/Fixture0172/TemperatureSensor": S223 + "TemperatureSensor"})

    def test_a_second_boot_changes_nothing(self):
        """db-init replays 0172, then the example set, on every boot."""
        def probe(cur):
            self.seeded_with_classes(cur)
            cur.execute(self.repoint)
            cur.execute(self.sql)

            def snapshot():
                rows = self.fetch(cur, f"SELECT {ROW_COLUMNS} FROM public.metric_catalog"
                                       " WHERE name = ANY(%s) ORDER BY name", (list(BMS_READINGS),))
                receipts = self.fetch(cur, "SELECT count(*) FROM public.audit_trail"
                                           " WHERE entity_type = 'metric_catalog'")[0][0]
                return rows, receipts
            first = snapshot()
            cur.execute(self.repoint)
            cur.execute(self.sql)
            return first, snapshot()
        first, second = self.in_transaction(probe)
        self.assertEqual(second, first)
        self.assertEqual({r[1]: r[11] for r in first[0]},
                         {name: kind for name, (kind, _) in BMS_READINGS.items()})


class TestConceptDefinitions(unittest.TestCase):
    """
    `concept_definitions` (0169): one row per semantic id a vocabulary defines, with that
    vocabulary's own text. Each probe runs in its own transaction and is rolled back.
    """

    SENSOR = "http://data.ashrae.org/standard223#TemperatureSensor"
    # Every vocabulary with a description column, and the spelling the view gives its standard.
    DESCRIBED = (("idta_submodel_templates", "IDTA"), ("ashrae223_vocabulary", "ASHRAE 223P"),
                 ("opcua_vocabulary", "OPC UA"), ("iso22400_vocabulary", "ISO 22400"))

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

    @staticmethod
    def fetch(cur, sql, params=None):
        cur.execute(sql, params or ())
        return cur.fetchall()

    def defined(self, cur, semantic_id):
        return self.fetch(cur, "SELECT definition, standard FROM public.concept_definitions"
                               " WHERE semantic_id = %s", (semantic_id,))

    def test_the_223p_temperature_sensor_is_defined_by_223p(self):
        rows = self.in_transaction(lambda cur: self.defined(cur, self.SENSOR))
        self.assertEqual(len(rows), 1)
        self.assertIn("represents a measure of temperature", rows[0][0])
        self.assertEqual(rows[0][1], "ASHRAE 223P")

    def test_every_described_row_is_in_the_view_with_its_own_text(self):
        # No two vocabularies share an id today. A seed that starts to fails here, and the
        # precedence below decides which text the export carries.
        for table, standard in self.DESCRIBED:
            with self.subTest(table=table):
                missing = self.in_transaction(lambda cur, table=table, standard=standard: self.fetch(
                    cur, f"SELECT v.semantic_id FROM public.{table} v"
                         "  LEFT JOIN public.concept_definitions c ON c.semantic_id = v.semantic_id"
                         " WHERE NULLIF(btrim(v.description), '') IS NOT NULL"
                         "   AND (c.definition IS DISTINCT FROM v.description"
                         "        OR c.standard IS DISTINCT FROM %s)", (standard,)))
                self.assertEqual(missing, [])

    def test_mtconnect_contributes_nothing_until_it_stores_definitions(self):
        shared = self.in_transaction(lambda cur: self.fetch(
            cur, "SELECT c.semantic_id FROM public.concept_definitions c"
                 "  JOIN public.mtconnect_vocabulary v ON v.semantic_id = c.semantic_id"))
        self.assertEqual(shared, [])

    def test_each_semantic_id_appears_once(self):
        twice = self.in_transaction(lambda cur: self.fetch(
            cur, "SELECT semantic_id FROM public.concept_definitions"
                 " GROUP BY semantic_id HAVING count(*) > 1"))
        self.assertEqual(twice, [])

    def test_an_id_two_vocabularies_hold_takes_the_first_in_precedence(self):
        """IDTA, then ASHRAE 223P, then OPC UA, then ISO 22400."""
        local = "urn:example:fixture-0169"

        def probe(cur):
            for semantic_id in (self.SENSOR, local):
                cur.execute("INSERT INTO public.iso22400_vocabulary (name, kpi_id, description, semantic_id)"
                            " VALUES (%s, 'F', 'ISO 22400 text', %s)",
                            ("FIXTURE_0169_" + str(len(semantic_id)), semantic_id))
                cur.execute("INSERT INTO public.opcua_vocabulary (name, companion_spec, description, semantic_id)"
                            " VALUES (%s, 'OPC 0169 Fixture', 'OPC UA text', %s)",
                            ("Fixture0169_" + str(len(semantic_id)), semantic_id))
            seen = [self.defined(cur, local), self.defined(cur, self.SENSOR)[0][1]]
            cur.execute("INSERT INTO public.idta_submodel_templates (template_id, template_name,"
                        " template_version, id_short, semantic_id, semantic_id_type, description, ordinal)"
                        " VALUES ('urn:example:fixture-0169', 'Fixture', '1.0', 'Fixture0169', %s, 'IRI',"
                        " 'IDTA text', 1)", (self.SENSOR,))
            seen.append(self.defined(cur, self.SENSOR))
            return seen
        opc_over_iso, ashrae_over_both, idta_over_all = self.in_transaction(probe)
        self.assertEqual(opc_over_iso, [("OPC UA text", "OPC UA")])
        self.assertEqual(ashrae_over_both, "ASHRAE 223P")
        self.assertEqual(idta_over_all, [("IDTA text", "IDTA")])

    def test_a_row_without_text_defines_nothing(self):
        def probe(cur):
            cur.execute("INSERT INTO public.iso22400_vocabulary (name, kpi_id, description, semantic_id)"
                        " VALUES ('FIXTURE_0169', 'F', '   ', 'urn:example:fixture-0169')")
            return self.defined(cur, "urn:example:fixture-0169")
        self.assertEqual(self.in_transaction(probe), [])

    def test_authenticated_reads_it_and_anon_does_not(self):
        grants = self.in_transaction(lambda cur: self.fetch(
            cur, "SELECT has_table_privilege('authenticated', 'public.concept_definitions', 'SELECT'),"
                 "       has_table_privilege('anon', 'public.concept_definitions', 'SELECT'),"
                 "       has_table_privilege('authenticated', 'public.concept_definitions', 'INSERT')"))
        self.assertEqual(grants, [(True, False, False)])

    def test_it_applies_the_callers_policies(self):
        options = self.in_transaction(lambda cur: self.fetch(
            cur, "SELECT reloptions FROM pg_class WHERE oid = 'public.concept_definitions'::regclass"))
        self.assertIn("security_invoker=true", options[0][0] or [])


class TestOpcUaConceptsCarryTheirExpandedNodeId(unittest.TestCase):
    """
    Every `opcua_vocabulary` row names its node by the ExpandedNodeId its NodeSet publishes, as
    node_id and semantic_id both (0002). 0171 moves a metric or a schema still carrying a former id,
    `<namespace URI><name>`, and removes a row 0002 no longer writes; replayed, it moves nothing.
    0001's guarded CHECKs replay over a row typed ExpandedNodeId without narrowing it. Each probe
    runs in its own transaction and is rolled back.
    """

    MIGRATIONS = pathlib.Path(__file__).resolve().parent
    MACHINERY = "http://opcfoundation.org/UA/Machinery/"
    ROBOTICS = "http://opcfoundation.org/UA/Robotics/"

    @classmethod
    def setUpClass(cls):
        try:
            connect().close()
        except psycopg2.OperationalError as exc:
            raise unittest.SkipTest(f"cannot reach Supabase Postgres ({exc}); is the stack up?")
        cls.migration_0171 = next(cls.MIGRATIONS.glob("0171_*.sql")).read_text(encoding="utf-8")
        baseline = (cls.MIGRATIONS / "0001_baseline_schema.sql").read_text(encoding="utf-8")
        # The guarded CHECK blocks exactly as 0001 replays them on every boot.
        cls.baseline_checks = [
            re.search(r"DO \$c\$ BEGIN\n(?:(?!END \$c\$;).)*?conname = '%s'.*?END \$c\$;" % name, baseline, re.S).group(0)
            for name in ("metric_catalog_semantic_id_type_valid", "schemas_semantic_id_type_valid")
        ]

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

    @staticmethod
    def fetch(cur, sql, params=None):
        cur.execute(sql, params or ())
        return cur.fetchall()

    def current_id(self, cur, spec, name):
        return self.fetch(cur, "SELECT semantic_id FROM public.opcua_vocabulary"
                               " WHERE companion_spec = %s AND name = %s", (spec, name))[0][0]

    def test_every_row_carries_its_expanded_node_id_as_both_ids(self):
        rows = self.in_transaction(lambda cur: self.fetch(
            cur, "SELECT companion_spec, name, node_id, semantic_id FROM public.opcua_vocabulary"))
        self.assertGreater(len(rows), 0)
        namespaces = {}
        for spec, name, node_id, semantic_id in rows:
            with self.subTest(spec=spec, name=name):
                self.assertRegex(semantic_id, r"^nsu=[^;]+;[isgb]=[^;]+$")
                self.assertEqual(node_id, semantic_id)
                namespaces.setdefault(spec, set()).add(semantic_id.split(";")[0])
        for spec, seen in namespaces.items():
            self.assertEqual(len(seen), 1, f"{spec} names nodes in {sorted(seen)}")

    def test_0171_moves_a_former_id_and_a_replay_moves_nothing(self):
        def probe(cur):
            cur.execute("INSERT INTO public.metric_catalog (name, datatype, standard, semantic_id, semantic_id_type)"
                        " VALUES ('Fixture0171/Manufacturer', 12, 'OPC UA', %s, 'IRI'),"
                        "        ('Fixture0171/Gone', 10, 'OPC UA', %s, 'IRI'),"
                        "        ('Fixture0171/Typed', 12, 'OPC UA', %s, 'IRI')",
                        (self.MACHINERY + "Manufacturer", self.MACHINERY + "OperationalTime",
                         self.MACHINERY + "Manufacturer/"))
            cur.execute("INSERT INTO public.schemas (schema_name, schema_definition, semantic_id, semantic_id_type)"
                        " VALUES ('Fixture0171_Schema', '{\"type\": \"object\"}'::jsonb, %s, 'IRI')",
                        (self.ROBOTICS + "Mass",))
            cur.execute(self.migration_0171)
            first = self.fetch(cur, "SELECT name, semantic_id, semantic_id_type FROM public.metric_catalog"
                                    " WHERE name LIKE 'Fixture0171/%%' ORDER BY name")
            schema = self.fetch(cur, "SELECT semantic_id, semantic_id_type FROM public.schemas"
                                     " WHERE schema_name = 'Fixture0171_Schema'")
            trail = "SELECT count(*) FROM public.audit_trail WHERE entity_type = 'metric_catalog'"
            before = self.fetch(cur, trail)[0][0]
            cur.execute(self.migration_0171)
            second = self.fetch(cur, "SELECT name, semantic_id, semantic_id_type FROM public.metric_catalog"
                                     " WHERE name LIKE 'Fixture0171/%%' ORDER BY name")
            return (first, schema, second, self.fetch(cur, trail)[0][0] - before,
                    self.current_id(cur, "OPC 40001 Machinery", "Manufacturer"),
                    self.current_id(cur, "OPC 40010 Robotics", "Mass"))

        first, schema, second, written, manufacturer, mass = self.in_transaction(probe)
        self.assertEqual(first, [
            ("Fixture0171/Gone", self.MACHINERY + "OperationalTime", "IRI"),
            ("Fixture0171/Manufacturer", manufacturer, "ExpandedNodeId"),
            ("Fixture0171/Typed", self.MACHINERY + "Manufacturer/", "IRI"),
        ])
        self.assertEqual(schema, [(mass, "ExpandedNodeId")])
        self.assertEqual(second, first, "a replay of 0171 moved a row")
        self.assertEqual(written, 0, "a replay of 0171 wrote to metric_catalog")

    def test_0171_removes_a_row_0002_no_longer_writes(self):
        def probe(cur):
            cur.execute("INSERT INTO public.opcua_vocabulary (name, companion_spec, node_id, semantic_id)"
                        " VALUES ('OperationalTime', 'OPC 40001 Machinery', %s, %s)",
                        ("nsu=" + self.MACHINERY + ";s=Machine/OperationalTime", self.MACHINERY + "OperationalTime"))
            cur.execute(self.migration_0171)
            return self.fetch(cur, "SELECT count(*) FROM public.opcua_vocabulary WHERE name = 'OperationalTime'")[0][0]
        self.assertEqual(self.in_transaction(probe), 0)

    def test_the_baseline_checks_replay_over_an_expanded_node_id(self):
        """0001 drops a CHECK whose definition differs from its own, so its own must admit the type."""
        def probe(cur):
            cur.execute("INSERT INTO public.metric_catalog (name, datatype, semantic_id, semantic_id_type)"
                        " VALUES ('Fixture0171/Replay', 12, %s, 'ExpandedNodeId')",
                        ("nsu=" + self.MACHINERY + ";i=6002",))
            cur.execute("INSERT INTO public.schemas (schema_name, schema_definition, semantic_id, semantic_id_type)"
                        " VALUES ('Fixture0171_Replay', '{\"type\": \"object\"}'::jsonb, %s, 'ExpandedNodeId')",
                        ("nsu=" + self.ROBOTICS + ";i=6723",))
            oids = "SELECT oid FROM pg_constraint WHERE conname IN" \
                   " ('metric_catalog_semantic_id_type_valid', 'schemas_semantic_id_type_valid') ORDER BY conname"
            before = self.fetch(cur, oids)
            for block in self.baseline_checks:
                cur.execute(block)
            return before, self.fetch(cur, oids)
        before, after = self.in_transaction(probe)
        self.assertEqual(len(before), 2)
        self.assertEqual(after, before, "0001's replay dropped and re-added a semantic_id_type CHECK")


if __name__ == "__main__":
    unittest.main(verbosity=2)

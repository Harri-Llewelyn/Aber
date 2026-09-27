"""
The metric catalogue's standards seed: the section of 0002_seed_data.sql that files MTConnect,
OPC UA, ASHRAE 223P and ISO 22400 metrics under their groups, read from a migrated database.

    python supabase/migrations/test_metric_catalog_seed.py

WHAT IS ACTUALLY AT RISK HERE. `metric_catalog.name` is UNIQUE and IMMUTABLE, and the `standard`
and `semantic_id` a row is created with flow into the AAS export. A row seeded with the wrong
semantic id does not fail anywhere -- it asserts an interoperability that does not exist, in an
artefact handed to a customer, until something notices.

So the assertions below are about PROVENANCE as much as presence: every seeded row must carry a
semantic id that is still resolvable in the vocabulary table it came from. A vocabulary re-key or
a renamed concept would otherwise leave the catalog quietly pointing at nothing. The suite also
holds each group to one standard, every name to the metric-name format, and the immutability
trigger to freezing name and datatype while semantic_id and permitted_values stay correctable.

Replaying the seed is not tested here: `npm run test:db -- --with-history` and
check-migration-idempotency replay the whole chain.
"""
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("POSTGRES_PASSWORD", "postgres"))

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


def connect():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = True
    return conn


class SeedTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        try:
            cls.conn = connect()
        except psycopg2.OperationalError as exc:
            raise unittest.SkipTest(f"cannot reach Supabase Postgres ({exc}); is the stack up?")

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "conn", None):
            cls.conn.close()

    def rows(self, sql, params=None):
        with self.conn.cursor() as cur:
            cur.execute(sql, params or ())
            return cur.fetchall()

    def scalar(self, sql, params=None):
        return self.rows(sql, params)[0][0]


class TestSeededRows(SeedTestCase):

    def test_every_seeded_group_is_present(self):
        for group in GROUP_STANDARD:
            with self.subTest(group=group):
                count = self.scalar(
                    "SELECT count(*) FROM public.metric_catalog WHERE metric_group = %s", (group,)
                )
                self.assertGreater(count, 0, f"no catalog rows under '{group}'")

    def test_each_group_maps_to_exactly_one_standard(self):
        """
        The collision the taxonomy exists to prevent. Two standards sharing a top-level segment
        means a name could be claimed by either, and whichever lands first owns it permanently.
        """
        for group, standard in GROUP_STANDARD.items():
            with self.subTest(group=group):
                found = {
                    row[0] for row in self.rows(
                        "SELECT DISTINCT standard FROM public.metric_catalog "
                        " WHERE metric_group = %s AND standard IS NOT NULL", (group,)
                    )
                }
                self.assertEqual(found, {standard})

    def test_every_metric_group_is_registered_under_its_metrics_standard(self):
        """
        The other direction: one standard spread over two groups. 223P's seeded metrics once sat
        under an unregistered `BMS` while the form filed under `Building` (#456), and the picker
        showed the one under Local and the other under ASHRAE 223P with nothing in it.
        """
        strays = self.rows(
            "SELECT DISTINCT c.metric_group, c.standard, g.standard FROM public.metric_catalog c "
            "  LEFT JOIN public.metric_groups g ON g.name = c.metric_group "
            " WHERE c.standard IS NOT NULL AND c.metric_group IS NOT NULL "
            "   AND g.standard IS DISTINCT FROM c.standard"
        )
        self.assertEqual(strays, [], "(group, metrics' standard, group's registered standard)")

    def test_ashrae_223p_registers_one_group(self):
        groups = [r[0] for r in self.rows(
            "SELECT name FROM public.metric_groups WHERE standard = 'ASHRAE 223P' ORDER BY name")]
        self.assertEqual(groups, ["BMS"])

    def test_no_seeded_row_is_missing_its_standard_or_semantic_id(self):
        """A row created with standard = NULL is the exact defect this migration exists to prevent."""
        bad = self.rows(
            "SELECT name FROM public.metric_catalog "
            " WHERE metric_group = ANY(%s) AND (standard IS NULL OR semantic_id IS NULL)",
            (list(GROUP_STANDARD),),
        )
        self.assertEqual(bad, [], f"seeded rows without provenance: {[r[0] for r in bad]}")

    def test_every_name_satisfies_the_factory_plus_format(self):
        """
        `metric_catalog_name_format` enforces this on write. Checked directly rather than trusted,
        because these names are permanent.
        """
        bad = self.rows(
            "SELECT name FROM public.metric_catalog "
            " WHERE metric_group = ANY(%s) AND name !~ '^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$'",
            (list(GROUP_STANDARD),),
        )
        self.assertEqual(bad, [], f"names violating the metric-name format: {[r[0] for r in bad]}")

    def test_transliterated_names_carry_no_forbidden_characters(self):
        """
        The ASHRAE concept is `Constituent-CO2` and the OPC browse names carry dots elsewhere;
        both must have been transliterated at authoring time, because the name cannot be fixed
        later.
        """
        for name in ("BMS/CO2_CONCENTRATION",):
            with self.subTest(name=name):
                self.assertEqual(
                    self.scalar(
                        "SELECT count(*) FROM public.metric_catalog WHERE name = %s", (name,)
                    ), 1
                )


# The names the standards seed inserts, listed so a missing row is named. Every MTConnect row, seeded
# or not, is also held to its data item type's id by
# test_every_mtconnect_row_carries_its_data_item_types_id.
SEEDED = {
    "mtconnect_vocabulary": [
        "Axes/X/POSITION", "Axes/Y/POSITION", "Axes/Z/POSITION",
        "Axes/S/ROTARY_VELOCITY", "Axes/S/LOAD",
        "Controller/PATH_FEEDRATE", "Controller/CONTROLLER_MODE",
        "Controller/PROGRAM", "Controller/PART_COUNT",
        "Systems/AVAILABILITY",
    ],
    "opcua_vocabulary": [
        "MotionDevice/ActualPosition", "MotionDevice/ActualSpeed",
        "MotionDevice/EmergencyStop", "MotionDevice/ProtectiveStop",
        "MotionDevice/OnPath", "MotionDevice/TaskProgramName",
        "Machine/OperationalMode", "Machine/SpeedOverride",
        "Energy/Pressure", "Energy/Temperature",
        "Energy/VolumeFlowRate", "Energy/Volume",
    ],
    "ashrae223_vocabulary": [
        "BMS/ZONE_TEMPERATURE", "BMS/ZONE_HUMIDITY",
        "BMS/CO2_CONCENTRATION", "BMS/STATIC_PRESSURE",
    ],
    "iso22400_vocabulary": [
        "OEE/OEE", "OEE/UTILIZATION", "OEE/SCRAP_RATIO", "OEE/MTBF", "OEE/MTTR",
    ],
}


class TestWhatStaysCorrectable(SeedTestCase):
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

    def update(self, statement):
        conn = connect()
        conn.autocommit = False
        try:
            with conn.cursor() as cur:
                cur.execute(statement, (self.ROW,))
                return cur.rowcount, None
        except psycopg2.Error as exc:
            return 0, exc
        finally:
            conn.rollback()
            conn.close()

    def test_semantic_id_and_permitted_values_can_be_corrected(self):
        for statement in self.CORRECTABLE:
            with self.subTest(statement=statement):
                rows, error = self.update(statement)
                self.assertIsNone(error, f"refused: {error}")
                self.assertEqual(rows, 1, f"{self.ROW} is not seeded")

    def test_name_and_datatype_are_frozen(self):
        for statement in self.FROZEN:
            with self.subTest(statement=statement):
                _, error = self.update(statement)
                self.assertIsNotNone(error, "accepted")
                self.assertIn("immutable", str(error))


class TestProvenanceResolves(SeedTestCase):
    """
    Every semantic id the seed wrote must still be findable in the vocabulary it was SELECTed from.

    This is what catches a vocabulary re-key. The catalog rows survive one -- `name` is immutable
    and nothing cascades -- while silently ceasing to correspond to anything, and the first visible
    symptom would be an AAS shell exported to a customer carrying a dangling reference.
    """

    def _assert_resolves(self, vocabulary, names):
        missing = self.rows(
            "SELECT c.name FROM public.metric_catalog c "
            " WHERE c.name = ANY(%s) "
            "   AND NOT EXISTS (SELECT 1 FROM public." + vocabulary + " v "
            "                    WHERE v.semantic_id = c.semantic_id)",
            (names,),
        )
        self.assertEqual(
            missing, [], f"ids not resolvable in {vocabulary}: {[r[0] for r in missing]}"
        )

    def _assert_all_present(self, names):
        found = {r[0] for r in self.rows(
            "SELECT name FROM public.metric_catalog WHERE name = ANY(%s)", (names,)
        )}
        self.assertEqual(
            set(names) - found, set(), "the seed did not insert every metric listed in SEEDED"
        )

    def test_mtconnect_rows_are_present_and_resolve(self):
        names = SEEDED["mtconnect_vocabulary"]
        self._assert_all_present(names)
        self._assert_resolves("mtconnect_vocabulary", names)

    def test_every_mtconnect_row_carries_its_data_item_types_id(self):
        """
        Every MTConnect metric with an id carries its data item type's vocabulary id. The type is
        the last name segment once a trailing `sub_type` is removed. An id built from the whole
        name (`…/mtconnect/v2.0/Axes/C/ANGLE`) names one data item, not a concept, and fails here
        (#457).
        """
        wrong = self.rows(
            "SELECT c.name, c.semantic_id FROM public.metric_catalog c "
            "  LEFT JOIN public.mtconnect_vocabulary v "
            "    ON v.kind = 'DATA_ITEM_TYPE' AND v.semantic_id = c.semantic_id "
            " WHERE c.standard = 'MTConnect' AND c.semantic_id IS NOT NULL "
            "   AND v.name IS DISTINCT FROM regexp_replace("
            "         CASE WHEN NULLIF(c.sub_type, '') IS NOT NULL "
            "               AND right(c.name, length(c.sub_type) + 1) = '/' || c.sub_type "
            "              THEN left(c.name, length(c.name) - length(c.sub_type) - 1) "
            "              ELSE c.name END, '^.*/', '') "
            " ORDER BY c.name"
        )
        self.assertEqual(wrong, [], "(name, semantic_id) not its data item type's vocabulary id")

    def test_the_mtconnect_sweep_has_rows_to_check(self):
        """The sweep above passes on an empty catalog, so its subject is counted: 0002 seeds 17."""
        self.assertGreaterEqual(
            self.scalar("SELECT count(*) FROM public.metric_catalog WHERE standard = 'MTConnect'"),
            17,
        )

    def test_opcua_rows_are_present_and_resolve(self):
        names = SEEDED["opcua_vocabulary"]
        self._assert_all_present(names)
        self._assert_resolves("opcua_vocabulary", names)

    def test_ashrae_rows_are_present_and_resolve(self):
        names = SEEDED["ashrae223_vocabulary"]
        self._assert_all_present(names)
        self._assert_resolves("ashrae223_vocabulary", names)

    def test_iso22400_rows_are_present_and_resolve(self):
        names = SEEDED["iso22400_vocabulary"]
        self._assert_all_present(names)
        self._assert_resolves("iso22400_vocabulary", names)

    def test_opcua_ids_come_from_the_right_companion_spec(self):
        """
        `opcua_vocabulary` is keyed (companion_spec, name) and several names -- `Mass`,
        `Temperature` -- appear under more than one specification. A join that forgot the spec
        would resolve to a real id from the wrong document, which is indistinguishable from a
        correct one by every other test here.
        """
        for name, spec in (
            ("MotionDevice/ActualPosition", "OPC 40010 Robotics"),
            ("Energy/Temperature", "OPC 40001-4 Machinery Energy"),
        ):
            with self.subTest(name=name):
                matched = self.scalar(
                    "SELECT count(*) FROM public.metric_catalog c "
                    "  JOIN public.opcua_vocabulary v ON v.semantic_id = c.semantic_id "
                    " WHERE c.name = %s AND v.companion_spec = %s",
                    (name, spec),
                )
                self.assertEqual(matched, 1, f"{name} does not resolve within {spec}")

    def test_semantic_id_type_is_declared(self):
        """
        The exporter ignores `semantic_id_type` and always emits an ExternalReference, so this is
        validation metadata rather than export input -- but a NULL beside a populated id means
        nobody recorded what kind of identifier it is.
        """
        bad = self.rows(
            "SELECT name FROM public.metric_catalog "
            " WHERE metric_group = ANY(%s) AND semantic_id IS NOT NULL AND semantic_id_type IS NULL",
            (list(GROUP_STANDARD),),
        )
        self.assertEqual(bad, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""
Integration tests for 0018_metric_catalog_standards_seed.sql.

    python supabase/migrations/test_metric_catalog_seed.py

WHAT IS ACTUALLY AT RISK HERE. `metric_catalog.name` is UNIQUE and IMMUTABLE, and the `standard`
and `semantic_id` a row is created with flow into the AAS export and the i3X `sourceTypeId`. A row
seeded with the wrong semantic id does not fail anywhere -- it asserts an interoperability that
does not exist, in an artefact handed to a customer, and it cannot be corrected in place.

So the assertions below are about PROVENANCE as much as presence: every seeded row must carry a
semantic id that is still resolvable in the vocabulary table it came from. A vocabulary re-key or
a renamed concept would otherwise leave the catalog quietly pointing at nothing.

IDEMPOTENCY IS TESTED BY RE-RUNNING THE REAL FILE, not by inspection. Every migration is replayed
on every boot with ON_ERROR_STOP=1 and no ledger, so "runs twice cleanly" is a hard requirement
rather than a nicety, and the only convincing evidence is running it twice.
"""
import os
import subprocess
import unittest
from pathlib import Path

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("POSTGRES_PASSWORD", "postgres"))

MIGRATION = Path(__file__).with_name("0018_metric_catalog_standards_seed.sql")

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
        0007's constraint is NOT VALID, so it enforces on INSERT but may not have back-scanned.
        Checked directly rather than trusted -- and these names are permanent.
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


# The names 0018 inserts, listed explicitly rather than derived by metric_group.
#
# SCOPED DELIBERATELY, and the reason is a real difference this suite found. The rows 0002 seeded
# mint their semantic ids PATH-SHAPED --
#   https://aber.local/semantics/mtconnect/v2.0/Axes/C/ANGLE
# -- where mtconnect_vocabulary mints them TYPE-SHAPED --
#   https://aber.local/semantics/mtconnect/v2.0/DataItemType/ANGLE
#
# Both live under the locally-minted `aber.local` namespace, so neither asserts an
# interoperability that does not exist and neither is wrong; they are two conventions for the same
# thing, and 0002's predates the vocabulary tables. Reconciling them is a deprecate-and-supersede
# exercise with its own reasoning to write, not something to do silently here. A group-wide
# assertion would have forced that decision by failing, which is why this list names rows instead.
SEEDED_BY_0018 = {
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

    def update(self, assignment):
        conn = connect()
        conn.autocommit = False
        try:
            with conn.cursor() as cur:
                cur.execute(f"UPDATE public.metric_catalog SET {assignment} WHERE name = %s", (self.ROW,))
                return cur.rowcount, None
        except psycopg2.Error as exc:
            return 0, exc
        finally:
            conn.rollback()
            conn.close()

    def test_semantic_id_and_permitted_values_can_be_corrected(self):
        for assignment in ("semantic_id = semantic_id || '-corrected'",
                           "permitted_values = ARRAY['CORRECTED']"):
            with self.subTest(assignment=assignment):
                rows, error = self.update(assignment)
                self.assertIsNone(error, f"{assignment} was refused: {error}")
                self.assertEqual(rows, 1, f"{self.ROW} is not seeded")

    def test_name_and_datatype_are_frozen(self):
        for assignment in ("name = name || '_RENAMED'",
                           "datatype = CASE WHEN datatype = 10 THEN 12 ELSE 10 END"):
            with self.subTest(assignment=assignment):
                _, error = self.update(assignment)
                self.assertIsNotNone(error, f"{assignment} was accepted")
                self.assertIn("immutable", str(error))


class TestProvenanceResolves(SeedTestCase):
    """
    Every semantic id 0018 wrote must still be findable in the vocabulary it was SELECTed from.

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
            set(names) - found, set(), "0018 did not insert every metric it declares"
        )

    def test_mtconnect_rows_are_present_and_resolve(self):
        names = SEEDED_BY_0018["mtconnect_vocabulary"]
        self._assert_all_present(names)
        self._assert_resolves("mtconnect_vocabulary", names)

    def test_opcua_rows_are_present_and_resolve(self):
        names = SEEDED_BY_0018["opcua_vocabulary"]
        self._assert_all_present(names)
        self._assert_resolves("opcua_vocabulary", names)

    def test_ashrae_rows_are_present_and_resolve(self):
        names = SEEDED_BY_0018["ashrae223_vocabulary"]
        self._assert_all_present(names)
        self._assert_resolves("ashrae223_vocabulary", names)

    def test_iso22400_rows_are_present_and_resolve(self):
        names = SEEDED_BY_0018["iso22400_vocabulary"]
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


class TestIdempotency(SeedTestCase):
    """
    Re-runs the actual migration file with psql, exactly as supabase-db-init does on every boot.
    """

    def apply_migration(self):
        env = {**os.environ, "PGPASSWORD": DB_PASSWORD}
        return subprocess.run(
            ["docker", "exec", "-e", f"PGPASSWORD={DB_PASSWORD}",
             os.getenv("SUPABASE_DB_CONTAINER", "aber_supabase_db"),
             "psql", "-v", "ON_ERROR_STOP=1", "-U", DB_USER, "-d", DB_NAME, "-f", "/tmp/0018.sql"],
            capture_output=True, text=True, env=env,
        )

    def test_reapplying_adds_no_rows_and_does_not_error(self):
        container = os.getenv("SUPABASE_DB_CONTAINER", "aber_supabase_db")
        copy = subprocess.run(
            ["docker", "cp", str(MIGRATION), f"{container}:/tmp/0018.sql"],
            capture_output=True, text=True,
        )
        if copy.returncode != 0:
            self.skipTest(f"cannot copy the migration into {container}: {copy.stderr.strip()}")

        before = self.scalar("SELECT count(*) FROM public.metric_catalog")

        first = self.apply_migration()
        self.assertEqual(first.returncode, 0, f"first replay failed: {first.stderr}")

        after_first = self.scalar("SELECT count(*) FROM public.metric_catalog")

        second = self.apply_migration()
        self.assertEqual(second.returncode, 0, f"second replay failed: {second.stderr}")

        after_second = self.scalar("SELECT count(*) FROM public.metric_catalog")

        self.assertEqual(after_first, before, "replaying the migration inserted rows")
        self.assertEqual(after_second, after_first, "a second replay inserted rows")

    def test_self_check_passes_on_replay(self):
        container = os.getenv("SUPABASE_DB_CONTAINER", "aber_supabase_db")
        copy = subprocess.run(
            ["docker", "cp", str(MIGRATION), f"{container}:/tmp/0018.sql"],
            capture_output=True, text=True,
        )
        if copy.returncode != 0:
            self.skipTest(f"cannot copy the migration into {container}: {copy.stderr.strip()}")

        result = self.apply_migration()
        self.assertEqual(result.returncode, 0)
        self.assertIn("0018 self-check passed", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)

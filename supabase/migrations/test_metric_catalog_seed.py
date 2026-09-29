"""
The metric catalogue's standards seed: the section of 0002_seed_data.sql that files MTConnect,
OPC UA, ASHRAE 223P and ISO 22400 metrics under their groups, read from a migrated database.

    python supabase/migrations/test_metric_catalog_seed.py

WHAT IS ACTUALLY AT RISK HERE. `metric_catalog.name` is UNIQUE and IMMUTABLE, and the `standard`
and `semantic_id` a row is created with flow into the AAS export and the i3X metric types. A row
seeded with the wrong semantic id does not fail anywhere -- it asserts an interoperability that
does not exist, in an artefact handed to a customer, until something notices.

So the assertions below are about PROVENANCE as much as presence: every seeded row must carry a
semantic id that is still resolvable in the vocabulary table it came from. A vocabulary re-key or
a renamed concept would otherwise leave the catalog quietly pointing at nothing. The suite also
holds each group to one standard, every name to the metric-name format, the immutability
trigger to freezing name and datatype while semantic_id and permitted_values stay correctable, and
the two local extensions to carrying no id minted for them (0016).

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


class TestReferenceTypesAreIriAndIrdi(SeedTestCase):
    """
    0012 withdraws ModelReference from `schemas.semantic_id_type` and
    `metric_catalog.semantic_id_type`: the exporter emits every id as an ExternalReference, which a
    ModelReference is not. Each probe runs in its own transaction and is rolled back.
    """

    MIGRATION_0012 = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  "0012_a_semantic_id_is_an_iri_or_an_irdi.sql")
    CONSTRAINTS = (("schemas", "schemas_semantic_id_type_valid"),
                   ("metric_catalog", "metric_catalog_semantic_id_type_valid"))
    INSERTS = {
        "schemas": "INSERT INTO public.schemas (schema_name, schema_definition, semantic_id, semantic_id_type)"
                   " VALUES ('Fixture0012_Schema', '{\"type\": \"object\"}'::jsonb, 'urn:example:fixture', %s)",
        "metric_catalog": "INSERT INTO public.metric_catalog (name, datatype, semantic_id, semantic_id_type)"
                          " VALUES ('Fixture0012/Value', 9, 'urn:example:fixture', %s)",
    }

    def migration_sql(self):
        with open(self.MIGRATION_0012, encoding="utf-8") as f:
            return f.read()

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

    def constraint_oids(self, cur):
        cur.execute(
            "SELECT conname, oid FROM pg_constraint WHERE conname IN %s ORDER BY conname",
            (tuple(name for _, name in self.CONSTRAINTS),),
        )
        return cur.fetchall()

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

    def test_a_replay_does_not_replace_the_constraints(self):
        """Guarded on the definition: on a database already narrowed, 0012 changes nothing."""
        sql = self.migration_sql()

        def replay(cur):
            before = self.constraint_oids(cur)
            cur.execute(sql)
            after_first = self.constraint_oids(cur)
            cur.execute(sql)
            return before, after_first, self.constraint_oids(cur)

        before, after_first, after_second = self.in_transaction(replay)
        self.assertEqual(len(before), 2, "a semantic_id_type CHECK is missing")
        self.assertEqual(after_first, before, "0012 replaced a constraint that was already narrowed")
        self.assertEqual(after_second, before, "a second replay of 0012 replaced a constraint")

    def test_a_model_reference_row_stops_the_migration_with_what_to_change(self):
        """
        A database whose row still holds ModelReference: 0012 names the table and the fix rather
        than failing on a CHECK violation, and leaves the row as it was.
        """
        sql = self.migration_sql()

        def provoke(cur):
            cur.execute(
                "ALTER TABLE public.metric_catalog DROP CONSTRAINT metric_catalog_semantic_id_type_valid,"
                " ADD CONSTRAINT metric_catalog_semantic_id_type_valid CHECK (semantic_id_type IS NULL"
                " OR semantic_id_type IN ('IRI', 'IRDI', 'ModelReference'))"
            )
            cur.execute(self.INSERTS["metric_catalog"], ("ModelReference",))
            with self.assertRaises(psycopg2.errors.RaiseException) as raised:
                cur.execute(sql)
            return raised.exception

        error = self.in_transaction(provoke)
        self.assertIn("public.metric_catalog", str(error))
        self.assertIn("ModelReference", str(error))
        hint = error.diag.message_hint or ""
        self.assertIn("IRI", hint)
        self.assertIn("IRDI", hint)


class TestLocalExtensionsCarryNoMintedId(SeedTestCase):
    """
    No id is minted for a local extension: an `aber.local` id resolves nowhere and names no concept.
    0002 seeds the two with none, and 0016 clears the ids an earlier seed gave them, but only while
    each is still exactly the minted one. Each probe runs in its own transaction and is rolled back.
    """

    MIGRATION_0016 = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  "0016_a_local_extension_carries_no_minted_id.sql")
    MINTED = {
        "safety_interlock": "https://aber.local/semantics/local/safety_interlock",
        "max_temp_threshold": "https://aber.local/semantics/local/max_temp_threshold",
    }

    def migration_sql(self):
        with open(self.MIGRATION_0016, encoding="utf-8") as f:
            return f.read()

    def in_transaction(self, work):
        conn = connect()
        conn.autocommit = False
        try:
            with conn.cursor() as cur:
                return work(cur)
        finally:
            conn.rollback()
            conn.close()

    @staticmethod
    def ids(cur):
        cur.execute("SELECT name, semantic_id, semantic_id_type FROM public.metric_catalog"
                    " WHERE name IN ('safety_interlock', 'max_temp_threshold') ORDER BY name")
        return {name: (sid, kind) for name, sid, kind in cur.fetchall()}

    def mint(self, cur, name, semantic_id=None):
        cur.execute("UPDATE public.metric_catalog SET semantic_id = %s, semantic_id_type = 'IRI'"
                    " WHERE name = %s", (semantic_id or self.MINTED[name], name))

    def test_the_seed_gives_neither_an_id(self):
        self.assertEqual(self.in_transaction(self.ids), {
            "max_temp_threshold": (None, None), "safety_interlock": (None, None),
        })

    def test_an_earlier_seed_s_ids_are_cleared_and_the_trail_records_it(self):
        def probe(cur):
            for name in self.MINTED:
                self.mint(cur, name)
            cur.execute(self.migration_sql())
            rows = []
            for name, minted in self.MINTED.items():
                cur.execute(
                    "SELECT t.actor_source, t.audit_domain, t.changed_by"
                    "  FROM public.audit_trail t JOIN public.metric_catalog c ON c.id = t.entity_id"
                    " WHERE t.entity_type = 'metric_catalog' AND t.action = 'UPDATE' AND c.name = %s"
                    "   AND t.old_data ->> 'semantic_id' = %s AND t.new_data ->> 'semantic_id' IS NULL"
                    # This transaction's rows only: on a stack that booted from an earlier seed, the
                    # chain's own 0016 has already recorded the same clearing once.
                    "   AND t.causation_id = txid_current()",
                    (name, minted),
                )
                rows.append((name, cur.fetchall()))
            return self.ids(cur), rows

        ids, trail = self.in_transaction(probe)
        self.assertEqual(ids, {"max_temp_threshold": (None, None), "safety_interlock": (None, None)})
        for name, rows in trail:
            with self.subTest(name=name):
                # The platform's own act: no person, and in the lane every reader of the catalog sees.
                self.assertEqual(rows, [("migration", "asset", None)])

    def test_an_id_an_administrator_set_stays(self):
        def probe(cur):
            self.mint(cur, "safety_interlock", "urn:example:plant:safety-interlock")
            self.mint(cur, "max_temp_threshold")
            cur.execute(self.migration_sql())
            return self.ids(cur)

        ids = self.in_transaction(probe)
        self.assertEqual(ids["safety_interlock"], ("urn:example:plant:safety-interlock", "IRI"))
        self.assertEqual(ids["max_temp_threshold"], (None, None))

    def test_a_replay_writes_nothing(self):
        def probe(cur):
            cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'metric_catalog'")
            before = cur.fetchone()[0]
            cur.execute(self.migration_sql())
            cur.execute(self.migration_sql())
            cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'metric_catalog'")
            return before, cur.fetchone()[0], self.ids(cur)

        before, after, ids = self.in_transaction(probe)
        self.assertEqual(after, before)
        self.assertEqual(ids, {"max_temp_threshold": (None, None), "safety_interlock": (None, None)})

    def test_the_self_check_names_a_metric_still_holding_its_minted_id(self):
        sql = self.migration_sql()
        self_check = sql[sql.index("-- Self-check"):]

        def provoke(cur):
            self.mint(cur, "max_temp_threshold")
            with self.assertRaises(psycopg2.errors.RaiseException) as raised:
                cur.execute(self_check)
            return raised.exception

        self.assertIn("max_temp_threshold", str(self.in_transaction(provoke)))


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

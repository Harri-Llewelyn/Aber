"""
PostgreSQL integration tests for 0168: a device's schemas are the union of both attachment paths.

A schema reaches a device through a `device_submodels` row or through `devices.schema_id`. Until
0168 the `device_schemas` view read the column only for a device with no submodel row, so the
places that read a device's schemas disagreed. These tests hold them to one answer:

  * the view returns both arms, one row per (device, schema);
  * a SCHEMA_REJECTION row names every schema the device is judged against;
  * set_device_schemas(), the Devices page's writer, makes the set exact in one transaction and
    clears the deprecated column;
  * replaying 0168 onto a database that holds both arms keeps the union.

Every test runs in one transaction and rolls back:

    python supabase/migrations/test_device_schemas_union.py
"""
import json
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATION = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "0168_every_schema_attached_to_a_device_counts.sql"
)

# The Service_Ingestor principal, the one identity record_ingestion_rejection() admits.
INGESTION_PRINCIPAL = "b0000000-0000-4000-8000-000000000002"

ADMIN_USER_ID = "a1680000-0000-4000-8000-000000000001"
MANAGER_USER_ID = "a1680000-0000-4000-8000-000000000002"
OPERATOR_USER_ID = "a1680000-0000-4000-8000-000000000003"
PERSONAS = (
    (ADMIN_USER_ID, "Administrator"),
    (MANAGER_USER_ID, "Shopfloor_Manager"),
    (OPERATOR_USER_ID, "Operator"),
)

DEFINITION = {"type": "object", "properties": {"Systems/TEMPERATURE": {"type": "number"}}}


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class DeviceSchemasTestCase(unittest.TestCase):
    """Fixtures are written as the owner; the RPC is called as `authenticated` with claims."""

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('public.set_device_schemas(uuid, uuid[])')")
                if not cur.fetchone()[0]:
                    raise RuntimeError("set_device_schemas() is missing -- 0168 has not been applied.")
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self._personas()
        self.cur.execute(
            "INSERT INTO public.gateways (name) VALUES ('ONEPATH_GW') RETURNING id::text"
        )
        self.gateway_id = self.cur.fetchone()[0]

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()
        self.conn.close()

    # ------------------------------------------------------------------ helpers

    def _personas(self):
        """People with roles. Emailed, so 0080's machine-principal guard on user_roles lets them in."""
        for user_id, role in PERSONAS:
            for columns, values in (
                ("(instance_id, id, aud, role, email)",
                 ("00000000-0000-0000-0000-000000000000", user_id, "authenticated",
                  "authenticated", f"{user_id}@device-schemas.test")),
                ("(id)", (user_id,)),
            ):
                self.cur.execute("SAVEPOINT persona")
                try:
                    self.cur.execute(
                        f"INSERT INTO auth.users {columns} VALUES "
                        f"({', '.join(['%s'] * len(values))}) ON CONFLICT (id) DO NOTHING",
                        values,
                    )
                    self.cur.execute("RELEASE SAVEPOINT persona")
                    break
                except psycopg2.Error:
                    self.cur.execute("ROLLBACK TO SAVEPOINT persona")
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) "
                "SELECT %s, id FROM public.roles WHERE name = %s "
                "ON CONFLICT (user_id, role_id) DO NOTHING",
                (user_id, role),
            )

    def act_as(self, user_id):
        self.cur.execute(
            "SELECT set_config('request.jwt.claims', %s, true)",
            (json.dumps({"sub": user_id, "role": "authenticated"}),),
        )
        self.cur.execute("SET LOCAL ROLE authenticated")

    def act_as_owner(self):
        self.cur.execute("RESET ROLE")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true)")

    def schema(self, name, status="active"):
        self.cur.execute(
            "INSERT INTO public.schemas (schema_name, description, schema_definition, status) "
            "VALUES (%s, 'device schemas test fixture', %s::jsonb, %s) RETURNING id::text",
            (name, json.dumps(DEFINITION), status),
        )
        return self.cur.fetchone()[0]

    def device(self, name, schema_id=None):
        self.cur.execute(
            "INSERT INTO public.devices (name, gateway_id, schema_id) VALUES (%s, %s, %s) "
            "RETURNING id::text",
            (name, self.gateway_id, schema_id),
        )
        return self.cur.fetchone()[0]

    def submodel(self, device_id, schema_id, key=None):
        self.cur.execute(
            "INSERT INTO public.device_submodels (device_id, schema_id, submodel_key) "
            "VALUES (%s, %s, %s)",
            (device_id, schema_id, key),
        )

    def resolved(self, device_id):
        """{schema_id: (source, submodel_key)} from the view."""
        self.cur.execute(
            "SELECT schema_id::text, source, submodel_key FROM public.device_schemas "
            "WHERE device_id = %s",
            (device_id,),
        )
        rows = self.cur.fetchall()
        self.assertEqual(len(rows), len({r[0] for r in rows}), f"a schema appears twice: {rows}")
        return {r[0]: (r[1], r[2]) for r in rows}

    def column(self, device_id):
        self.cur.execute("SELECT schema_id::text FROM public.devices WHERE id = %s", (device_id,))
        return self.cur.fetchone()[0]

    def submodels(self, device_id):
        self.cur.execute(
            "SELECT schema_id::text FROM public.device_submodels WHERE device_id = %s", (device_id,)
        )
        return {r[0] for r in self.cur.fetchall()}

    def set_schemas(self, device_id, schema_ids):
        self.cur.execute(
            "SELECT public.set_device_schemas(%s::uuid, %s::uuid[])", (device_id, schema_ids)
        )
        return self.cur.fetchone()[0]

    def raises(self, fn):
        """The psycopg2 error `fn` raises, with the transaction kept usable."""
        self.cur.execute("SAVEPOINT expect_failure")
        try:
            fn()
        except psycopg2.Error as exc:
            self.cur.execute("ROLLBACK TO SAVEPOINT expect_failure")
            return exc
        self.cur.execute("ROLLBACK TO SAVEPOINT expect_failure")
        self.fail("expected the statement to raise, but it succeeded")

    def assertNotFound(self, exc, message):
        """raise_not_found() (0165): SQLSTATE PGRST carrying the 404 body PostgREST answers with."""
        self.assertEqual(exc.pgcode, "PGRST", str(exc))
        body = json.loads(exc.diag.message_primary)
        self.assertEqual((body["code"], body["message"]), ("P0002", message))


class TheViewIsTheUnion(DeviceSchemasTestCase):
    """The four places in the issue read this view, so the union here is what they agree on."""

    def test_a_submodel_added_beside_the_column_keeps_the_column(self):
        # The issue's first case: schema A from the dashboard, then B through the API.
        a = self.schema("ONEPATH_A")
        b = self.schema("ONEPATH_B")
        device_id = self.device("ONEPATH_DEV_AB", schema_id=a)
        self.submodel(device_id, b)

        self.assertEqual(
            self.resolved(device_id),
            {a: ("devices.schema_id", None), b: ("device_submodels", None)},
        )

    def test_a_schema_on_both_arms_is_one_row_and_keeps_its_submodel_key(self):
        a = self.schema("ONEPATH_BOTH")
        device_id = self.device("ONEPATH_DEV_BOTH", schema_id=a)
        self.submodel(device_id, a, key="Machining")

        self.assertEqual(self.resolved(device_id), {a: ("device_submodels", "Machining")})

    def test_either_arm_alone_still_resolves(self):
        a = self.schema("ONEPATH_COLUMN_ONLY")
        b = self.schema("ONEPATH_SUBMODEL_ONLY")
        by_column = self.device("ONEPATH_DEV_COLUMN", schema_id=a)
        by_submodel = self.device("ONEPATH_DEV_SUBMODEL")
        self.submodel(by_submodel, b)
        nothing = self.device("ONEPATH_DEV_NONE")

        self.assertEqual(self.resolved(by_column), {a: ("devices.schema_id", None)})
        self.assertEqual(self.resolved(by_submodel), {b: ("device_submodels", None)})
        self.assertEqual(self.resolved(nothing), {})

    def test_replaying_the_migration_keeps_the_union(self):
        # db-init replays every file on every boot, onto a database that already holds both arms.
        a = self.schema("ONEPATH_REPLAY_A")
        b = self.schema("ONEPATH_REPLAY_B")
        device_id = self.device("ONEPATH_DEV_REPLAY", schema_id=a)
        self.submodel(device_id, b)

        with open(MIGRATION, encoding="utf-8") as f:
            sql = f.read()
        self.cur.execute(sql)
        self.cur.execute(sql)

        self.assertEqual(set(self.resolved(device_id)), {a, b})
        self.cur.execute(
            "SELECT has_table_privilege('authenticated', 'public.device_schemas', 'SELECT'), "
            "       has_function_privilege('anon', 'public.set_device_schemas(uuid, uuid[])', 'EXECUTE')"
        )
        self.assertEqual(self.cur.fetchone(), (True, False))


class TheRejectionNamesTheJudgedSchemas(DeviceSchemasTestCase):
    """record_ingestion_rejection() reads the view, as ingestion's conformance check does."""

    def reject(self, device_id):
        self.cur.execute(
            "SELECT set_config('request.jwt.claims', %s, true)",
            (json.dumps({"sub": INGESTION_PRINCIPAL, "role": "authenticated"}),),
        )
        self.cur.execute(
            "SELECT public.record_ingestion_rejection(%s::uuid, %s::jsonb)",
            (device_id, json.dumps([{"metric": "Rogue/Metric", "code": "unmodelled_metric"}])),
        )
        audit_id = self.cur.fetchone()[0]
        self.cur.execute("SELECT new_data FROM public.audit_trail WHERE id = %s", (audit_id,))
        return self.cur.fetchone()[0]

    def test_both_arms_are_named_with_the_column_first(self):
        a = self.schema("ONEPATH_REJECT_A")
        b = self.schema("ONEPATH_REJECT_B")
        device_id = self.device("ONEPATH_DEV_REJECT", schema_id=a)
        self.submodel(device_id, b)

        row = self.reject(device_id)
        self.assertEqual(row["schema_ids"], [a, b])
        self.assertEqual(row["schema_id"], a, "the 1.0 key keeps the column's value where it is set")

    def test_a_device_attached_only_through_submodels_names_its_schemas(self):
        # The issue's second case: the 1.0 snapshot recorded no schema for this device.
        a = self.schema("ONEPATH_REJECT_SUB_A")
        b = self.schema("ONEPATH_REJECT_SUB_B")
        device_id = self.device("ONEPATH_DEV_REJECT_SUB")
        self.submodel(device_id, a)
        self.submodel(device_id, b)

        row = self.reject(device_id)
        self.assertEqual(row["schema_ids"], sorted([a, b]))
        self.assertEqual(row["schema_id"], sorted([a, b])[0])

    def test_a_device_with_no_schema_records_none(self):
        row = self.reject(self.device("ONEPATH_DEV_REJECT_NONE"))
        self.assertEqual(row["schema_ids"], [])
        self.assertIsNone(row["schema_id"])


class SetDeviceSchemas(DeviceSchemasTestCase):
    """The dashboard's one writer: device_submodels only, and the column cleared."""

    def test_adding_a_schema_moves_the_column_into_submodels(self):
        a = self.schema("ONEPATH_SET_A")
        b = self.schema("ONEPATH_SET_B")
        device_id = self.device("ONEPATH_DEV_SET", schema_id=a)

        self.act_as(ADMIN_USER_ID)
        result = self.set_schemas(device_id, [a, b])
        self.act_as_owner()

        self.assertEqual(sorted(result["schema_ids"]), sorted([a, b]))
        self.assertEqual((result["attached"], result["detached"]), (1, 0))
        self.assertEqual(self.submodels(device_id), {a, b})
        self.assertIsNone(self.column(device_id))
        self.assertEqual(set(self.resolved(device_id)), {a, b})

    def test_removing_the_schema_that_came_from_the_column(self):
        a = self.schema("ONEPATH_REMOVE_A")
        b = self.schema("ONEPATH_REMOVE_B")
        device_id = self.device("ONEPATH_DEV_REMOVE", schema_id=a)
        self.submodel(device_id, b)

        self.act_as(MANAGER_USER_ID)
        result = self.set_schemas(device_id, [b])
        self.act_as_owner()

        self.assertEqual((result["schema_ids"], result["attached"], result["detached"]), ([b], 0, 1))
        self.assertIsNone(self.column(device_id))
        self.assertEqual(set(self.resolved(device_id)), {b})

    def test_an_empty_set_detaches_everything(self):
        a = self.schema("ONEPATH_EMPTY_A")
        b = self.schema("ONEPATH_EMPTY_B")
        device_id = self.device("ONEPATH_DEV_EMPTY", schema_id=a)
        self.submodel(device_id, b)

        self.act_as(ADMIN_USER_ID)
        result = self.set_schemas(device_id, [])
        self.act_as_owner()

        self.assertEqual((result["schema_ids"], result["detached"]), ([], 2))
        self.assertEqual(self.resolved(device_id), {})

    def test_a_kept_row_keeps_its_submodel_key(self):
        a = self.schema("ONEPATH_KEY_A")
        b = self.schema("ONEPATH_KEY_B")
        device_id = self.device("ONEPATH_DEV_KEY")
        self.submodel(device_id, a, key="Machining")

        self.act_as(ADMIN_USER_ID)
        self.set_schemas(device_id, [a, b])
        self.act_as_owner()

        self.assertEqual(
            self.resolved(device_id),
            {a: ("device_submodels", "Machining"), b: ("device_submodels", None)},
        )

    def test_an_archived_schema_already_attached_survives_the_move(self):
        # A device left on an archived version is an unfinished migration; saving it with a second
        # schema must not be refused for the one it already had.
        old = self.schema("ONEPATH_ARCHIVED_KEPT")
        b = self.schema("ONEPATH_ARCHIVED_NEW")
        device_id = self.device("ONEPATH_DEV_ARCHIVED", schema_id=old)
        self.cur.execute("UPDATE public.schemas SET status = 'archived' WHERE id = %s", (old,))

        self.act_as(ADMIN_USER_ID)
        self.set_schemas(device_id, [old, b])
        self.act_as_owner()

        self.assertEqual(self.submodels(device_id), {old, b})
        self.assertIsNone(self.column(device_id))

    def test_a_new_archived_schema_is_refused_and_nothing_changes(self):
        a = self.schema("ONEPATH_ATOMIC_A")
        archived = self.schema("ONEPATH_ATOMIC_OLD", status="archived")
        device_id = self.device("ONEPATH_DEV_ATOMIC", schema_id=a)

        self.act_as(ADMIN_USER_ID)
        exc = self.raises(lambda: self.set_schemas(device_id, [a, archived]))
        self.act_as_owner()

        self.assertEqual(exc.pgcode, "23514", str(exc))
        self.assertEqual(self.column(device_id), a, "a refused save must leave the column as it was")
        self.assertEqual(self.submodels(device_id), set())

    def test_an_operator_is_refused(self):
        device_id = self.device("ONEPATH_DEV_OPERATOR")
        self.act_as(OPERATOR_USER_ID)
        exc = self.raises(lambda: self.set_schemas(device_id, []))
        self.assertEqual(exc.pgcode, "42501", str(exc))

    def test_an_unknown_device_or_schema_is_a_404(self):
        device_id = self.device("ONEPATH_DEV_UNKNOWN")
        missing = "00000000-0000-4000-8000-000000000168"
        self.act_as(ADMIN_USER_ID)

        self.assertNotFound(
            self.raises(lambda: self.set_schemas(missing, [])), f"device {missing} not found"
        )
        self.assertNotFound(
            self.raises(lambda: self.set_schemas(device_id, [missing])), f"schema {missing} not found"
        )

    def test_a_null_set_is_refused(self):
        device_id = self.device("ONEPATH_DEV_NULL")
        self.act_as(ADMIN_USER_ID)
        exc = self.raises(lambda: self.set_schemas(device_id, None))
        self.assertEqual(exc.pgcode, "22004", str(exc))  # null_value_not_allowed


if __name__ == "__main__":
    unittest.main(verbosity=2)

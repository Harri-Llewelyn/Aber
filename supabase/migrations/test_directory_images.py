"""
The Directory's Version column, and the name of its Node-RED entry.

`record_directory_images()` writes `directory_services.image` from the chart's component -> image
map on every db-init run. Four properties, each of which would fail quietly:

- Every chart-managed row is covered, so a row whose id drifted from the seed would read "not
  recorded" for ever with nothing else noticing.
- A component the map no longer names is cleared, or a service switched off in the chart would
  keep showing the version of the release that last deployed it.
- A row the chart does not manage is left alone: `directory_services` is a registry anything can
  write into.
- Nothing but db-init can call it. It is revoked from every API role, so no signed-in user can
  rewrite the versions the page shows.

Runs against the Supabase database, not the historian:

    python supabase/migrations/test_directory_images.py
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

# The chart's map as `aber.directoryImages` renders it with every component enabled.
FULL_MAP = {
    "supabase-studio": "supabase/studio:2026.07.07-sha-a6a04f2",
    "node-red": "ghcr.io/harri-llewelyn/aber/node-red:0.1.0",
    "mosquitto": "eclipse-mosquitto:2.0.22",
    "timescaledb": "timescale/timescaledb:2.29.2-pg17",
    "grafana": "grafana/grafana:13.2.0",
    "supabase-envoy": "envoyproxy/envoy:v1.39.1",
    "supabase-auth": "supabase/gotrue:v2.189.0",
    "supabase-rest": "postgrest/postgrest:v14.12",
    "supabase-functions": "ghcr.io/harri-llewelyn/aber/edge-runtime:0.1.0",
    "supabase-db": "supabase/postgres:17.6.1.160",
    "ingestion": "ghcr.io/harri-llewelyn/aber/ingestion:0.1.0",
    "swagger-ui": "ghcr.io/harri-llewelyn/aber/swagger-ui:0.1.0",
    "prometheus": "prom/prometheus:v3.14.0",
    "alloy": "grafana/alloy:v1.11.2",
    "gitea": "gitea/gitea:1.27.3",
}

STUDIO = "f1111111-0000-0000-0000-000000000001"
GRAFANA = "f1111111-0000-0000-0000-000000000006"
NODE_EXPORTER = "f1111111-0000-0000-0000-00000000000f"
INGESTION_ROWS = ("f1111111-0000-0000-0000-00000000000c", "f1111111-0000-0000-0000-000000000010")
FORGE = "f1111111-0000-0000-0000-000000000011"
CHART_ROWS = 16


def get_connection():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )


class TestDirectoryImages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()
        cls.conn.autocommit = False

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def tearDown(self):
        # The column is db-init's to write; a suite that left values behind would put versions on
        # a page that no deployment recorded.
        self.conn.rollback()

    def record(self, cur, images):
        cur.execute("SELECT public.record_directory_images(%s::jsonb)", (json.dumps(images),))
        return cur.fetchone()[0]

    def image_of(self, cur, row_id):
        cur.execute("SELECT image FROM public.directory_services WHERE id = %s", (row_id,))
        return cur.fetchone()[0]

    def test_the_full_map_reaches_every_chart_managed_row(self):
        with self.conn.cursor() as cur:
            # Start from a known state, so the count below does not depend on what db-init last
            # recorded on this database.
            self.record(cur, {})
            self.assertEqual(self.record(cur, FULL_MAP), CHART_ROWS)

            cur.execute("SELECT count(*) FROM public.directory_services WHERE image IS NOT NULL")
            self.assertEqual(cur.fetchone()[0], CHART_ROWS)
            self.assertEqual(self.image_of(cur, GRAFANA), "grafana/grafana:13.2.0")
            self.assertEqual(self.image_of(cur, FORGE), "gitea/gitea:1.27.3")
            # node_exporter's collectors run inside Alloy, so that row carries Alloy's image.
            self.assertEqual(self.image_of(cur, NODE_EXPORTER), "grafana/alloy:v1.11.2")
            for row in INGESTION_ROWS:
                self.assertEqual(self.image_of(cur, row), "ghcr.io/harri-llewelyn/aber/ingestion:0.1.0")

    def test_a_replay_of_the_same_release_changes_nothing(self):
        with self.conn.cursor() as cur:
            self.record(cur, FULL_MAP)
            self.assertEqual(self.record(cur, FULL_MAP), 0)

    def test_an_upgrade_moves_only_the_rows_it_changed(self):
        with self.conn.cursor() as cur:
            self.record(cur, FULL_MAP)
            upgraded = {**FULL_MAP, "grafana": "grafana/grafana:13.3.0"}
            self.assertEqual(self.record(cur, upgraded), 1)
            self.assertEqual(self.image_of(cur, GRAFANA), "grafana/grafana:13.3.0")

    def test_a_component_the_chart_stops_deploying_is_cleared(self):
        with self.conn.cursor() as cur:
            self.record(cur, FULL_MAP)
            without_studio = {k: v for k, v in FULL_MAP.items() if k != "supabase-studio"}
            self.assertEqual(self.record(cur, without_studio), 1)
            self.assertIsNone(self.image_of(cur, STUDIO))

    def test_an_empty_value_reads_as_no_image(self):
        with self.conn.cursor() as cur:
            self.record(cur, {**FULL_MAP, "grafana": ""})
            self.assertIsNone(self.image_of(cur, GRAFANA))

    def test_a_row_the_chart_does_not_manage_is_left_alone(self):
        with self.conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO public.directory_services
                       (id, service_name, service_type, endpoint_url, status, exposure, image)
                VALUES ('0d1ec700-0000-4000-8000-000000000001', 'Registered By Something Else',
                        'GRAPHICAL_UI', 'http://elsewhere.test', 'UNKNOWN', 'NETWORK',
                        'example/elsewhere:9.9.9')
                """
            )
            self.record(cur, {})
            self.assertEqual(self.image_of(cur, "0d1ec700-0000-4000-8000-000000000001"),
                             "example/elsewhere:9.9.9")

    def test_no_api_role_can_call_it(self):
        with self.conn.cursor() as cur:
            for role in ("anon", "authenticated", "service_role"):
                cur.execute(
                    "SELECT has_function_privilege(%s, 'public.record_directory_images(jsonb)', 'EXECUTE')",
                    (role,),
                )
                self.assertFalse(cur.fetchone()[0], f"{role} can execute record_directory_images()")

    def test_a_signed_in_user_reads_the_column(self):
        # The page reads it through PostgREST as `authenticated`, under the table's existing
        # SELECT policy.
        with self.conn.cursor() as cur:
            self.record(cur, FULL_MAP)
            cur.execute("SET LOCAL ROLE authenticated")
            cur.execute("SELECT image FROM public.directory_services WHERE id = %s", (GRAFANA,))
            self.assertEqual(cur.fetchone()[0], "grafana/grafana:13.2.0")


NODE_RED = "f1111111-0000-0000-0000-000000000003"
NODE_RED_NAME = "Node-RED (Host-Run Gateways)"


class TestTheNodeRedEntry(unittest.TestCase):
    """The seeded Node-RED row names what it runs: the host-run gateways, not a simulator."""

    def test_the_seed_carries_its_name(self):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT service_name FROM public.directory_services WHERE id = %s", (NODE_RED,))
                self.assertEqual(cur.fetchone()[0], NODE_RED_NAME)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()

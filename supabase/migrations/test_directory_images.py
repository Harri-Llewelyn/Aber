"""
The Directory's Version column, its known-CVE badge, and the name of its Node-RED entry.

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

`record_directory_image_scans()` (0180) then writes the release's scan summary beside each image,
matched on the exact reference, so an overridden tag reads "not scanned" rather than zero.

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
    "mosquitto": "eclipse-mosquitto:2.1.2-alpine",
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


def scan(critical, high, upstream=None):
    entry = {
        "critical": critical,
        "high": high,
        "scanned_at": "2026-10-02T07:12:40.118Z",
        "vulnerability_db_at": "2026-10-01T18:41:02.000Z",
    }
    if upstream:
        entry["upstream"] = upstream
    return entry


# A release's files/image-scans.json, as scripts/image-scan-summary.mjs writes it.
SUMMARY = {
    "release": "0.1.0",
    "scanner": "Trivy 0.74.0",
    "images": {
        "grafana/grafana:13.2.0": scan(0, 3),
        "gitea/gitea:1.27.3": scan(1, 2),
        "ghcr.io/harri-llewelyn/aber/ingestion:0.1.0": scan(0, 0),
        "ghcr.io/harri-llewelyn/aber/node-red:0.1.0": scan(0, 0, upstream="5.0.7"),
    },
}

SCAN_COLUMNS = ("image_fixable_critical", "image_fixable_high", "image_scanned_at",
                "image_vulnerability_db_at", "upstream_version")


class TestDirectoryImageScans(unittest.TestCase):
    """
    `record_directory_image_scans()` (0180) writes the release's known-CVE summary beside each
    row's image, matching the exact reference. A row whose reference the release did not scan has
    no scan at all, so the page says "not scanned" rather than showing a zero nobody measured.
    """

    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()
        cls.conn.autocommit = False

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def tearDown(self):
        self.conn.rollback()

    def record(self, cur, summary, images=FULL_MAP):
        cur.execute("SELECT public.record_directory_images(%s::jsonb)", (json.dumps(images),))
        cur.execute("SELECT public.record_directory_image_scans(%s::jsonb)", (json.dumps(summary),))
        return cur.fetchone()[0]

    def scan_of(self, cur, row_id):
        cur.execute(
            "SELECT image_fixable_critical, image_fixable_high, image_scanned_at,"
            "       image_vulnerability_db_at, upstream_version"
            "  FROM public.directory_services WHERE id = %s",
            (row_id,),
        )
        return dict(zip(SCAN_COLUMNS, cur.fetchone()))

    def test_a_scanned_image_carries_its_counts_and_dates(self):
        with self.conn.cursor() as cur:
            self.record(cur, SUMMARY)
            got = self.scan_of(cur, GRAFANA)
            self.assertEqual((got["image_fixable_critical"], got["image_fixable_high"]), (0, 3))
            self.assertEqual(got["image_scanned_at"].isoformat(), "2026-10-02T07:12:40.118000+00:00")
            self.assertEqual(got["image_vulnerability_db_at"].isoformat(), "2026-10-01T18:41:02+00:00")
            self.assertIsNone(got["upstream_version"])
            self.assertEqual(self.scan_of(cur, FORGE)["image_fixable_critical"], 1)
            for row in INGESTION_ROWS:
                self.assertEqual(self.scan_of(cur, row)["image_fixable_high"], 0)

    def test_an_image_aber_builds_carries_its_upstream_version(self):
        with self.conn.cursor() as cur:
            self.record(cur, SUMMARY)
            self.assertEqual(self.scan_of(cur, NODE_RED)["upstream_version"], "5.0.7")

    def test_an_overridden_tag_reads_as_not_scanned_rather_than_zero(self):
        with self.conn.cursor() as cur:
            self.record(cur, SUMMARY)
            hotfix = {**FULL_MAP, "grafana": "grafana/grafana:13.2.0-hotfix.1"}
            self.assertEqual(self.record(cur, SUMMARY, images=hotfix), 1)
            self.assertEqual(set(self.scan_of(cur, GRAFANA).values()), {None})

    def test_an_image_the_summary_does_not_name_has_no_scan(self):
        with self.conn.cursor() as cur:
            self.record(cur, SUMMARY)
            self.assertEqual(set(self.scan_of(cur, STUDIO).values()), {None})

    def test_a_replay_of_the_same_summary_changes_nothing(self):
        with self.conn.cursor() as cur:
            self.record(cur, SUMMARY)
            self.assertEqual(self.record(cur, SUMMARY), 0)

    def test_a_chart_without_a_summary_clears_every_scan(self):
        # db-init passes {} when the chart carries no files/image-scans.json, as on a checkout.
        with self.conn.cursor() as cur:
            self.record(cur, SUMMARY)
            self.assertGreater(self.record(cur, {}), 0)
            cur.execute(
                "SELECT count(*) FROM public.directory_services"
                " WHERE image_scanned_at IS NOT NULL OR upstream_version IS NOT NULL"
            )
            self.assertEqual(cur.fetchone()[0], 0)

    def test_an_entry_missing_its_date_is_not_a_scan(self):
        with self.conn.cursor() as cur:
            undated = {k: v for k, v in scan(0, 0).items() if k != "scanned_at"}
            self.record(cur, {"images": {**SUMMARY["images"], "grafana/grafana:13.2.0": undated}})
            got = self.scan_of(cur, GRAFANA)
            self.assertIsNone(got["image_fixable_high"])
            self.assertIsNone(got["image_scanned_at"])

    def test_no_api_role_can_call_it(self):
        with self.conn.cursor() as cur:
            for role in ("anon", "authenticated", "service_role"):
                cur.execute(
                    "SELECT has_function_privilege(%s, 'public.record_directory_image_scans(jsonb)', 'EXECUTE')",
                    (role,),
                )
                self.assertFalse(cur.fetchone()[0], f"{role} can execute record_directory_image_scans()")

    def test_a_signed_in_user_reads_the_scan(self):
        with self.conn.cursor() as cur:
            self.record(cur, SUMMARY)
            cur.execute("SET LOCAL ROLE authenticated")
            cur.execute(
                "SELECT image_fixable_high, image_scanned_at IS NOT NULL"
                " FROM public.directory_services WHERE id = %s",
                (GRAFANA,),
            )
            self.assertEqual(cur.fetchone(), (3, True))


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

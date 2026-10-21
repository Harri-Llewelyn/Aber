"""
A shadow gateway holds no health (0186): the Playback gateway carries none after the chain, the
migration clears what earlier replays left on it and nothing else, and the daemon's role reads the
flag it tests before recording health.

    python supabase/migrations/test_a_shadow_gateway_holds_no_health.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

A replay republishes a recorded appliance's node messages as the Playback gateway, and the daemon
used to record their health as its own: another machine's disk and agent version on the Fleet Health
dashboard, a CA date that fired Gateway CA Expiring, and a FLOW_DEPLOYED audit row for a deployment
that never happened. The daemon now skips a gateway with `is_shadow` (ingestion/ingestion.py);
this holds what the database owes that fix.

Every test rolls back: writes to `gateways` fire the audit-trail trigger, and that table is
append-only to every application role.
"""
import glob
import json
import os
import re
import unittest
import uuid

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATION = glob.glob(os.path.join(HERE, "0186_*.sql"))[0]
DAEMON = os.path.join(HERE, "..", "..", "ingestion", "ingestion.py")

# The Service_Ingestor machine principal (0046): the identity the daemon's token names.
INGESTION_PRINCIPAL = "b0000000-0000-4000-8000-000000000002"

# The eight columns ingest_record_gateway_health() writes, in the order SELECT_HEALTH reads them.
NO_HEALTH = (None,) * 8
SELECT_HEALTH = (
    "SELECT health_reported_at, uptime_seconds, load_1m, mem_available_bytes, disk_free_bytes, "
    "cert_expires_at, flow_hash, agent_version FROM public.gateways WHERE id = %s;"
)
# What an appliance's replayed heartbeats leave on the row, one value in each column.
REPLAY_LEFT_HEALTH = (
    "UPDATE public.gateways SET health_reported_at = now(), uptime_seconds = 4210, "
    "load_1m = 0.42, mem_available_bytes = 1073741824, disk_free_bytes = 52428800, "
    "cert_expires_at = now() + interval '20 days', flow_hash = repeat('a', 64), "
    "agent_version = '1.4.0' WHERE id = %s;"
)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class ShadowHealth(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute(
            "SELECT id FROM public.gateways WHERE is_shadow AND NOT is_archived LIMIT 1;")
        row = self.cur.fetchone()
        if row is None:
            self.skipTest("no live shadow gateway is seeded")
        self.playback = row[0]
        self.cur.execute(
            "SELECT set_config('request.jwt.claims', %s, true)",
            (json.dumps({"sub": INGESTION_PRINCIPAL, "role": "authenticated"}),),
        )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def health(self, gateway_id):
        self.cur.execute(SELECT_HEALTH, (gateway_id,))
        return self.cur.fetchone()

    def replay_left_its_health(self, gateway_id):
        self.cur.execute(REPLAY_LEFT_HEALTH, (gateway_id,))
        self.assertNotIn(None, self.health(gateway_id), "the fixture left a column empty")

    def run_migration(self):
        with open(MIGRATION, encoding="utf-8", newline="") as f:
            self.cur.execute(f.read())

    def audit_rows(self, gateway_id, action):
        self.cur.execute(
            "SELECT count(*) FROM public.audit_trail "
            "WHERE entity_type = 'gateways' AND entity_id = %s AND action = %s;",
            (gateway_id, action))
        return self.cur.fetchone()[0]


class TheChainLeavesNoHealth(ShadowHealth):
    def test_no_shadow_gateway_holds_a_reading(self):
        self.cur.execute("SELECT id, name FROM public.gateways WHERE is_shadow;")
        for gateway_id, name in self.cur.fetchall():
            self.assertEqual(self.health(gateway_id), NO_HEALTH, f"{name} holds another machine's health")


class TheMigrationClearsWhatAReplayLeft(ShadowHealth):
    def test_a_shadow_gateways_replayed_health_is_cleared(self):
        self.replay_left_its_health(self.playback)
        self.run_migration()
        self.assertEqual(self.health(self.playback), NO_HEALTH)

    def test_an_ordinary_gateways_health_is_left_alone(self):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment) "
            "VALUES (%s, %s, 'cell', 'remote');", (gid, f"Test_Health_GW_{gid[:8]}"))
        self.replay_left_its_health(gid)
        before = self.health(gid)
        self.run_migration()
        self.assertEqual(self.health(gid), before)

    def test_a_second_run_changes_nothing(self):
        self.replay_left_its_health(self.playback)
        self.run_migration()
        written = self.audit_rows(self.playback, "UPDATE")
        self.run_migration()
        self.assertEqual(self.audit_rows(self.playback, "UPDATE"), written,
                         "the second boot rewrote a row that was already clear")

    def test_a_recorded_flow_deployed_row_stays(self):
        # audit_trail is append-only to every role, the migration's included: it only clears the
        # columns. The row is written the way the daemon's old call did, and counted on top of
        # those a used database already holds.
        before = self.audit_rows(self.playback, "FLOW_DEPLOYED")
        self.cur.execute(
            "SELECT public.ingest_record_gateway_health(%s::uuid, 'ONLINE', now(), %s::jsonb);",
            (self.playback, json.dumps({"flow_hash": "b" * 64})))
        self.assertEqual(self.audit_rows(self.playback, "FLOW_DEPLOYED"), before + 1)
        self.run_migration()
        self.assertEqual(self.audit_rows(self.playback, "FLOW_DEPLOYED"), before + 1)


class TheDaemonsHeartbeat(ShadowHealth):
    def test_a_heartbeat_with_no_health_records_none_and_no_flow_deployed_row(self):
        """What the daemon now sends for a shadow gateway: p_health NULL."""
        before = self.audit_rows(self.playback, "FLOW_DEPLOYED")
        self.cur.execute(
            "SELECT public.ingest_record_gateway_health(%s::uuid, 'ONLINE', now(), NULL);",
            (self.playback,))
        self.cur.execute("SELECT status, last_heartbeat IS NOT NULL FROM public.gateways WHERE id = %s;",
                         (self.playback,))
        self.assertEqual(self.cur.fetchone(), ("ONLINE", True), "the heartbeat itself was not written")
        self.assertEqual(self.health(self.playback), NO_HEALTH)
        self.assertEqual(self.audit_rows(self.playback, "FLOW_DEPLOYED"), before)

    def test_the_daemons_role_reads_the_flag_with_the_rest_of_the_row(self):
        """The directory refresher and the per-gateway lookup select _GATEWAY_COLUMNS as this role."""
        with open(DAEMON, encoding="utf-8") as f:
            columns = re.search(r'^_GATEWAY_COLUMNS = "([^"]+)"', f.read(), re.M).group(1).split(",")
        self.assertIn("is_shadow", columns)
        for column in columns:
            self.cur.execute(
                "SELECT has_column_privilege('authenticated', 'public.gateways', %s, 'SELECT');",
                (column,))
            self.assertTrue(self.cur.fetchone()[0], f"the daemon's role cannot read gateways.{column}")
        # Row security as well as the column grant: the shadow row must be visible to that role.
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute("SELECT is_shadow FROM public.gateways WHERE id = %s;", (self.playback,))
        self.assertEqual(self.cur.fetchone(), (True,))


if __name__ == "__main__":
    unittest.main(verbosity=2)

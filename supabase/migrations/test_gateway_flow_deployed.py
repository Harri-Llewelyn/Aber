"""
PostgreSQL integration tests for `0100_a_deployed_flow_is_an_event_and_a_reading_is_not.sql`.

TWO HALVES, AND THE FIRST IS THE ONE THAT WAS SILENTLY WRONG.

  1. A READING IS NOT AN EVENT. A Remote gateway rewrites six health columns on every
     heartbeat, and the audit trigger compared whole rows minus `last_heartbeat` alone -- so every
     heartbeat that carried health appended an UPDATE row to an append-only table, 2,880 a day per
     appliance. The trigger now subtracts everything `audit_telemetry_columns()` names.

  2. A DEPLOYED FLOW IS. When an appliance reports a different flow hash, the health gate writes
     exactly one FLOW_DEPLOYED row: the digest before and after, the identity at the time, what the
     forge's main held at that moment, pinned to actor 'ingestion' with no user. The same hash again
     writes nothing.

Every test runs inside one transaction and rolls back, which is what makes this safe against a
live database: `digital_thread` is append-only to every application role.

Runs against the Supabase database, not the historian:

    python supabase/migrations/test_gateway_flow_deployed.py
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

# The Service_Ingestor machine principal (0046), pinned for the reason test_ingestion_rejection_rpc
# gives: one identity may call the gate, and a test that looked it up would agree with whatever the
# schema currently says.
INGESTION_PRINCIPAL = "b0000000-0000-4000-8000-000000000002"

HASH_A = "a" * 64
HASH_B = "b" * 64


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class FlowDeployedTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('public.audit_telemetry_columns()')")
                if not cur.fetchone()[0]:
                    raise RuntimeError("audit_telemetry_columns() is not defined -- 0100 has not been applied")
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        # A gateway of this test's own, inside the transaction that rolls back. The INSERT writes
        # its own audit row, which the counts below exclude by action. Already ONLINE, because a
        # status transition IS an event and the heartbeats below assert their own writes only.
        self.cur.execute(
            "INSERT INTO public.gateways (name, deployment, status) VALUES ('Flow_Deployed_Probe', 'remote', 'ONLINE') RETURNING id"
        )
        self.gateway_id = self.cur.fetchone()[0]
        # The Service_Ingestor claim, which require_ingestion_caller() tests through auth.uid().
        self.cur.execute(
            "SELECT set_config('request.jwt.claims', %s, true)",
            (json.dumps({"sub": INGESTION_PRINCIPAL, "role": "authenticated"}),),
        )

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()
        self.conn.close()

    def heartbeat(self, health):
        self.cur.execute(
            "SELECT public.ingest_record_gateway_health(%s::uuid, 'ONLINE', now(), %s::jsonb)",
            (self.gateway_id, json.dumps(health)),
        )
        return self.cur.fetchone()[0]

    def rows(self, action):
        self.cur.execute(
            "SELECT old_data, new_data, changed_by, actor_source "
            "  FROM public.digital_thread WHERE entity_type = 'gateways' AND entity_id = %s AND action = %s "
            " ORDER BY recorded_at, id",
            (self.gateway_id, action),
        )
        return [dict(zip(("old_data", "new_data", "changed_by", "actor_source"), r)) for r in self.cur.fetchall()]

    # -- a reading is not an event ---------------------------------------------------------------

    def test_a_heartbeat_that_moves_only_the_readings_writes_no_audit_row(self):
        self.assertTrue(self.heartbeat({"uptime_seconds": 30, "load_1m": 0.5, "disk_free_bytes": 10 ** 9}))
        self.assertTrue(self.heartbeat({"uptime_seconds": 60, "load_1m": 0.7, "disk_free_bytes": 10 ** 9 - 1}))
        self.assertEqual(self.rows("UPDATE"), [], "a heartbeat's readings were recorded as an event")

    def test_the_telemetry_columns_are_the_ones_the_gate_writes(self):
        self.cur.execute("SELECT public.audit_telemetry_columns()")
        columns = set(self.cur.fetchone()[0])
        for expected in ("last_heartbeat", "health_reported_at", "uptime_seconds", "load_1m",
                         "mem_available_bytes", "disk_free_bytes", "flow_hash"):
            self.assertIn(expected, columns)
        # These two stay in the generic comparison: a re-enrolment or an upgrade is an event.
        self.assertNotIn("cert_expires_at", columns)
        self.assertNotIn("agent_version", columns)

    def test_an_upgraded_bundle_is_still_an_event(self):
        self.heartbeat({"uptime_seconds": 30, "agent_version": "1.0.0"})
        self.heartbeat({"uptime_seconds": 60, "agent_version": "1.1.0"})
        updates = self.rows("UPDATE")
        self.assertEqual(len(updates), 2, updates)
        self.assertEqual(updates[-1]["old_data"]["agent_version"], "1.0.0")
        self.assertEqual(updates[-1]["new_data"]["agent_version"], "1.1.0")

    # -- a deployed flow is -----------------------------------------------------------------------

    def test_a_different_flow_hash_writes_one_flow_deployed_row(self):
        self.heartbeat({"uptime_seconds": 30, "flow_hash": HASH_A})
        self.heartbeat({"uptime_seconds": 60, "flow_hash": HASH_A})
        deployed = self.rows("FLOW_DEPLOYED")
        self.assertEqual(len(deployed), 1, deployed)
        self.assertIsNone(deployed[0]["old_data"]["flow_hash"], "the first report has no previous flow")
        self.assertEqual(deployed[0]["new_data"]["flow_hash"], HASH_A)
        self.assertEqual(deployed[0]["new_data"]["name"], "Flow_Deployed_Probe")
        self.assertRegex(deployed[0]["new_data"]["sparkplug_id"], r"^gwy[0-9a-f]{21}$")
        # No generic UPDATE row for it either: flow_hash is a telemetry column.
        self.assertEqual(self.rows("UPDATE"), [])

    def test_the_row_is_the_daemons_and_names_no_user(self):
        self.heartbeat({"flow_hash": HASH_A})
        row = self.rows("FLOW_DEPLOYED")[0]
        self.assertEqual(row["actor_source"], "ingestion")
        self.assertIsNone(row["changed_by"])

    def test_a_second_deploy_carries_the_previous_digest(self):
        self.heartbeat({"flow_hash": HASH_A})
        self.heartbeat({"flow_hash": HASH_B})
        deployed = self.rows("FLOW_DEPLOYED")
        self.assertEqual(len(deployed), 2, deployed)
        self.assertEqual(deployed[1]["old_data"]["flow_hash"], HASH_A)
        self.assertEqual(deployed[1]["new_data"]["flow_hash"], HASH_B)

    def test_the_row_says_whether_the_appliance_matched_main(self):
        self.cur.execute(
            "UPDATE public.gateways SET forge_head_sha = %s, forge_head_flow_sha256 = %s WHERE id = %s",
            ("c" * 40, HASH_A, self.gateway_id),
        )
        self.heartbeat({"flow_hash": HASH_B})
        self.heartbeat({"flow_hash": HASH_A})
        deployed = self.rows("FLOW_DEPLOYED")
        self.assertEqual(len(deployed), 2, deployed)
        self.assertFalse(deployed[0]["new_data"]["matches_main"])
        self.assertTrue(deployed[1]["new_data"]["matches_main"])
        self.assertEqual(deployed[1]["new_data"]["forge_head_sha"], "c" * 40)

    def test_a_heartbeat_without_health_writes_nothing(self):
        self.cur.execute(
            "SELECT public.ingest_record_gateway_health(%s::uuid, 'ONLINE', now(), NULL)", (self.gateway_id,)
        )
        self.assertEqual(self.rows("FLOW_DEPLOYED"), [])
        self.assertEqual(self.rows("UPDATE"), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""
A Grafana alert keeps the uid of its rule, its labels and its values (0220).

    python supabase/migrations/test_an_alert_keeps_its_rule_labels_and_values.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: platform_alerts carries rule_uid (text), labels and values (jsonb), all three
nullable with no default, so a row written before 0220 reads on with NULLs. The webhook's upsert on
(fingerprint, starts_at) writes them and a resolve updates the same occurrence. A signed-in reader
reads them under the table's RLS and writes none; anon reads none. platform_alerts_active keeps
0001's column list, since 0001's replay cannot drop a column a later file adds.

EVERY TEST ROLLS BACK. platform_alerts is in the realtime publication: a committed row reaches every
connected dashboard as a firing alert.
"""
import json
import os
import unittest

import psycopg2
import psycopg2.errors
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

OPERATOR_ID = "a0d17070-0000-4000-8000-0000000220a1"
ADMIN_ID = "a0d17070-0000-4000-8000-0000000220a2"
PRINCIPAL_ID = "a0d17070-0000-4000-8000-0000000220d1"

UID = "aber-gateway-clock-skew"
LABELS = {
    "alertname": "Gateway Clock Skew", "grafana_folder": "Aber - Platform Infrastructure",
    "severity": "warning", "entity_type": "gateway", "sparkplug_id": "gw-0220-test", "edge_node": "gw-0220-test",
}
VALUES = {"A": 74.5, "B": 74.5, "C": 1}

# The view's columns as 0001 states them.
ACTIVE_VIEW_COLUMNS = [
    "id", "fingerprint", "entity_type", "entity_id", "sparkplug_id", "alert_name", "severity",
    "status", "summary", "starts_at", "ends_at", "recorded_at",
]

# What the webhook upserts, as PostgREST's merge-duplicates writes it: every column it sends is
# updated on a conflict with the occurrence key.
UPSERT = """
    INSERT INTO public.platform_alerts
        (fingerprint, entity_type, entity_id, sparkplug_id, alert_name, severity, status, summary,
         starts_at, ends_at, rule_uid, labels, "values")
    VALUES (%(fingerprint)s, %(entity_type)s, %(entity_id)s, %(sparkplug_id)s, %(alert_name)s,
            'warning', %(status)s, 'summary', %(starts_at)s, %(ends_at)s, %(rule_uid)s, %(labels)s,
            %(values)s)
    ON CONFLICT (fingerprint, starts_at) DO UPDATE SET
        entity_type = EXCLUDED.entity_type, entity_id = EXCLUDED.entity_id,
        sparkplug_id = EXCLUDED.sparkplug_id, alert_name = EXCLUDED.alert_name,
        severity = EXCLUDED.severity, status = EXCLUDED.status, summary = EXCLUDED.summary,
        ends_at = EXCLUDED.ends_at, rule_uid = EXCLUDED.rule_uid, labels = EXCLUDED.labels,
        "values" = EXCLUDED."values"
    RETURNING id
"""


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class AlertColumnsBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute(
            "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'"
            " AND table_name = 'platform_alerts' AND column_name = 'rule_uid';"
        )
        if self.cur.fetchone()[0] == 0:
            self.skipTest("0220 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in ((OPERATOR_ID, "Operator"), (ADMIN_ID, "Administrator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@alert-columns.test"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def upsert(self, fingerprint="fp-0220", starts_at="2026-10-28T09:00:00Z", status="firing",
               ends_at=None, rule_uid=UID, labels=LABELS, values=VALUES, entity_type="gateway",
               entity_id=None, sparkplug_id="gw-0220-test", alert_name="Gateway Clock Skew"):
        self.cur.execute(UPSERT, {
            "fingerprint": fingerprint, "entity_type": entity_type, "entity_id": entity_id,
            "sparkplug_id": sparkplug_id, "alert_name": alert_name, "status": status,
            "starts_at": starts_at, "ends_at": ends_at, "rule_uid": rule_uid,
            "labels": None if labels is None else Json(labels),
            "values": None if values is None else Json(values),
        })
        return self.cur.fetchone()[0]

    def as_reader(self, user_id, sql, args=(), role="authenticated"):
        """Run `sql` as PostgREST would for a token naming `user_id`. A refusal rolls back to the
        savepoint, so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT alert_columns_call;")
        try:
            self.cur.execute("SELECT set_config('role', %s, true);", (role,))
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": role}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT alert_columns_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT alert_columns_call;")
        return rows


class TheColumns(AlertColumnsBase):
    def test_three_nullable_columns_with_no_default(self):
        self.cur.execute(
            "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns"
            " WHERE table_schema = 'public' AND table_name = 'platform_alerts'"
            "   AND column_name IN ('rule_uid', 'labels', 'values') ORDER BY column_name;"
        )
        self.assertEqual(self.cur.fetchall(), [
            ("labels", "jsonb", "YES", None),
            ("rule_uid", "text", "YES", None),
            ("values", "jsonb", "YES", None),
        ])

    def test_each_column_is_described(self):
        for column in ("rule_uid", "labels", "values"):
            with self.subTest(column=column):
                self.cur.execute(
                    "SELECT col_description('public.platform_alerts'::regclass, attnum)"
                    "  FROM pg_attribute WHERE attrelid = 'public.platform_alerts'::regclass AND attname = %s;",
                    (column,),
                )
                self.assertIn("(0220)", self.cur.fetchone()[0] or "")


class WhatTheWebhookWrites(AlertColumnsBase):
    def test_a_firing_alert_keeps_its_rule_uid_labels_and_values(self):
        row_id = self.upsert()
        self.cur.execute('SELECT rule_uid, labels, "values" FROM public.platform_alerts WHERE id = %s;', (row_id,))
        self.assertEqual(self.cur.fetchone(), (UID, LABELS, VALUES))

    def test_the_resolve_updates_the_same_occurrence(self):
        first = self.upsert()
        resolved_values = {"A": 12.0, "B": 12.0, "C": 0}
        second = self.upsert(status="resolved", ends_at="2026-10-28T09:30:00Z", values=resolved_values)
        self.assertEqual(first, second)
        self.cur.execute(
            'SELECT count(*), max(status), max(rule_uid), max("values"::text)::jsonb'
            "  FROM public.platform_alerts WHERE fingerprint = 'fp-0220';"
        )
        self.assertEqual(self.cur.fetchone(), (1, "resolved", UID, resolved_values))

    def test_a_row_from_before_reads_on_with_nulls_and_its_resolve_fills_them(self):
        # The pre-0220 insert names none of the three columns.
        self.cur.execute(
            "INSERT INTO public.platform_alerts (fingerprint, entity_type, sparkplug_id, alert_name, status, starts_at)"
            " VALUES ('fp-0220', 'gateway', 'gw-0220-test', 'Gateway Clock Skew', 'firing', '2026-10-28T09:00:00Z')"
            " RETURNING id;"
        )
        old_id = self.cur.fetchone()[0]
        self.cur.execute('SELECT rule_uid, labels, "values" FROM public.platform_alerts WHERE id = %s;', (old_id,))
        self.assertEqual(self.cur.fetchone(), (None, None, None))
        self.cur.execute("SELECT count(*) FROM public.platform_alerts_active WHERE id = %s;", (old_id,))
        self.assertEqual(self.cur.fetchone()[0], 1)

        self.assertEqual(self.upsert(status="resolved", ends_at="2026-10-28T09:30:00Z"), old_id)
        self.cur.execute("SELECT status, rule_uid FROM public.platform_alerts WHERE id = %s;", (old_id,))
        self.assertEqual(self.cur.fetchone(), ("resolved", UID))

    def test_a_label_and_a_value_can_be_queried(self):
        self.upsert()
        self.cur.execute(
            "SELECT labels->>'edge_node', (\"values\"->>'B')::numeric FROM public.platform_alerts"
            " WHERE labels @> %s;",
            (Json({"entity_type": "gateway", "edge_node": "gw-0220-test"}),),
        )
        self.assertEqual(self.cur.fetchall(), [("gw-0220-test", 74.5)])

    def test_the_key_is_still_the_occurrence(self):
        # A second rule_uid on the same (fingerprint, starts_at) is the same occurrence, not a new row.
        self.upsert()
        self.upsert(rule_uid="aber-other")
        self.cur.execute("SELECT count(*) FROM public.platform_alerts WHERE fingerprint = 'fp-0220';")
        self.assertEqual(self.cur.fetchone()[0], 1)


class WhoReadsThem(AlertColumnsBase):
    def test_a_signed_in_reader_reads_all_three(self):
        row_id = self.upsert()
        rows = self.as_reader(OPERATOR_ID, 'SELECT rule_uid, labels, "values" FROM public.platform_alerts WHERE id = %s;', (row_id,))
        self.assertEqual(rows, [(UID, LABELS, VALUES)])

    def test_a_signed_in_reader_writes_none(self):
        row_id = self.upsert()
        for sql in ("UPDATE public.platform_alerts SET rule_uid = 'x' WHERE id = %s;",
                    "UPDATE public.platform_alerts SET labels = '{}' WHERE id = %s;",
                    'UPDATE public.platform_alerts SET "values" = \'{}\' WHERE id = %s;'):
            with self.subTest(sql=sql), self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                self.as_reader(ADMIN_ID, sql, (row_id,))

    def test_anon_reads_none(self):
        self.upsert()
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.as_reader(None, "SELECT rule_uid FROM public.platform_alerts;", role="anon")

    def test_a_machine_identity_alert_and_its_labels_stay_with_administrators(self):
        row_id = self.upsert(fingerprint="fp-0220-token", entity_type="service_identity", entity_id=PRINCIPAL_ID,
                             sparkplug_id=None, alert_name="Service Token Expiring", rule_uid="aber-service-token-expiring",
                             labels={"alertname": "Service Token Expiring", "principal_id": PRINCIPAL_ID})
        sql = "SELECT rule_uid, labels->>'principal_id' FROM public.platform_alerts WHERE id = %s;"
        self.assertEqual(self.as_reader(OPERATOR_ID, sql, (row_id,)), [])
        self.assertEqual(self.as_reader(ADMIN_ID, sql, (row_id,)), [("aber-service-token-expiring", PRINCIPAL_ID)])


class TheActiveView(AlertColumnsBase):
    def test_it_keeps_the_columns_0001_states(self):
        # 0001 replays first on every boot. Its CREATE OR REPLACE VIEW cannot drop a column, so a
        # later file that widened the view would fail the second boot; the dashboard reads rule_uid
        # from the table by id instead.
        self.cur.execute(
            "SELECT attname FROM pg_attribute WHERE attrelid = 'public.platform_alerts_active'::regclass"
            "   AND attnum > 0 AND NOT attisdropped ORDER BY attnum;"
        )
        self.assertEqual([r[0] for r in self.cur.fetchall()], ACTIVE_VIEW_COLUMNS)

    def test_a_firing_row_s_uid_is_read_from_the_table_by_its_id(self):
        row_id = self.upsert()
        rows = self.as_reader(
            OPERATOR_ID,
            "SELECT a.id, t.rule_uid FROM public.platform_alerts_active a"
            "  JOIN public.platform_alerts t ON t.id = a.id WHERE a.fingerprint = 'fp-0220';",
        )
        self.assertEqual(rows, [(row_id, UID)])


if __name__ == "__main__":
    unittest.main(verbosity=2)

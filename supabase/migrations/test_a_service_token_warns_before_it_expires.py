"""
A service token warns before it expires (0204).

    python supabase/migrations/test_a_service_token_warns_before_it_expires.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: the rule "Service Token Expiring" runs its own query, read out of the alert rules
file, and finds a 7-, 30- and 90-day token inside its window and not before it. A revoked token, a
withdrawn identity, an identity that is gone and an expired token give no row. grafana_reader reads
the view and nothing behind it. platform_alerts takes a service_identity alert, a replay of 0001
keeps the two widened CHECKs over one, and only an Administrator reads it.

EVERY TEST ROLLS BACK. Each mints its tokens as TOKEN_MINTED audit rows written with the issue time
it needs, because record_service_token_issued() stamps the time it runs.
"""
import json
import os
import re
import unittest
import uuid
from pathlib import Path

import psycopg2
from psycopg2 import errors, sql

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = Path(__file__).resolve().parents[2]
MIGRATIONS = Path(__file__).resolve().parent
RULES = REPO / "grafana" / "provisioning" / "alerting" / "alert-rules.yaml"

ADMIN_ID = "5e000000-0204-4000-8000-0000000000ad"
MANAGER_ID = "5e000000-0204-4000-8000-0000000000b2"
OPERATOR_ID = "5e000000-0204-4000-8000-0000000000c3"
AUDITOR_ID = "5e000000-0204-4000-8000-0000000000d4"
IDENTITY_ID = "5e000000-0204-4000-8000-0000000000e5"
READ_ONLY_CLIENT = "b0000000-0000-4000-8000-000000000001"
SERVICE_INGESTOR = "b0000000-0000-4000-8000-000000000002"


def get_connection(user=DB_USER, password=DB_PASSWORD):
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=user, password=password)
    conn.autocommit = False
    return conn


def rule_query():
    """The rawSql of aber-service-token-expiring, as Grafana sends it."""
    text = RULES.read_text(encoding="utf-8")
    rule = text[text.index("uid: aber-service-token-expiring"):]
    rule = rule[:rule.index("\n      - uid: ")]
    block = re.search(r"\n( +)rawSql: \|\n((?:\1  .*\n)+)", rule)
    if not block:
        raise AssertionError("aber-service-token-expiring has no rawSql block in the rules file")
    return "\n".join(line[len(block.group(1)) + 2:] for line in block.group(2).splitlines())


def reader_password():
    """The password db-init gives grafana_reader: the environment's, or the one the test chain uses."""
    if os.getenv("BI_READER_PASSWORD"):
        return os.environ["BI_READER_PASSWORD"]
    found = re.search(r"bi_reader_password: '([^']+)'",
                      (REPO / "scripts" / "migration-vars.mjs").read_text(encoding="utf-8"))
    return found.group(1) if found else None


class ServiceTokenBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('public.service_token_health') IS NOT NULL;")
                if not cur.fetchone()[0]:
                    raise unittest.SkipTest("0204 is not applied to this database")
        finally:
            conn.rollback()
            conn.close()
        cls.query = rule_query()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        people = {ADMIN_ID: "Administrator", MANAGER_ID: "Shopfloor_Manager",
                  OPERATOR_ID: "Operator", AUDITOR_ID: "Auditor"}
        # A person has an email and a password; a machine identity has neither.
        for user_id in people:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password) VALUES (%s, %s, %s)"
                " ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@service-token.test", "not-a-real-hash"),
            )
        self.cur.execute("INSERT INTO auth.users (id) VALUES (%s) ON CONFLICT (id) DO NOTHING;", (IDENTITY_ID,))
        self.cur.execute(
            "INSERT INTO public.machine_principals (principal_id, name, purpose) VALUES (%s, %s, %s)"
            " ON CONFLICT (principal_id) DO NOTHING;",
            (IDENTITY_ID, "Line 4 report", "service-token suite"),
        )
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in people.items():
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def mint(self, days, age, principal=IDENTITY_ID):
        """A TOKEN_MINTED row for a `days`-day token issued `age` ago (an SQL interval). Its jti."""
        jti = f"t204-{uuid.uuid4().hex[:12]}"
        self.cur.execute(
            "INSERT INTO public.audit_trail (entity_type, entity_id, action, old_data, new_data,"
            "                                actor_source, recorded_at)"
            " SELECT 'service_principals', %s, 'TOKEN_MINTED', NULL,"
            "        jsonb_build_object('jti', %s, 'issued_at', t, 'expires_at', t + make_interval(days => %s),"
            "                           'ttl_days', %s, 'roles', '[]'::jsonb),"
            "        'service', t"
            "   FROM (SELECT now() - %s::interval AS t) issued;",
            (principal, jti, days, days, age),
        )
        return jti

    def health(self, jti):
        self.cur.execute(
            "SELECT identity_name, renewal, warn_at, expires_at, expires_at - warn_at, remaining_seconds"
            "  FROM public.service_token_health WHERE jti = %s;", (jti,))
        return self.cur.fetchone()

    def firing(self):
        """The jtis the rule's own query returns now, each with its labels."""
        self.cur.execute(self.query)
        names = [d[0] for d in self.cur.description]
        return {row[names.index("jti")]: dict(zip(names, row)) for row in self.cur.fetchall()}

    def alert(self, entity_type="service_identity", entity_id=IDENTITY_ID, sparkplug_id=None):
        fingerprint = uuid.uuid4().hex
        self.cur.execute(
            "INSERT INTO public.platform_alerts (fingerprint, entity_type, entity_id, sparkplug_id,"
            "                                    alert_name, severity, status, summary, starts_at)"
            " VALUES (%s, %s, %s, %s, 'Service Token Expiring', 'warning', 'firing', 'suite', now());",
            (fingerprint, entity_type, entity_id, sparkplug_id),
        )
        return fingerprint

    def visible(self, user_id, relation, fingerprints):
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', (json.dumps({"sub": user_id}),))
        try:
            self.cur.execute(sql.SQL("SELECT fingerprint FROM public.{} WHERE fingerprint = ANY(%s);")
                             .format(sql.Identifier(relation)), (list(fingerprints),))
            return {r[0] for r in self.cur.fetchall()}
        finally:
            self.cur.execute("RESET ROLE;")


class TheWarnPoint(ServiceTokenBase):
    """7 days before expiry, or a quarter of the lifetime before it for a shorter token."""

    # Lifetime in days: the warning's lead, in hours.
    LEADS = {7: 42, 30: 7 * 24, 90: 7 * 24}

    def test_the_lead_is_seven_days_or_a_quarter_of_the_lifetime(self):
        for days, lead in self.LEADS.items():
            with self.subTest(days=days):
                self.cur.execute("SELECT make_interval(hours => %s);", (lead,))
                expected = self.cur.fetchone()[0]
                self.assertEqual(self.health(self.mint(days, "1 hour"))[4], expected)

    def test_it_fires_inside_the_window_and_not_before(self):
        for days, lead in self.LEADS.items():
            with self.subTest(days=days):
                # An hour either side of the warn point, counted from issue.
                before = self.mint(days, f"{days * 24 - lead - 1} hours")
                inside = self.mint(days, f"{days * 24 - lead + 1} hours")
                firing = self.firing()
                self.assertNotIn(before, firing)
                self.assertIn(inside, firing)

    def test_a_seven_day_token_does_not_warn_when_it_is_issued(self):
        self.assertNotIn(self.mint(7, "1 minute"), self.firing())

    def test_an_instance_carries_what_the_webhook_and_the_summary_need(self):
        jti = self.mint(30, "29 days")
        labels = self.firing()[jti]
        self.assertEqual(labels["identity"], "Line 4 report")
        self.assertEqual(labels["principal_id"], IDENTITY_ID)
        self.assertEqual(labels["renewal"], "access_control")
        self.assertRegex(labels["expires_at"], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$")
        self.assertGreater(labels["remaining_seconds"], 0)

    def test_a_pinned_identity_is_named_as_the_page_names_it(self):
        client = self.mint(30, "29 days", READ_ONLY_CLIENT)
        ingestor = self.mint(90, "89 days", SERVICE_INGESTOR)
        self.assertEqual(self.health(client)[:2], ("Read-only API client", "access_control"))
        self.assertEqual(self.health(ingestor)[:2], ("Service_Ingestor", "keys_rotate"))


class WhatGivesNoRow(ServiceTokenBase):

    def test_a_revoked_token(self):
        jti = self.mint(7, "6 days")
        self.cur.execute(
            "INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at)"
            " SELECT %s, %s, now() + interval '1 day';", (jti, IDENTITY_ID))
        self.assertIsNone(self.health(jti))
        self.assertNotIn(jti, self.firing())

    def test_a_withdrawn_identity(self):
        jti = self.mint(7, "6 days")
        self.cur.execute("INSERT INTO public.revoked_service_principals (principal_id) VALUES (%s);",
                         (IDENTITY_ID,))
        self.assertIsNone(self.health(jti))

    def test_an_identity_that_is_gone(self):
        gone = str(uuid.uuid4())
        self.assertIsNone(self.health(self.mint(7, "6 days", gone)))

    def test_an_expired_token(self):
        self.assertIsNone(self.health(self.mint(7, "7 days 1 minute")))
        self.assertIsNone(self.health(self.mint(90, "91 days")))

    def test_the_newest_record_of_a_jti_decides(self):
        # revoke_service_token() reads the newest TOKEN_MINTED row of a jti, and so does the view.
        jti = self.mint(30, "29 days")
        self.cur.execute(
            "INSERT INTO public.audit_trail (entity_type, entity_id, action, old_data, new_data, actor_source)"
            " VALUES ('service_principals', %s, 'TOKEN_MINTED', NULL,"
            "         jsonb_build_object('jti', %s, 'issued_at', now(), 'expires_at', now() + interval '30 days'),"
            "         'service');", (IDENTITY_ID, jti))
        self.assertNotIn(jti, self.firing())


class TheReader(ServiceTokenBase):

    def test_only_grafana_reader_and_the_service_role_read_it(self):
        self.cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader';")
        roles = ["service_role"] + (["grafana_reader"] if self.cur.fetchone() else [])
        for role in roles:
            self.cur.execute("SELECT has_table_privilege(%s, 'public.service_token_health', 'SELECT'),"
                             "       has_function_privilege(%s, 'public.service_token_health_rows()', 'EXECUTE');",
                             (role, role))
            self.assertEqual(self.cur.fetchone(), (True, True), role)
        for role in ("anon", "authenticated"):
            self.cur.execute("SELECT has_table_privilege(%s, 'public.service_token_health', 'SELECT'),"
                             "       has_function_privilege(%s, 'public.service_token_health_rows()', 'EXECUTE');",
                             (role, role))
            self.assertEqual(self.cur.fetchone(), (False, False), role)

    def test_grafana_reader_runs_the_rule_and_reads_nothing_behind_it(self):
        self.cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader';")
        if not self.cur.fetchone():
            self.skipTest("grafana_reader exists only where BI_READER_PASSWORD is set")
        try:
            reader = get_connection("grafana_reader", reader_password())
        except psycopg2.OperationalError as err:
            self.skipTest(f"cannot sign in as grafana_reader with the test chain's password: {err}")
        try:
            with reader.cursor() as cur:
                cur.execute(self.query)
                cur.fetchall()
                for table in ("audit_trail", "machine_principals", "revoked_service_tokens"):
                    cur.execute("SAVEPOINT denied;")
                    with self.assertRaises(errors.InsufficientPrivilege, msg=table):
                        cur.execute(sql.SQL("SELECT 1 FROM public.{} LIMIT 1;").format(sql.Identifier(table)))
                    cur.execute("ROLLBACK TO SAVEPOINT denied;")
        finally:
            reader.rollback()
            reader.close()


class TheAlertRow(ServiceTokenBase):

    def test_an_alert_about_a_machine_identity_needs_no_wire_identity(self):
        fingerprint = self.alert()
        self.cur.execute("SELECT entity_id::text, sparkplug_id FROM public.platform_alerts WHERE fingerprint = %s;",
                         (fingerprint,))
        self.assertEqual(self.cur.fetchone(), (IDENTITY_ID, None))

    def test_an_asset_alert_still_needs_one_and_an_unknown_kind_is_refused(self):
        for entity_type in ("device", "gateway", "person"):
            with self.subTest(entity_type=entity_type):
                self.cur.execute("SAVEPOINT refused;")
                with self.assertRaises(errors.CheckViolation):
                    self.alert(entity_type)
                self.cur.execute("ROLLBACK TO SAVEPOINT refused;")

    def test_a_replay_of_0001_leaves_both_checks_alone_over_one(self):
        # 0001 drops a CHECK that differs from its own and adds its own, which scans the rows: its
        # own must admit service_identity, or the boot after the first token alert fails here.
        baseline = (MIGRATIONS / "0001_baseline_schema.sql").read_text(encoding="utf-8")
        self.alert()
        oids = ("SELECT conname, oid FROM pg_constraint WHERE conrelid = 'public.platform_alerts'::regclass"
                " AND conname IN ('platform_alerts_entity_type_valid', 'platform_alerts_asset_has_wire_id')"
                " ORDER BY conname;")
        self.cur.execute(oids)
        before = self.cur.fetchall()
        self.assertEqual(len(before), 2)
        for name in ("platform_alerts_entity_type_valid", "platform_alerts_asset_has_wire_id"):
            block = re.search(
                r"DO \$c\$ BEGIN\n(?:(?!END \$c\$;).)*?conname = '" + name + r"'.*?END \$c\$;", baseline, re.S)
            self.cur.execute(block.group(0))
        self.cur.execute(oids)
        self.assertEqual(self.cur.fetchall(), before, "0001's replay dropped and re-added a CHECK")

    def test_only_an_administrator_reads_one(self):
        token = self.alert()
        device = self.alert("device", None, "dev220000000000400080000")
        both = {token, device}
        for relation in ("platform_alerts", "platform_alerts_active"):
            with self.subTest(relation=relation):
                self.assertEqual(self.visible(ADMIN_ID, relation, both), both)
                for user_id in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID):
                    self.assertEqual(self.visible(user_id, relation, both), {device}, user_id)


if __name__ == "__main__":
    unittest.main(verbosity=2)

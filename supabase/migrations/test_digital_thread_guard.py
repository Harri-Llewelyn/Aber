"""
PostgreSQL integration tests for the Digital Thread audit guard in
`0005_digital_thread_signal_and_attribution.sql`.

WHAT THIS PROTECTS. `log_digital_thread_event()` suppresses two kinds of machine non-event: an
UPDATE that changes nothing, and an UPDATE that moves only `gateways.last_heartbeat`. Both are
written by the ingestion daemon on a timer -- a heartbeat every 30s per gateway, a birth
certificate every 60s per device -- so without the guard a four-gateway, twelve-device stack
appends roughly 29,000 rows a day to a table that is APPEND-ONLY and cannot be pruned by any
application role.

WHY IT NEEDS A TEST AT ALL, GIVEN IT ALREADY WORKS. The guard is four lines inside a function that
is re-created by three separate migrations (0001, 0003, 0005), each replayed on every boot with no
applied-migrations ledger. A later migration re-declaring that function without the suppression
block would silently revert it, and the only symptom would be a table quietly growing again. There
was no test standing between that and production; this is it.

THE NEGATIVE CASES ARE THE POINT. A guard that suppresses too much is far worse than the noise it
replaces: a missing audit row is invisible until someone needs it. Every "must still be logged"
case below exists to catch an over-broad guard, and `test_heartbeat_with_a_status_change_is_logged`
is the specific case a careless per-column implementation drops.

Runs against the Supabase database, not the historian. Requires the stack (or CI's Postgres
service) to be up:

    python supabase/migrations/test_digital_thread_guard.py
"""
import os
import unittest
import uuid

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class AuditGuardTestCase(unittest.TestCase):
    """
    Every test runs inside one transaction and rolls back.

    ROLLBACK IS WHAT MAKES THIS SAFE TO RUN AGAINST A LIVE STACK. `digital_thread` is append-only
    to every application role, so a test that committed its scratch rows would leave permanent
    noise in exactly the table under test -- and could not clean up after itself without the
    owner exemption this suite deliberately does not rely on.
    """

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('public.digital_thread');")
                if not cur.fetchone()[0]:
                    raise RuntimeError("public.digital_thread does not exist; is the stack up?")

                # The guard lives in the function body. Assert the migration that carries it has
                # actually been applied before asserting behaviour, so a failure names the cause
                # rather than reporting a mysterious extra audit row.
                cur.execute("""
                    SELECT prosrc, prosecdef FROM pg_proc
                     WHERE proname = 'log_digital_thread_event'
                """)
                row = cur.fetchone()
                if not row:
                    raise RuntimeError("log_digital_thread_event() is not defined")
                cls.function_source, cls.is_security_definer = row
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        # A cell to hang the fixtures off. Created inside the transaction, so it disappears with
        # everything else on rollback.
        self.cell_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.cells (id, name) VALUES (%s, %s)",
            (self.cell_id, f"guard-test-{self.cell_id[:8]}"),
        )
        self.gateway_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, cell_id, status) VALUES (%s, %s, %s, 'ONLINE')",
            (self.gateway_id, f"guard-gw-{self.gateway_id[:8]}", self.cell_id),
        )
        self.device_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, status) "
            "VALUES (%s, %s, %s, 'ONLINE')",
            (self.device_id, f"guard-dev-{self.device_id[:8]}", self.gateway_id),
        )
        self._mark()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def _mark(self):
        """Record the current high-water mark so counts below measure only what a test caused."""
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.digital_thread")
        self._high_water = self.cur.fetchone()[0]

    def audit_rows(self, entity_type=None):
        sql = "SELECT entity_type, action, old_data, new_data FROM public.digital_thread WHERE id > %s"
        params = [self._high_water]
        if entity_type:
            sql += " AND entity_type = %s"
            params.append(entity_type)
        sql += " ORDER BY id"
        self.cur.execute(sql, params)
        return self.cur.fetchall()

    def audit_count(self, entity_type=None):
        return len(self.audit_rows(entity_type))


class TestFunctionShape(AuditGuardTestCase):
    """The properties 0005 must preserve from 0003, independent of the guard's behaviour."""

    def test_function_is_security_definer(self):
        self.assertTrue(
            self.is_security_definer,
            "log_digital_thread_event() lost SECURITY DEFINER; it writes to a table application "
            "roles cannot insert into directly",
        )

    def test_guard_is_scoped_to_update(self):
        self.assertIn("TG_OP = 'UPDATE'", self.function_source)

    def test_guard_subtracts_last_heartbeat(self):
        self.assertIn("last_heartbeat", self.function_source)

    def test_actor_resolution_is_preserved(self):
        """Both arms: auth.uid() first, then the SET LOCAL GUC that attributes RPC writes."""
        self.assertIn("auth.uid()", self.function_source)
        self.assertIn("acs_cymru.actor_id", self.function_source)


class TestNoOpUpdatesAreSuppressed(AuditGuardTestCase):

    def test_devices_noop_update_writes_no_audit_row(self):
        """An UPDATE writing the values already there. This is every DBIRTH before the daemon-side
        deduplication, and it is the bulk of the historical noise."""
        self.cur.execute(
            "UPDATE public.devices SET status = 'ONLINE' WHERE id = %s", (self.device_id,)
        )
        self.assertEqual(self.audit_count("devices"), 0)

    def test_devices_update_touching_every_column_with_identical_values(self):
        self.cur.execute(
            "UPDATE public.devices SET status = status, name = name, "
            "is_quarantined = is_quarantined WHERE id = %s",
            (self.device_id,),
        )
        self.assertEqual(self.audit_count("devices"), 0)

    def test_gateways_heartbeat_only_update_writes_no_audit_row(self):
        """The dominant source: 120 of these an hour per gateway, forever."""
        self.cur.execute(
            "UPDATE public.gateways SET last_heartbeat = now() WHERE id = %s", (self.gateway_id,)
        )
        self.assertEqual(self.audit_count("gateways"), 0)

    def test_gateways_heartbeat_with_unchanged_status_writes_no_audit_row(self):
        """Exactly what ingestion sends: status AND last_heartbeat, status unchanged."""
        self.cur.execute(
            "UPDATE public.gateways SET status = 'ONLINE', last_heartbeat = now() WHERE id = %s",
            (self.gateway_id,),
        )
        self.assertEqual(self.audit_count("gateways"), 0)

    def test_repeated_heartbeats_write_nothing(self):
        for _ in range(10):
            self.cur.execute(
                "UPDATE public.gateways SET status = 'ONLINE', last_heartbeat = now() "
                "WHERE id = %s",
                (self.gateway_id,),
            )
        self.assertEqual(self.audit_count("gateways"), 0)

    def test_cells_noop_update_writes_no_audit_row(self):
        self.cur.execute(
            "UPDATE public.cells SET name = name WHERE id = %s", (self.cell_id,)
        )
        self.assertEqual(self.audit_count("cells"), 0)


class TestRealChangesAreStillLogged(AuditGuardTestCase):
    """
    The over-suppression cases. Each of these is an event an operator may need to find months
    later, and a guard that swallowed one would do so silently.
    """

    def test_device_status_change_is_logged_once(self):
        self.cur.execute(
            "UPDATE public.devices SET status = 'OFFLINE' WHERE id = %s", (self.device_id,)
        )
        rows = self.audit_rows("devices")
        self.assertEqual(len(rows), 1)

        _, action, old_data, new_data = rows[0]
        self.assertEqual(action, "UPDATE")
        self.assertEqual(old_data["status"], "ONLINE")
        self.assertEqual(new_data["status"], "OFFLINE")

    def test_heartbeat_with_a_status_change_is_logged(self):
        """
        THE CASE A CARELESS IMPLEMENTATION DROPS. A gateway going OFFLINE reports it on the same
        UPDATE that stamps the heartbeat. Suppressing on "last_heartbeat changed" rather than on
        "nothing but last_heartbeat changed" loses every gateway transition on the platform.
        """
        self.cur.execute(
            "UPDATE public.gateways SET status = 'OFFLINE', last_heartbeat = now() WHERE id = %s",
            (self.gateway_id,),
        )
        rows = self.audit_rows("gateways")
        self.assertEqual(len(rows), 1, "a gateway status transition was suppressed")

        _, _, old_data, new_data = rows[0]
        self.assertEqual(old_data["status"], "ONLINE")
        self.assertEqual(new_data["status"], "OFFLINE")

    def test_device_rename_is_logged(self):
        self.cur.execute(
            "UPDATE public.devices SET name = 'renamed-device' WHERE id = %s", (self.device_id,)
        )
        self.assertEqual(self.audit_count("devices"), 1)

    def test_cell_rename_is_logged(self):
        self.cur.execute(
            "UPDATE public.cells SET name = 'renamed-cell' WHERE id = %s", (self.cell_id,)
        )
        self.assertEqual(self.audit_count("cells"), 1)

    def test_quarantine_flag_change_is_logged(self):
        """The approval path's state change -- the single most audit-relevant device event."""
        self.cur.execute(
            "UPDATE public.devices SET is_quarantined = true WHERE id = %s", (self.device_id,)
        )
        self.assertEqual(self.audit_count("devices"), 1)

    def test_null_to_value_is_logged(self):
        """
        IS NOT DISTINCT FROM, not `=`. With a plain equality test a NULL on either side yields
        NULL, the IF does not fire, and the row is logged -- which happens to be right here but is
        wrong for the no-op case. This asserts the direction that must log.
        """
        self.cur.execute(
            "UPDATE public.devices SET quarantine_reason = 'UNKNOWN_DEVICE' WHERE id = %s",
            (self.device_id,),
        )
        self.assertEqual(self.audit_count("devices"), 1)

    def test_value_to_null_is_logged(self):
        self.cur.execute(
            "UPDATE public.devices SET quarantine_reason = 'UNKNOWN_DEVICE' WHERE id = %s",
            (self.device_id,),
        )
        self._mark()
        self.cur.execute(
            "UPDATE public.devices SET quarantine_reason = NULL WHERE id = %s", (self.device_id,)
        )
        self.assertEqual(self.audit_count("devices"), 1)

    def test_null_to_null_is_suppressed(self):
        """The other half of IS NOT DISTINCT FROM: two NULLs compare equal and write nothing."""
        self.cur.execute(
            "UPDATE public.devices SET quarantine_reason = NULL WHERE id = %s", (self.device_id,)
        )
        self.assertEqual(self.audit_count("devices"), 0)


class TestInsertAndDeleteAreUnaffected(AuditGuardTestCase):
    """The guard is scoped to TG_OP = 'UPDATE'. An INSERT or DELETE is always an event."""

    def test_device_insert_is_logged(self):
        new_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, status) "
            "VALUES (%s, %s, %s, 'OFFLINE')",
            (new_id, f"guard-insert-{new_id[:8]}", self.gateway_id),
        )
        rows = self.audit_rows("devices")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], "INSERT")

    def test_device_delete_is_logged(self):
        self.cur.execute("DELETE FROM public.devices WHERE id = %s", (self.device_id,))
        rows = self.audit_rows("devices")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], "DELETE")

    def test_gateway_insert_is_logged(self):
        new_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, cell_id) VALUES (%s, %s, %s)",
            (new_id, f"guard-gw-insert-{new_id[:8]}", self.cell_id),
        )
        self.assertEqual(self.audit_count("gateways"), 1)

    def test_cell_insert_is_logged(self):
        new_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.cells (id, name) VALUES (%s, %s)",
            (new_id, f"guard-cell-insert-{new_id[:8]}"),
        )
        self.assertEqual(self.audit_count("cells"), 1)


class TestAttribution(AuditGuardTestCase):
    """
    0005 adds `actor_source` alongside `changed_by`. The guard must not have cost the attribution
    the same migration introduced.
    """

    def test_surviving_rows_carry_an_actor_source(self):
        self.cur.execute(
            "UPDATE public.devices SET status = 'OFFLINE' WHERE id = %s", (self.device_id,)
        )
        self.cur.execute(
            "SELECT actor_source FROM public.digital_thread WHERE id > %s", (self._high_water,)
        )
        rows = self.cur.fetchall()
        self.assertEqual(len(rows), 1)
        self.assertIsNotNone(rows[0][0], "audit row written with no actor_source")

    def test_actor_source_is_from_the_closed_set(self):
        self.cur.execute(
            "UPDATE public.devices SET status = 'OFFLINE' WHERE id = %s", (self.device_id,)
        )
        self.cur.execute(
            "SELECT actor_source FROM public.digital_thread WHERE id > %s", (self._high_water,)
        )
        self.assertIn(self.cur.fetchone()[0], ("user", "ingestion", "migration", "service"))

    def test_set_local_actor_id_is_honoured(self):
        """
        The approve_quarantined_device() path: a SECURITY DEFINER RPC sets the GUC so the audit
        row names the operator who authorised it rather than the service credential it rode in on.

        Uses a REAL account, because `digital_thread.changed_by` is a foreign key into auth.users
        -- which is itself the reason 0005 needed a separate `actor_source` column rather than
        writing 'ingestion' into changed_by.

        AND IT SEEDS ITS OWN, RATHER THAN TAKING THE FIRST ROW IT FINDS. This used to be
        `SELECT id FROM auth.users ORDER BY created_at LIMIT 1`, which is a person on a seeded
        stack and something else entirely in CI's RLS job, where seed.sql is deliberately not
        applied and the only rows are other suites' fixtures. Those are shaped like MACHINES --
        no email, no password -- so `is_machine_principal()` (0048) answered true, the attribution
        ladder skipped the `user` arm, and the assertion failed with 'migration' != 'user' against
        a function behaving exactly as designed.

        The three columns are the definition, not decoration: 0048 calls an account a machine when
        it has no email, no password AND no `auth.identities` row. A fixture meant to stand for a
        person has to fail all three, and an identity row is what GoTrue would create for one.
        This is the same trap the suites that seed their own personas already document -- a test
        depending on the seed passes locally and fails in CI, which is the worst direction.
        """
        actor = "5e770005-0000-4000-8000-0000000000a1"
        self.cur.execute("SAVEPOINT person;")
        try:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password)"
                " VALUES (%s, %s, %s) ON CONFLICT (id) DO NOTHING;",
                (actor, "attribution@guard.test", "not-a-real-hash"),
            )
            self.cur.execute("RELEASE SAVEPOINT person;")
        except psycopg2.Error:
            # The base image's legacy auth.users differs from GoTrue's; fall back to the
            # intersection and let the identity row below carry the personhood on its own.
            self.cur.execute("ROLLBACK TO SAVEPOINT person;")
            self.cur.execute(
                "INSERT INTO auth.users (id) VALUES (%s) ON CONFLICT (id) DO NOTHING;", (actor,)
            )
        self.cur.execute(
            "INSERT INTO auth.identities (user_id, provider, provider_id, identity_data)"
            " VALUES (%s, 'email', %s, %s::jsonb) ON CONFLICT DO NOTHING;",
            (actor, actor, '{"sub": "%s"}' % actor),
        )
        self.cur.execute("SELECT public.is_machine_principal(%s);", (actor,))
        self.assertFalse(
            self.cur.fetchone()[0],
            "the fixture account reads as a machine principal, so this test would assert the "
            "wrong arm of the attribution ladder rather than the one it is about."
        )

        self.cur.execute("SET LOCAL \"acs_cymru.actor_id\" = %s", (actor,))
        self.cur.execute(
            "UPDATE public.devices SET status = 'OFFLINE' WHERE id = %s", (self.device_id,)
        )
        self.cur.execute(
            "SELECT changed_by, actor_source FROM public.digital_thread WHERE id > %s",
            (self._high_water,),
        )
        changed_by, actor_source = self.cur.fetchone()
        self.assertEqual(str(changed_by), actor)
        self.assertEqual(actor_source, "user")


class TestMigrationIsIdempotent(AuditGuardTestCase):
    """
    Every migration replays on every boot with ON_ERROR_STOP=1 and no ledger. Re-declaring the
    function must leave behaviour identical -- and, critically, must not re-run the purge in a way
    that removes a row describing a real change.
    """

    def test_behaviour_is_unchanged_after_redeclaring_the_function(self):
        self.cur.execute(
            "SELECT prosrc FROM pg_proc WHERE proname = 'log_digital_thread_event'"
        )
        source = self.cur.fetchone()[0]

        # Re-create it exactly as it stands, which is what a replay of 0005 does.
        self.cur.execute(
            "CREATE OR REPLACE FUNCTION public.log_digital_thread_event() RETURNS trigger "
            "LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $body$"
            + source
            + "$body$"
        )

        self._mark()
        self.cur.execute(
            "UPDATE public.gateways SET status = 'ONLINE', last_heartbeat = now() WHERE id = %s",
            (self.gateway_id,),
        )
        self.assertEqual(self.audit_count("gateways"), 0)

        self._mark()
        self.cur.execute(
            "UPDATE public.devices SET status = 'OFFLINE' WHERE id = %s", (self.device_id,)
        )
        self.assertEqual(self.audit_count("devices"), 1)

    def test_purge_predicate_matches_nothing_that_records_a_change(self):
        """
        0005's DELETE is the one sanctioned use of the owner exemption. Re-running its predicate
        must not select a row describing a real change -- assert that directly against whatever is
        currently in the table, so a bad predicate is caught before it is ever re-run.
        """
        self.cur.execute(
            """
            SELECT count(*) FROM public.digital_thread
             WHERE action = 'UPDATE'
               AND old_data IS NOT NULL AND new_data IS NOT NULL
               AND (new_data - 'last_heartbeat') IS NOT DISTINCT FROM (old_data - 'last_heartbeat')
            """
        )
        self.assertEqual(
            self.cur.fetchone()[0], 0,
            "no-op audit rows exist that 0005's purge would remove -- either the guard regressed "
            "or the migration has not been replayed since they were written",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

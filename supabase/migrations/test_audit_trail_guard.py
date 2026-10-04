"""
PostgreSQL integration tests for the Audit Trail's no-op guard in
`0005_digital_thread_signal_and_attribution.sql`.

WHAT THIS PROTECTS. `log_audit_trail_event()` suppresses two kinds of machine non-event: an
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

    python supabase/migrations/test_audit_trail_guard.py
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

    ROLLBACK IS WHAT MAKES THIS SAFE TO RUN AGAINST A LIVE STACK. `audit_trail` is append-only
    to every application role, so a test that committed its scratch rows would leave permanent
    noise in exactly the table under test -- and could not clean up after itself without the
    owner exemption this suite deliberately does not rely on.
    """

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('public.audit_trail');")
                if not cur.fetchone()[0]:
                    raise RuntimeError("public.audit_trail does not exist; is the stack up?")

                # The guard lives in the function body. Assert the migration that carries it has
                # actually been applied before asserting behaviour, so a failure names the cause
                # rather than reporting a mysterious extra audit row.
                cur.execute("""
                    SELECT prosrc, prosecdef FROM pg_proc
                     WHERE proname = 'log_audit_trail_event'
                """)
                row = cur.fetchone()
                if not row:
                    raise RuntimeError("log_audit_trail_event() is not defined")
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
        # first_dbirth_at alongside the status, because devices_online_implies_born (0119) refuses
        # ONLINE without one. These tests are about the audit guard rather than about liveness, and
        # a fixture pretending to be live is now required to say when it was born.
        self.device_id = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, status, first_dbirth_at) "
            "VALUES (%s, %s, %s, 'ONLINE', now())",
            (self.device_id, f"guard-dev-{self.device_id[:8]}", self.gateway_id),
        )
        self._mark()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def _mark(self):
        """Record the current high-water mark so counts below measure only what a test caused."""
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.audit_trail")
        self._high_water = self.cur.fetchone()[0]

    def audit_rows(self, entity_type=None):
        sql = "SELECT entity_type, action, old_data, new_data FROM public.audit_trail WHERE id > %s"
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
            "log_audit_trail_event() lost SECURITY DEFINER; it writes to a table application "
            "roles cannot insert into directly",
        )

    def test_guard_is_scoped_to_update(self):
        self.assertIn("TG_OP = 'UPDATE'", self.function_source)

    def test_guard_subtracts_last_heartbeat(self):
        """
        Through audit_telemetry_columns() since 0100, which names last_heartbeat and the six
        health columns a heartbeat also rewrites; the property 0005 established is unchanged.
        """
        self.assertIn("audit_telemetry_columns()", self.function_source)
        self.cur.execute("SELECT public.audit_telemetry_columns()")
        self.assertIn("last_heartbeat", self.cur.fetchone()[0])

    def test_actor_resolution_is_preserved(self):
        """Both arms: auth.uid() first, then the SET LOCAL GUC that attributes RPC writes."""
        self.assertIn("auth.uid()", self.function_source)
        self.assertIn("aber.actor_id", self.function_source)


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
            "SELECT actor_source FROM public.audit_trail WHERE id > %s", (self._high_water,)
        )
        rows = self.cur.fetchall()
        self.assertEqual(len(rows), 1)
        self.assertIsNotNone(rows[0][0], "audit row written with no actor_source")

    def test_actor_source_is_from_the_closed_set(self):
        self.cur.execute(
            "UPDATE public.devices SET status = 'OFFLINE' WHERE id = %s", (self.device_id,)
        )
        self.cur.execute(
            "SELECT actor_source FROM public.audit_trail WHERE id > %s", (self._high_water,)
        )
        self.assertIn(self.cur.fetchone()[0], ("user", "ingestion", "migration", "service"))

    def test_set_local_actor_id_is_honoured(self):
        """
        The approve_quarantined_device() path: a SECURITY DEFINER RPC sets the GUC so the audit
        row names the operator who authorised it rather than the service credential it rode in on.

        Uses a REAL account, because `audit_trail.changed_by` is a foreign key into auth.users
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

        self.cur.execute("SET LOCAL \"aber.actor_id\" = %s", (actor,))
        self.cur.execute(
            "UPDATE public.devices SET status = 'OFFLINE' WHERE id = %s", (self.device_id,)
        )
        self.cur.execute(
            "SELECT changed_by, actor_source FROM public.audit_trail WHERE id > %s",
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
            "SELECT prosrc FROM pg_proc WHERE proname = 'log_audit_trail_event'"
        )
        source = self.cur.fetchone()[0]

        # Re-create it exactly as it stands, which is what a replay of 0005 does.
        self.cur.execute(
            "CREATE OR REPLACE FUNCTION public.log_audit_trail_event() RETURNS trigger "
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
            SELECT count(*) FROM public.audit_trail
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


class TestMetricCatalogReachesTheTrail(AuditGuardTestCase):
    """
    0143 (#468). Deprecating is the only way to retire a metric, and `metric_catalog` carried no
    trigger, so neither a deprecation nor its reversal said who made it or when. Both are UPDATEs
    on the catalog row, recorded by this file's function like any other.
    """

    def _metric(self, stem, **extra):
        name = f"GuardTest/{stem}_{uuid.uuid4().hex[:8]}"
        columns = ["name", "datatype", *extra]
        self.cur.execute(
            f"INSERT INTO public.metric_catalog ({', '.join(columns)})"
            f" VALUES ({', '.join(['%s'] * len(columns))}) RETURNING id::text",
            (name, 12, *extra.values()),
        )
        return self.cur.fetchone()[0]

    def _person(self, role):
        """
        A signed-in person holding `role`. Email, password AND an identity row, because
        is_machine_principal() (0048) calls anything lacking all three a machine, and a machine
        is neither attributed as `user` nor allowed a role.
        """
        person = str(uuid.uuid4())
        self.cur.execute("SAVEPOINT person;")
        try:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password) VALUES (%s, %s, %s);",
                (person, f"{person}@guard.test", "not-a-real-hash"),
            )
            self.cur.execute("RELEASE SAVEPOINT person;")
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT person;")
            self.cur.execute("INSERT INTO auth.users (id) VALUES (%s);", (person,))
        self.cur.execute(
            "INSERT INTO auth.identities (user_id, provider, provider_id, identity_data)"
            " VALUES (%s, 'email', %s, %s::jsonb);",
            (person, person, '{"sub": "%s"}' % person),
        )
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id)"
            " SELECT %s, id FROM public.roles WHERE name = %s;",
            (person, role),
        )
        return person

    def test_the_trigger_is_attached(self):
        self.cur.execute(
            "SELECT tgname FROM pg_trigger "
            " WHERE tgrelid = 'public.metric_catalog'::regclass AND NOT tgisinternal"
            "   AND tgfoid = 'public.log_audit_trail_event()'::regprocedure"
        )
        self.assertEqual([r[0] for r in self.cur.fetchall()], ["trg_metric_catalog_audit_trail"])

    def test_a_deprecation_is_logged_with_its_replacement(self):
        replacement = self._metric("NEW")
        metric = self._metric("OLD")
        self._mark()
        self.cur.execute(
            "UPDATE public.metric_catalog SET deprecated = true, superseded_by = %s WHERE id = %s",
            (replacement, metric),
        )
        rows = self.audit_rows("metric_catalog")
        self.assertEqual([r[1] for r in rows], ["UPDATE"])
        _, _, old, new = rows[0]
        self.assertEqual((old["deprecated"], new["deprecated"]), (False, True))
        self.assertEqual(new["superseded_by"], replacement)

    def test_a_restore_is_logged(self):
        replacement = self._metric("NEW")
        metric = self._metric("OLD", deprecated=True, superseded_by=replacement)
        self._mark()
        self.cur.execute(
            "UPDATE public.metric_catalog SET deprecated = false, superseded_by = NULL WHERE id = %s",
            (metric,),
        )
        rows = self.audit_rows("metric_catalog")
        self.assertEqual(len(rows), 1, "restoring a metric left no record")
        _, _, old, new = rows[0]
        self.assertEqual((old["deprecated"], old["superseded_by"]), (True, replacement))
        self.assertEqual((new["deprecated"], new["superseded_by"]), (False, None))

    def test_a_semantic_id_correction_is_logged(self):
        """Edit on the Metrics page is an UPDATE of the pair, recorded like any other."""
        metric = self._metric("MAPPED", semantic_id="https://aber.local/semantics/fixture",
                              semantic_id_type="IRI")
        self._mark()
        self.cur.execute(
            "UPDATE public.metric_catalog SET semantic_id = %s, semantic_id_type = 'IRDI' WHERE id = %s",
            ("0112/2///61987#ABA565#009", metric),
        )
        rows = self.audit_rows("metric_catalog")
        self.assertEqual(len(rows), 1, "correcting a semantic id left no record")
        _, _, old, new = rows[0]
        self.assertEqual((old["semantic_id"], old["semantic_id_type"]),
                         ("https://aber.local/semantics/fixture", "IRI"))
        self.assertEqual((new["semantic_id"], new["semantic_id_type"]),
                         ("0112/2///61987#ABA565#009", "IRDI"))

    def test_a_replayed_seed_update_is_not(self):
        """
        0002 re-applies `permitted_values` on every boot with an unguarded UPDATE. It writes the
        value the row already holds, so the function's own no-op rule must keep it off the trail.
        """
        metric = self._metric("SEEDED", permitted_values=["READY", "ACTIVE"])
        self._mark()
        self.cur.execute(
            "UPDATE public.metric_catalog SET permitted_values = ARRAY['READY', 'ACTIVE'] WHERE id = %s",
            (metric,),
        )
        self.assertEqual(self.audit_count("metric_catalog"), 0,
                         "a replayed seed that changed nothing was recorded on every boot")

    def test_the_row_names_the_administrator_and_lands_in_the_asset_lane(self):
        """The question #468 asks of a deprecation: who, through the path the dashboard takes."""
        metric = self._metric("ATTRIBUTED")
        admin = self._person("Administrator")
        self._mark()
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % admin,))
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE id = %s", (metric,))
        self.assertEqual(self.cur.rowcount, 1, "the Administrator's deprecation reached no row")
        self.cur.execute("RESET ROLE;")

        self.cur.execute(
            "SELECT changed_by::text, actor_source, audit_domain FROM public.audit_trail "
            " WHERE id > %s AND entity_type = 'metric_catalog'",
            (self._high_water,),
        )
        self.assertEqual(self.cur.fetchall(), [(admin, "user", "asset")])


class TestNameplateEditsReachTheTrail(AuditGuardTestCase):
    """
    0122, AND THE REASON IT IS HERE RATHER THAN IN ITS OWN FILE.

    `device_nameplate` was an Audit Trail lane that nothing wrote. The classifier knew it, the
    dashboard offered it as a filter and resolved its rows against the device they name -- and the
    table carried no trigger at all, so the filter answered empty on every stack that ever ran. A
    live one held 4,075 audit rows across eleven entity types and not one was a nameplate.

    The obstacle was the function this file is about. `log_audit_trail_event()` read `NEW.id`,
    and this table is keyed by `device_id` with no `id` column, so the trigger could not be
    attached. 0122 makes the key column a trigger argument defaulting to `id` -- which is why the
    assertions below belong beside the rest of that function's behaviour rather than apart from it.
    """

    NAMEPLATE = ("INSERT INTO public.device_nameplate (device_id, manufacturer_name, serial_number) "
                 "VALUES (%s, 'Acme', 'SN-1')")

    def test_a_new_nameplate_is_filed_under_its_device(self):
        """
        THE WHOLE POINT OF THE KEY COLUMN. The id recorded is the DEVICE's, not a row id of its
        own, because a nameplate is an assertion about a device and api.js unions the two into one
        timeline. Reading `NEW.id` here would not have produced a wrong id -- it would not have
        compiled.
        """
        self.cur.execute(self.NAMEPLATE, (self.device_id,))
        self.cur.execute(
            "SELECT entity_type, entity_id::text, action FROM public.audit_trail "
            " WHERE id > %s AND entity_type = 'device_nameplate'",
            (self._high_water,),
        )
        self.assertEqual(
            self.cur.fetchall(), [("device_nameplate", self.device_id, "INSERT")],
            "a nameplate insert did not reach the trail under its device's id",
        )

    def test_an_edit_is_logged(self):
        self.cur.execute(self.NAMEPLATE, (self.device_id,))
        self._mark()
        self.cur.execute(
            "UPDATE public.device_nameplate SET serial_number = 'SN-2' WHERE device_id = %s",
            (self.device_id,),
        )
        self.assertEqual(self.audit_count("device_nameplate"), 1,
                         "correcting a serial number is an edit to the asset record and an event")

    def test_a_save_that_moved_only_the_bookkeeping_columns_is_not(self):
        """
        THE NEGATIVE CASE, AND IT IS NOT HYPOTHETICAL. The editor upserts the whole row and stamps
        `updated_at` on every save, so an operator who opens the form and saves it unchanged writes
        a different row. Without the WHEN clause that files an event whose two snapshots are
        identical but for a timestamp -- into an append-only table, so it could never be tidied up.

        audit_telemetry_columns() cannot cover this: it names the columns a gateway HEARTBEAT
        rewrites, and widening it to `updated_at` would silence that column on every table.
        """
        self.cur.execute(self.NAMEPLATE, (self.device_id,))
        self._mark()
        # `now()` is TRANSACTION-scoped, so writing it here would reproduce the value the
        # INSERT above already stored and the function's own no-op guard would swallow the write
        # -- leaving this test passing with the WHEN clause removed. An explicitly different
        # timestamp is what makes it measure the clause it is about.
        self.cur.execute(
            "UPDATE public.device_nameplate "
            "   SET updated_at = now() + interval '1 hour', updated_by = NULL "
            " WHERE device_id = %s",
            (self.device_id,),
        )
        self.assertEqual(self.audit_count("device_nameplate"), 0,
                         "a save that changed no nameplate field was recorded as an event")

    def test_clearing_a_nameplate_is_logged(self):
        """Deleting the row is how the editor models "no nameplate data", so it is an event."""
        self.cur.execute(self.NAMEPLATE, (self.device_id,))
        self._mark()
        self.cur.execute("DELETE FROM public.device_nameplate WHERE device_id = %s",
                         (self.device_id,))
        rows = self.audit_rows("device_nameplate")
        self.assertEqual([r[1] for r in rows], ["DELETE"])
        self.assertIsNotNone(rows[0][2], "a DELETE must carry what was there before it")

    def test_the_row_lands_in_the_asset_lane(self):
        """
        Without this the feature is invisible to the role that uses it: audit_trail_select_asset
        is what admits a Shopfloor_Manager, and a Manager is one of the two roles RLS lets edit a
        nameplate at all. The classifier has said `asset` since 0070; 0122 is the first file whose
        rows depend on the answer.
        """
        self.cur.execute(self.NAMEPLATE, (self.device_id,))
        self.cur.execute(
            "SELECT DISTINCT audit_domain FROM public.audit_trail "
            " WHERE id > %s AND entity_type = 'device_nameplate'",
            (self._high_water,),
        )
        self.assertEqual(self.cur.fetchall(), [("asset",)])

    def test_every_trigger_on_this_function_names_a_column_that_exists(self):
        """
        THE COST OF MAKING THE KEY A STRING. A trigger argument naming a column that is not there
        reads as NULL through `->>` rather than failing, so the mistake is silent at the point it
        is made. 0122's own self-check asserts this at migration time; this asserts it against
        whatever is actually attached, which is the thing a later migration can change.
        """
        self.cur.execute(
            r"""
            SELECT n.nspname || '.' || c.relname || ' -> ' || k.col
              FROM pg_trigger t
              JOIN pg_class c     ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              JOIN pg_proc p      ON p.oid = t.tgfoid
             CROSS JOIN LATERAL (
                    SELECT coalesce(
                             (regexp_match(pg_get_triggerdef(t.oid),
                                           'log_audit_trail_event\(''([^'']*)''\)'))[1],
                             'id') AS col) k
             WHERE p.proname = 'log_audit_trail_event'
               AND NOT t.tgisinternal
               AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                                WHERE a.attrelid = c.oid AND a.attnum > 0
                                  AND NOT a.attisdropped AND a.attname = k.col)
            """
        )
        self.assertEqual(self.cur.fetchall(), [],
                         "an audit trail trigger names a key column its table does not have")

    def test_the_nameplate_triggers_are_attached(self):
        """
        The pair, by name. The function is re-created by four migrations and the triggers by one,
        so the way this regresses is a later file replacing the function and nobody noticing the
        lane went quiet again -- which is exactly how it stayed empty for as long as it did.
        """
        self.cur.execute(
            "SELECT tgname FROM pg_trigger "
            " WHERE tgrelid = 'public.device_nameplate'::regclass AND NOT tgisinternal "
            " ORDER BY tgname"
        )
        self.assertEqual(
            [r[0] for r in self.cur.fetchall()],
            ["trg_device_nameplate_audit_trail", "trg_device_nameplate_audit_trail_update"],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

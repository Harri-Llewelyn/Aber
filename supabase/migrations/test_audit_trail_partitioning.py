"""
PostgreSQL integration tests for the monthly partitioning of `public.audit_trail`
(`0079_the_thread_stops_growing_without_end.sql`).

WHAT THIS PROTECTS, AND WHY IT IS NOT "DOES PARTITIONING WORK".

Converting a populated table to partitioned means building a new table, copying, swapping names and
then REBUILDING BY HAND every object PostgreSQL does not carry across: the primary key, the foreign
key, three indexes, two triggers, row-level security and its two policies, and the ACL. Each of
those is a security property of the audit trail, and each is one forgotten line away from being
absent on a table that otherwise looks completely normal.

A missing index is a slow page. A missing `ENABLE ROW LEVEL SECURITY` publishes every
security-domain audit row -- role grants, token mints, principal withdrawals -- to any authenticated
reader, and NOTHING ELSE IN THE STACK WOULD SAY SO. That asymmetry is why this file asserts the
boring things at length.

THE OTHER HALF IS REPLAY. supabase-db-init runs `for f in /migrations/*.sql` on every boot with
ON_ERROR_STOP=1 and there is no applied-migrations ledger, so 0079 executes again on every start
for the life of the deployment. A conversion that is not idempotent does not fail once -- it takes
the stack down on the second boot, which is the first boot any real deployment performs.

Every test rolls back. Requires the schema, so run it against the throwaway database rather than the
live stack:

    npm run test:db
    SUPABASE_DB_PORT=54329 python supabase/migrations/test_audit_trail_partitioning.py
"""
import os
import unittest
import uuid

import psycopg2
from psycopg2 import errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

PARENT = "public.audit_trail"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class PartitionedShapeTestCase(unittest.TestCase):
    """The table is partitioned, and by the right column."""

    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()

    def test_the_table_is_range_partitioned(self):
        self.cur.execute(
            "SELECT partstrat FROM pg_partitioned_table WHERE partrelid = %s::regclass", (PARENT,)
        )
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "audit_trail is not partitioned at all")
        self.assertEqual("r", row[0], "audit_trail is partitioned, but not by RANGE")

    def test_the_partition_key_is_recorded_at(self):
        self.cur.execute(
            "SELECT pg_get_partkeydef(%s::regclass)", (PARENT,)
        )
        self.assertEqual("RANGE (recorded_at)", self.cur.fetchone()[0])

    def test_recorded_at_is_not_null(self):
        # A NULL partition key matches no range and falls to the default partition permanently,
        # where retention by DETACH would never reach it.
        self.cur.execute(
            "SELECT attnotnull FROM pg_attribute "
            "WHERE attrelid = %s::regclass AND attname = 'recorded_at'", (PARENT,)
        )
        self.assertTrue(self.cur.fetchone()[0], "recorded_at is still nullable")

    def test_there_is_a_default_partition(self):
        """
        THE DESIGN DECISION THIS FILE MOST NEEDS TO PIN, because removing it looks like tidying.

        A range-partitioned table refuses a row no partition accepts, and the audit insert is made
        by a trigger on cells/gateways/devices -- so a gap in coverage does not lose an audit row,
        it fails the asset write that caused it. The default partition is what makes a lapsed
        maintenance job a reportable untidiness instead of a stopped production line.
        """
        self.cur.execute(
            "SELECT count(*) FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid "
            "WHERE i.inhparent = %s::regclass "
            "  AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'", (PARENT,)
        )
        self.assertEqual(1, self.cur.fetchone()[0], "no DEFAULT partition on audit_trail")

    def test_the_current_month_has_a_partition_of_its_own(self):
        # Not the default one: a row written today must land in a detachable month.
        self.cur.execute(
            "SELECT count(*) FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid "
            "WHERE i.inhparent = %s::regclass "
            "  AND c.relname = 'audit_trail_' || to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM')",
            (PARENT,),
        )
        self.assertEqual(1, self.cur.fetchone()[0], "the current month has no partition")

    def test_partitions_reach_into_the_future(self):
        """Headroom is the whole point of running the job ahead of need."""
        self.cur.execute("SELECT covered_until FROM public.audit_trail_partition_health")
        covered_until = self.cur.fetchone()[0]
        self.cur.execute("SELECT now()")
        now = self.cur.fetchone()[0]
        self.assertGreater(
            covered_until, now,
            "every partition ends in the past -- new rows are already falling to the default",
        )


class SurvivedTheConversionTestCase(unittest.TestCase):
    """
    Everything LIKE does not carry, asserted one at a time.

    These read as trivia and are not. Each names an object that the conversion had to recreate by
    hand, and the failure mode of omitting one ranges from a slow query to publishing the security
    audit lane to every logged-in user.
    """

    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()

    def test_the_primary_key_includes_the_partition_key(self):
        # Not a stylistic point: PostgreSQL refuses a unique constraint on a partitioned table
        # unless it contains the partition key, so `PRIMARY KEY (id)` cannot exist here at all.
        self.cur.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = %s::regclass AND conname = 'audit_trail_pkey'", (PARENT,)
        )
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "the primary key did not survive the conversion")
        self.assertEqual("PRIMARY KEY (id, recorded_at)", row[0])

    def test_the_changed_by_foreign_key_survived(self):
        # log_audit_trail_event() writes changed_by = auth.uid(). Without the FK an audit row
        # can name a user who does not exist, which is worse than naming nobody.
        self.cur.execute(
            "SELECT count(*) FROM pg_constraint "
            "WHERE conrelid = %s::regclass AND conname = 'audit_trail_changed_by_fkey' "
            "  AND contype = 'f'", (PARENT,)
        )
        self.assertEqual(1, self.cur.fetchone()[0])

    def test_both_check_constraints_survived(self):
        self.cur.execute(
            "SELECT conname FROM pg_constraint "
            "WHERE conrelid = %s::regclass AND contype = 'c' ORDER BY conname", (PARENT,)
        )
        self.assertEqual(
            ["audit_trail_actor_source_check", "audit_trail_audit_domain_check"],
            [r[0] for r in self.cur.fetchall()],
        )

    def test_every_index_survived(self):
        self.cur.execute(
            "SELECT c.relname FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid "
            "WHERE x.indrelid = %s::regclass ORDER BY c.relname", (PARENT,)
        )
        self.assertEqual(
            [
                "audit_trail_pkey",
                "idx_audit_trail_causation",
                "idx_audit_trail_domain",
                "idx_audit_trail_recorded_id",
            ],
            [r[0] for r in self.cur.fetchall()],
        )

    def test_both_triggers_survived(self):
        self.cur.execute(
            "SELECT tgname FROM pg_trigger "
            "WHERE tgrelid = %s::regclass AND NOT tgisinternal ORDER BY tgname", (PARENT,)
        )
        self.assertEqual(
            ["trg_audit_trail_append_only", "trg_audit_trail_stamp_domain"],
            [r[0] for r in self.cur.fetchall()],
        )

    def test_row_level_security_is_still_enabled(self):
        # The single most costly line to forget in the whole conversion.
        self.cur.execute(
            "SELECT relrowsecurity FROM pg_class WHERE oid = %s::regclass", (PARENT,)
        )
        self.assertTrue(self.cur.fetchone()[0], "RLS is OFF on the audit table")

    def test_both_select_policies_survived(self):
        self.cur.execute(
            "SELECT polname FROM pg_policy WHERE polrelid = %s::regclass ORDER BY polname", (PARENT,)
        )
        self.assertEqual(
            ["audit_trail_select_asset", "audit_trail_select_security"],
            [r[0] for r in self.cur.fetchall()],
        )

    def test_no_application_role_can_write(self):
        """
        The ACL, read as capabilities rather than as a grant list.

        0003's trigger refuses UPDATE and DELETE, but the trigger is the second line of defence --
        the first is that neither role holds the privilege. A conversion that recreated the table
        and left the image's permissive defaults in place would satisfy every other test here.
        """
        for role in ("authenticated", "service_role"):
            for privilege in ("INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                self.cur.execute(
                    "SELECT has_table_privilege(%s, %s, %s)", (role, PARENT, privilege)
                )
                self.assertFalse(
                    self.cur.fetchone()[0],
                    f"{role} holds {privilege} on the append-only audit table",
                )

    def test_both_application_roles_can_still_read(self):
        # The other direction: a REVOKE that swept too widely would take the Audit Trail page
        # down, and would do it silently as an empty timeline rather than as an error.
        for role in ("authenticated", "service_role"):
            self.cur.execute("SELECT has_table_privilege(%s, %s, 'SELECT')", (role, PARENT))
            self.assertTrue(self.cur.fetchone()[0], f"{role} cannot read audit_trail")

    def test_no_application_role_can_reach_a_partition_directly(self):
        """
        THE HOLE PARTITIONING OPENS, AND THE ONE THIS SUITE WAS WRITTEN TOO LATE TO CATCH BY LUCK.

        A partition does not inherit the parent's ACL. It gets the image's DEFAULT privileges
        instead, which hand `service_role` everything -- and the first conversion produced exactly
        that:

            audit_trail          service_role=rxtm/postgres
            audit_trail_2026_09  service_role=arwdDxtm/postgres

        The append-only trigger fires for partitions, so a direct DELETE is still refused. TRUNCATE
        IS NOT A ROW OPERATION AND RAISES NO TRIGGER, so a month of audit history could have been
        erased through a table name, as a role the platform hands out, with the parent's REVOKE
        still looking correct.

        Asserted over every partition rather than a sample, because the maintenance job creates a
        new one every month for the life of the deployment and each is a fresh chance to inherit
        the default.
        """
        self.cur.execute(
            "SELECT c.oid::regclass::text FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid "
            "WHERE i.inhparent = %s::regclass ORDER BY 1", (PARENT,)
        )
        partitions = [r[0] for r in self.cur.fetchall()]
        self.assertGreater(len(partitions), 1, "expected several partitions to check")

        for partition in partitions:
            for role in ("anon", "authenticated", "service_role"):
                for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                    self.cur.execute(
                        "SELECT has_table_privilege(%s, %s, %s)", (role, partition, privilege)
                    )
                    self.assertFalse(
                        self.cur.fetchone()[0],
                        f"{role} holds {privilege} directly on {partition}, bypassing the "
                        f"parent's ACL",
                    )

    def test_a_partition_made_later_is_secured_too(self):
        # The recurring half. A partition created by the cron job next year must land with the same
        # ACL as the ones the conversion made, or this closes for exactly as long as nobody waits.
        self.cur.execute("SELECT public.ensure_audit_trail_partition(now() + interval '11 months')")
        self.assertTrue(self.cur.fetchone()[0])
        self.cur.execute(
            "SELECT 'public.audit_trail_' || to_char("
            "  (now() + interval '11 months') AT TIME ZONE 'UTC', 'YYYY_MM')"
        )
        fresh = self.cur.fetchone()[0]
        for privilege in ("SELECT", "INSERT", "TRUNCATE"):
            self.cur.execute("SELECT has_table_privilege('service_role', %s, %s)", (fresh, privilege))
            self.assertFalse(
                self.cur.fetchone()[0],
                f"a newly created partition granted service_role {privilege}",
            )

    def test_every_comment_survived_the_conversion(self):
        """
        THE ONE CI CAUGHT AND THIS SUITE DID NOT, which is why it is here.

        A COMMENT lives on the object, so dropping the old table dropped every comment with it --
        including the one 0077 puts on `idx_audit_trail_recorded_id`. Rebuilding the index
        without it is invisible on a single boot and produces DRIFT on the next one: 0077's
        `CREATE INDEX IF NOT EXISTS` skips, its unconditional `COMMENT ON INDEX` lands, and the
        schema now differs between two runs of the same chain. check-migration-idempotency.mjs
        refuses that, correctly -- but it needs the live stack, so nothing here saw it.

        Asserted as "every index and column that has a comment has a NON-EMPTY one" rather than
        against a list of names, so a comment added to this table later is covered by this test
        without anybody remembering to extend it.
        """
        self.cur.execute(
            "SELECT c.relname, obj_description(c.oid, 'pg_class') "
            "FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid "
            "WHERE x.indrelid = %s::regclass ORDER BY c.relname", (PARENT,)
        )
        commented = {name: comment for name, comment in self.cur.fetchall()}
        self.assertIn(
            "idx_audit_trail_recorded_id", commented,
            "the keyset index is missing entirely",
        )
        self.assertTrue(
            commented["idx_audit_trail_recorded_id"],
            "idx_audit_trail_recorded_id lost the comment 0077 gives it -- the conversion "
            "rebuilt the index without carrying it, which is schema drift on the next boot",
        )

        # The columns 0001 documents. Same failure mode, same fix, and the audit table is where a
        # reader goes to find out what `actor_source` and `causation_id` actually mean.
        self.cur.execute(
            "SELECT a.attname, col_description(a.attrelid, a.attnum) "
            "FROM pg_attribute a WHERE a.attrelid = %s::regclass AND a.attnum > 0 "
            "  AND NOT a.attisdropped", (PARENT,)
        )
        columns = {name: comment for name, comment in self.cur.fetchall()}
        for column in ("actor_source", "causation_id", "audit_domain"):
            self.assertTrue(
                columns.get(column),
                f"audit_trail.{column} lost its comment in the conversion",
            )

    def test_the_sequence_was_not_dropped_with_the_old_table(self):
        """
        0001 declares the sequence OWNED BY audit_trail.id, so DROP TABLE on the original would
        have taken it with it -- and the replacement would have restarted numbering at 1, colliding
        with every id already written.
        """
        self.cur.execute("SELECT to_regclass('public.audit_trail_id_seq')")
        self.assertIsNotNone(self.cur.fetchone()[0], "the audit sequence is gone")

        self.cur.execute(
            "SELECT d.refobjid::regclass::text FROM pg_depend d "
            "WHERE d.objid = 'public.audit_trail_id_seq'::regclass AND d.deptype = 'a'"
        )
        self.assertEqual("audit_trail", self.cur.fetchone()[0])


class TheGuaranteesStillBiteTestCase(unittest.TestCase):
    """
    The properties above are structural. These exercise them.

    A trigger that exists on the parent and does not fire for a partition would pass every
    assertion in the previous class and leave the audit trail editable.
    """

    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()
        self.cur.execute(
            "INSERT INTO public.audit_trail (entity_type, entity_id, action, new_data, audit_domain) "
            "VALUES ('cells', %s, 'INSERT', '{\"probe\": true}'::jsonb, 'asset') "
            "RETURNING id, recorded_at",
            (str(uuid.uuid4()),),
        )
        self.row_id, self.recorded_at = self.cur.fetchone()

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()

    def test_a_row_lands_in_the_month_it_happened_in(self):
        # Routing, which is the one thing partitioning has to get right.
        self.cur.execute(
            "SELECT tableoid::regclass::text FROM public.audit_trail "
            "WHERE id = %s AND recorded_at = %s", (self.row_id, self.recorded_at)
        )
        landed = self.cur.fetchone()[0]
        self.cur.execute(
            "SELECT 'audit_trail_' || to_char(%s AT TIME ZONE 'UTC', 'YYYY_MM')",
            (self.recorded_at,),
        )
        self.assertEqual(self.cur.fetchone()[0], landed)

    def test_a_new_row_does_not_land_in_the_default_partition(self):
        # The default partition is a safety net, not a destination. A row arriving there today
        # means the maintenance job has stopped.
        self.cur.execute(
            "SELECT tableoid::regclass::text FROM public.audit_trail "
            "WHERE id = %s AND recorded_at = %s", (self.row_id, self.recorded_at)
        )
        self.assertNotEqual("audit_trail_default", self.cur.fetchone()[0])

    def test_the_domain_is_still_stamped_on_insert(self):
        # trg_audit_trail_stamp_domain is a BEFORE INSERT row trigger, which is only permitted
        # on a partitioned table from PostgreSQL 13. If it silently did not fire, the audit_domain
        # a caller supplied would stand -- and a writer could file its own act in the asset lane.
        self.cur.execute(
            "INSERT INTO public.audit_trail (entity_type, entity_id, action, audit_domain) "
            "VALUES ('user_roles', %s, 'ROLE_GRANTED', 'asset') RETURNING audit_domain",
            (str(uuid.uuid4()),),
        )
        self.assertEqual(
            "security", self.cur.fetchone()[0],
            "the domain trigger did not fire on the partition -- a caller's lane claim stood",
        )

    def become_a_probe_role(self):
        """
        A role the trigger actually constrains, built for the assertion and rolled back with it.

        TWO THINGS MAKE THIS NECESSARY, AND BOTH ARE EASY TO GET SILENTLY WRONG.

        This suite connects as `postgres`, and enforce_audit_trail_append_only() EXEMPTS owner
        roles on purpose -- 0003 says why: a trigger cannot constrain a role that can drop it, so
        pretending otherwise would be theatre. An UPDATE issued as `postgres` therefore succeeds,
        and a test asserting it raises would be asserting something the guard does not claim --
        and would pass just as happily against a table whose trigger had been dropped.

        BYPASSRLS is the second half. With RLS enabled and no UPDATE policy, an UPDATE by an
        ordinary role matches zero rows and "succeeds" without ever reaching the trigger, so the
        test would pass for the wrong reason. Bypassing RLS puts the row in front of the trigger,
        which is the thing under test.

        No shipped role holds UPDATE on this table -- test_no_application_role_can_write asserts
        exactly that -- so this probe is the only way to exercise the second line of defence
        rather than the first.
        """
        self.cur.execute("CREATE ROLE dt_append_only_probe BYPASSRLS")
        # SELECT as well as the write bits: `WHERE id = ...` reads a column, so an UPDATE without it
        # is refused by the grant before the trigger is ever consulted -- which would make this test
        # pass for the wrong reason all over again.
        self.cur.execute(
            "GRANT SELECT, UPDATE, DELETE ON public.audit_trail TO dt_append_only_probe"
        )
        # And on the partitions, which hold their own ACL -- that being the whole point of
        # test_no_application_role_can_reach_a_partition_directly.
        self.cur.execute(
            "SELECT string_agg(c.oid::regclass::text, ', ') FROM pg_class c "
            "JOIN pg_inherits i ON i.inhrelid = c.oid WHERE i.inhparent = 'public.audit_trail'::regclass"
        )
        self.cur.execute(
            "GRANT SELECT, UPDATE, DELETE ON " + self.cur.fetchone()[0] + " TO dt_append_only_probe"
        )
        # `postgres` is not a superuser on the supabase/postgres image, so it cannot SET ROLE to a
        # role it is not a member of. It created this one and therefore holds ADMIN on it.
        self.cur.execute("GRANT dt_append_only_probe TO CURRENT_USER")
        self.cur.execute("SET LOCAL ROLE dt_append_only_probe")

    def test_an_update_is_still_refused(self):
        self.become_a_probe_role()
        # MATCHED ON THE MESSAGE, NOT THE CLASS. 0003 raises with ERRCODE =
        # insufficient_privilege, which is exactly what a missing GRANT reports too --
        # so asserting the exception type alone would pass against a probe role that
        # simply never received its privileges.
        with self.assertRaisesRegex(errors.InsufficientPrivilege, "append-only"):
            self.cur.execute(
                "UPDATE public.audit_trail SET action = 'TAMPERED' WHERE id = %s", (self.row_id,)
            )

    def test_a_delete_is_still_refused(self):
        self.become_a_probe_role()
        with self.assertRaisesRegex(errors.InsufficientPrivilege, "append-only"):
            self.cur.execute(
                "DELETE FROM public.audit_trail WHERE id = %s", (self.row_id,)
            )

    def test_an_owner_is_still_exempt(self):
        """
        The other direction, and it is not a formality: 0003 grants owners the exemption so that
        pruning detached history remains possible at all. A conversion that somehow bound
        `postgres` would make the retention workflow this migration exists to enable unrunnable.
        """
        self.cur.execute(
            "UPDATE public.audit_trail SET action = 'CORRECTED' WHERE id = %s", (self.row_id,)
        )
        self.assertEqual(1, self.cur.rowcount)

    def test_the_refusal_comes_from_the_partition_not_only_the_parent(self):
        """
        Addressed at the partition directly, which is what an owner doing maintenance would do by
        hand. A trigger declared on the parent propagates to partitions; one that did not would
        leave the audit rows editable through a name one catalogue query away.
        """
        self.cur.execute(
            "SELECT tableoid::regclass::text FROM public.audit_trail "
            "WHERE id = %s AND recorded_at = %s", (self.row_id, self.recorded_at)
        )
        partition = self.cur.fetchone()[0]
        self.become_a_probe_role()
        with self.assertRaisesRegex(errors.InsufficientPrivilege, "append-only"):
            self.cur.execute(
                f"UPDATE public.{partition} SET action = 'TAMPERED' WHERE id = %s", (self.row_id,)
            )


class MaintenanceIsIdempotentTestCase(unittest.TestCase):
    """
    The replay property, tested through the function rather than by re-running the file.

    0079's own guard is `pg_partitioned_table`, asserted by the suite above simply by the schema
    still being correct after however many boots this database has had. What this class covers is
    the part that runs on EVERY boot regardless: the partition-maintenance call at the end of the
    file, which must not accumulate partitions or duplicate its cron job.
    """

    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()

    def partition_count(self):
        self.cur.execute(
            "SELECT count(*) FROM pg_inherits WHERE inhparent = %s::regclass", (PARENT,)
        )
        return self.cur.fetchone()[0]

    def test_running_maintenance_again_creates_nothing(self):
        before = self.partition_count()
        self.cur.execute("SELECT public.ensure_audit_trail_partitions(3)")
        self.assertEqual(0, self.cur.fetchone()[0], "a second run created partitions")
        self.assertEqual(before, self.partition_count())

    def test_asking_for_more_headroom_creates_exactly_the_shortfall(self):
        before = self.partition_count()
        self.cur.execute("SELECT public.ensure_audit_trail_partitions(5)")
        created = self.cur.fetchone()[0]
        self.assertEqual(2, created, "expected two further months beyond the three already covered")
        self.assertEqual(before + 2, self.partition_count())

    def test_a_month_is_created_only_once(self):
        self.cur.execute("SELECT public.ensure_audit_trail_partition(now() + interval '9 months')")
        self.assertTrue(self.cur.fetchone()[0])
        self.cur.execute("SELECT public.ensure_audit_trail_partition(now() + interval '9 months')")
        self.assertFalse(self.cur.fetchone()[0], "the same month was created twice")

    def test_the_bounds_are_utc_regardless_of_the_session_zone(self):
        """
        THE BUG THIS EXISTS FOR IS INVISIBLE FOR HALF THE YEAR.

        date_trunc('month', ...) on a timestamptz truncates in the session's TimeZone. A partition
        created from a session in Europe/London during BST would start at 23:00 on the last day of
        the previous month, so the first hour of every month would land in the wrong partition --
        and only between March and October, which is the worst possible way for it to be wrong.
        """
        self.cur.execute("SET LOCAL TimeZone = 'Europe/London'")
        self.cur.execute("SELECT public.ensure_audit_trail_partition('2027-07-15T12:00:00Z')")
        self.assertTrue(self.cur.fetchone()[0])
        # COMPARED AS INSTANTS, NOT AS TEXT. pg_get_expr renders the bound in the SESSION's zone,
        # so under Europe/London a perfectly correct July boundary prints as
        # '2027-07-01 01:00:00+01'. Asserting on that string tests the renderer; casting it back to
        # timestamptz tests the bound, which is the thing that decides where a row lands.
        self.cur.execute(
            "SELECT (regexp_match(pg_get_expr(c.relpartbound, c.oid), $re$FROM \('([^']+)'\)$re$))[1]::timestamptz, "
            "       (regexp_match(pg_get_expr(c.relpartbound, c.oid), $re$TO \('([^']+)'\)$re$))[1]::timestamptz "
            "FROM pg_class c WHERE c.relname = 'audit_trail_2027_07'"
        )
        lower, upper = self.cur.fetchone()
        self.cur.execute(
            "SELECT '2027-07-01T00:00:00Z'::timestamptz, '2027-08-01T00:00:00Z'::timestamptz"
        )
        expected_lower, expected_upper = self.cur.fetchone()
        self.assertEqual(expected_lower, lower)
        self.assertEqual(expected_upper, upper)

    def test_the_cron_job_exists_exactly_once(self):
        # ensure_cron_job() unschedules before scheduling for this reason; a bare cron.schedule()
        # would add a duplicate job on every boot.
        self.cur.execute(
            "SELECT count(*) FROM cron.job WHERE jobname = 'audit_trail_partitions'"
        )
        self.assertEqual(1, self.cur.fetchone()[0])

    def test_negative_headroom_is_refused_rather_than_silently_doing_nothing(self):
        with self.assertRaises(errors.RaiseException):
            self.cur.execute("SELECT public.ensure_audit_trail_partitions(-1)")


class PartitionHealthTestCase(unittest.TestCase):
    """
    The view the alert reads.

    The default partition converts a coverage gap from an outage into a degradation, which is only
    an improvement if something notices. This is the something.
    """

    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()

    def test_a_healthy_stack_reports_no_default_rows(self):
        self.cur.execute("SELECT default_rows FROM public.audit_trail_partition_health")
        self.assertEqual(0, self.cur.fetchone()[0])

    def test_a_row_in_the_default_partition_is_reported(self):
        """
        The alert condition, produced rather than asserted about. A row far enough in the future to
        have no partition is exactly what a stack whose maintenance job died would start writing.
        """
        self.cur.execute(
            "INSERT INTO public.audit_trail "
            "(entity_type, entity_id, action, audit_domain, recorded_at) "
            "VALUES ('cells', %s, 'INSERT', 'asset', now() + interval '20 years')",
            (str(uuid.uuid4()),),
        )
        self.cur.execute("SELECT default_rows FROM public.audit_trail_partition_health")
        self.assertEqual(
            1, self.cur.fetchone()[0],
            "a row with no month of its own was not reported in the default partition",
        )

    def test_the_view_is_not_readable_by_an_application_role(self):
        # It counts audit rows. Nothing that reads it needs to be an application role -- Grafana
        # reads as service_role, and `authenticated` has no business with partition internals.
        self.cur.execute(
            "SELECT has_table_privilege('authenticated', "
            "'public.audit_trail_partition_health', 'SELECT')"
        )
        self.assertFalse(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)

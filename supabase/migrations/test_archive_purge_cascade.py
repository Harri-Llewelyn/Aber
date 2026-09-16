"""
Deleting a cell un-files what was in it (0112), rather than deleting it on the cell's timer.

Run against the migrated Supabase Postgres -- `npm run test:db` gives it a throwaway one.

WHAT WENT WRONG, AND WHERE IT WAS REACHABLE FROM. `gateways_cell_id_fkey` shipped ON DELETE
CASCADE, alone among the children of `cells`. Nothing in the dashboard deletes an asset from its
own page -- cells, gateways and devices are archived -- so the DELETE is reached from exactly two
places, and both were affected: the Archived Entities page's Permanent Delete, and
`purge_expired_archives`, which deletes rows whose `auto_delete_at` has passed. A gateway archived
with Permanent Retention was therefore deleted anyway when its CELL's 30-day timer expired, having
been given a retention it was not kept on.

The tests below pin the repair three ways, because a schema fact, a behaviour and a scheduled job
are three things that can drift apart: no child of `cells` cascades, an actual delete leaves the
children with their own timers, and the job still deletes children first.
"""
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Pinned so a run that dies before teardown leaves nothing a later run collides with, and
# DIFFERING IN THE EARLY BLOCKS: `sparkplug_id` is generated from the first 21 hex characters of
# the uuid, so ids that differ only in the last block collide on a unique index.
CELL = "7c000000-0000-4000-8000-000000000001"
GATEWAY = "7a100000-0000-4000-8000-000000000001"
DEVICE = "7d200000-0000-4000-8000-000000000001"

DUE = "now() - interval '1 day'"


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
                            user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def cleanup(cur):
    cur.execute("DELETE FROM public.devices WHERE id = %s;", (DEVICE,))
    cur.execute("DELETE FROM public.gateways WHERE id = %s;", (GATEWAY,))
    cur.execute("DELETE FROM public.cells WHERE id = %s;", (CELL,))


class PurgeCascadeTests(unittest.TestCase):
    """
    One archived cell whose timer has expired, holding a gateway and a device that are NOT due:
    the shape `purge_expired_archives` meets on the night a cell's retention runs out.
    """

    def setUp(self):
        self.conn = connect()
        self.cur = self.conn.cursor()
        cleanup(self.cur)
        self.cur.execute(
            f"""
            INSERT INTO public.cells (id, name, is_archived, archived_at, auto_delete_at)
                 VALUES (%s, 'Purge Test Cell', true, now(), {DUE});
            """,
            (CELL,),
        )
        # Permanent Retention, which is what the dialog calls a NULL timer, and the case the
        # cascade contradicted most directly.
        self.cur.execute(
            """
            INSERT INTO public.gateways (id, name, cell_id, deployment, is_archived, archived_at,
                                         auto_delete_at)
                 VALUES (%s, 'Purge Test Gateway', %s, 'remote', true, now(), NULL);
            """,
            (GATEWAY, CELL),
        )
        # Not archived at all: a live device filed into a cell somebody archived months ago.
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, cell_id) VALUES (%s, 'Purge Test Device', %s, %s);",
            (DEVICE, GATEWAY, CELL),
        )
        self.conn.commit()

    def tearDown(self):
        self.conn.rollback()
        cleanup(self.cur)
        self.conn.commit()
        self.conn.close()

    def delete_the_cell(self):
        """The purge statement, narrowed to this suite's row so a shared database is untouched."""
        self.cur.execute(
            "DELETE FROM public.cells WHERE id = %s AND is_archived "
            "AND auto_delete_at IS NOT NULL AND auto_delete_at <= now();",
            (CELL,),
        )
        self.assertEqual(self.cur.rowcount, 1, "the fixture cell was not due; the rest proves nothing")

    def test_no_child_of_cells_is_deleted_with_it(self):
        # THE CATALOGUE FACT, asserted over every referencing constraint rather than the one that
        # was wrong: the next child table added to `cells` inherits this test.
        self.cur.execute(
            """
            SELECT conrelid::regclass::text, conname, confdeltype
              FROM pg_constraint
             WHERE contype = 'f' AND confrelid = 'public.cells'::regclass
               AND confdeltype = 'c';
            """
        )
        offenders = self.cur.fetchall()
        self.assertEqual(
            [], offenders,
            "a foreign key into public.cells is ON DELETE CASCADE, so deleting a cell deletes "
            "rows that carry retention timers of their own",
        )

    def test_the_gateway_survives_its_cell_with_its_own_timer_intact(self):
        self.delete_the_cell()
        self.cur.execute(
            "SELECT cell_id, is_archived, auto_delete_at FROM public.gateways WHERE id = %s;",
            (GATEWAY,),
        )
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "the gateway was deleted with its cell")
        self.assertIsNone(row[0], "the gateway kept a cell_id pointing at a deleted cell")
        self.assertTrue(row[1], "the un-filing changed whether the gateway is archived")
        self.assertIsNone(row[2], "Permanent Retention was not kept")

    def test_a_live_device_survives_the_cell_it_was_filed_into(self):
        self.delete_the_cell()
        self.cur.execute("SELECT cell_id FROM public.devices WHERE id = %s;", (DEVICE,))
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "a device that was never archived was deleted by a cell's timer")
        self.assertIsNone(row[0])

    def test_the_un_filing_is_recorded_against_the_gateway(self):
        # The lineage is not lost with the cell: a SET NULL is an UPDATE, so the audit trigger
        # fires and `old_data` still names the cell the gateway was filed into.
        self.delete_the_cell()
        self.conn.commit()
        self.cur.execute(
            """
            SELECT 1 FROM public.digital_thread
             WHERE entity_type = 'gateways' AND entity_id = %s AND action = 'UPDATE'
               AND old_data ->> 'cell_id' = %s AND new_data ->> 'cell_id' IS NULL
             LIMIT 1;
            """,
            (GATEWAY, CELL),
        )
        self.assertIsNotNone(
            self.cur.fetchone(),
            "nothing in the digital thread says which cell the gateway was un-filed from",
        )

    def test_the_purge_job_still_deletes_children_before_parents(self):
        # Ordering is what makes a child that IS due get deleted as itself, with its own audit
        # row, rather than being un-filed a second earlier and recorded as already orphaned.
        self.cur.execute("SELECT command FROM cron.job WHERE jobname = 'purge_expired_archives';")
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "purge_expired_archives is not scheduled")
        command = row[0]
        order = [command.index(f"DELETE FROM public.{table}")
                 for table in ("devices", "gateways", "cells")]
        self.assertEqual(sorted(order), order,
                         "purge_expired_archives no longer deletes devices, then gateways, then cells")


if __name__ == "__main__":
    unittest.main(verbosity=2)

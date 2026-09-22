"""
Archiving an asset is a lifecycle rather than a flag (0124).

    python supabase/migrations/test_archiving_is_a_lifecycle.py

Requires the Supabase database (54322 by default) and 0124 applied; `npm run test:db` gives it a
throwaway one.

---------------------------------------------------------------------------------------------
FOUR THINGS, EACH PINNED WHERE IT COULD DRIFT.

An area archives like everything else, and archiving it MOVES NOTHING: the cells stay filed in it
and `device_locations` goes on answering the same area, so every uns/ topic beneath it keeps its
name. That is the decision the roadmap entry asked to have settled before the migration, and it is
asserted against the view rather than described in a comment.

The purge job names areas, after cells, and skips an area an Area-Wide asset still names. The skip
matters more than the delete: the job is one transaction, and a refused DELETE would roll back the
three deletes above it every night until somebody noticed.

A replay lane follows its original through archive, restore and delete. Before 0124 the lane was
left live on the playback gateway when its original was archived, and left standing in for nothing
when it was deleted.

A deleted row that had been archived leaves a tombstone, and one that had not does not. The
tombstone names the DELETE audit row of the same transaction, which is the assertion that the two
triggers fire in the order the migration relies on.

EVERY TEST ROLLS BACK. Writes to the asset tables fire the digital-thread trigger, and that table
is append-only to every application role.
"""
import json
import os
import unittest
import uuid

import psycopg2
import psycopg2.extras

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

FOREIGN_KEY_VIOLATION = "23503"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class LifecycleBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SELECT to_regclass('public.retired_entities');")
            if not cur.fetchone()[0]:
                raise unittest.SkipTest("0124 has not been applied")
        finally:
            conn.rollback()
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- fixtures ---------------------------------------------------------------------------

    def area(self, name=None, **cols):
        aid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.areas (id, name, is_archived, archived_at, auto_delete_at) "
            "VALUES (%s, %s, %s, %s, %s);",
            (aid, name or f"Lifecycle_Area_{aid[:8]}", cols.get("is_archived", False),
             cols.get("archived_at"), cols.get("auto_delete_at")),
        )
        return aid

    def cell(self, area_id=None):
        cid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.cells (id, name, area_id) VALUES (%s, %s, %s);",
            (cid, f"Lifecycle_Cell_{cid[:8]}", area_id),
        )
        return cid

    def gateway(self, cell_id=None, **flags):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, cell_id, location_scope, deployment, "
            "is_simulated, is_shadow) VALUES (%s, %s, %s, 'cell', %s, %s, %s);",
            (gid, f"Lifecycle_GW_{gid[:8]}", cell_id, flags.get("deployment", "remote"),
             flags.get("is_simulated", False), flags.get("is_shadow", False)),
        )
        return gid

    def device(self, gateway_id=None, shadow_of=None, cell_id=None, **cols):
        did = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, shadow_of, cell_id, status, "
            "is_archived, archived_at, auto_delete_at) "
            "VALUES (%s, %s, %s, %s, %s, 'OFFLINE', %s, %s, %s);",
            (did, f"Lifecycle_Dev_{did[:8]}", gateway_id, shadow_of, cell_id,
             cols.get("is_archived", False), cols.get("archived_at"), cols.get("auto_delete_at")),
        )
        return did

    def archive(self, table, row_id, days=30):
        self.cur.execute(
            f"UPDATE public.{table} SET is_archived = true, archived_at = now(), "
            f"auto_delete_at = now() + make_interval(days => %s) WHERE id = %s;",
            (days, row_id),
        )

    def restore(self, table, row_id):
        self.cur.execute(
            f"UPDATE public.{table} SET is_archived = false, archived_at = NULL, "
            f"auto_delete_at = NULL WHERE id = %s;",
            (row_id,),
        )

    def row(self, table, row_id):
        self.cur.execute(f"SELECT * FROM public.{table} WHERE id = %s;", (row_id,))
        return self.cur.fetchone()

    def tombstone(self, entity_type, entity_id):
        self.cur.execute(
            "SELECT * FROM public.retired_entities WHERE entity_type = %s AND entity_id = %s;",
            (entity_type, entity_id),
        )
        return self.cur.fetchone()


class AreasArchiveLikeEverythingElse(LifecycleBase):
    def test_an_area_has_the_three_lifecycle_columns(self):
        self.cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'areas' "
            "AND column_name IN ('is_archived', 'archived_at', 'auto_delete_at');"
        )
        self.assertEqual(
            {"is_archived", "archived_at", "auto_delete_at"},
            {r["column_name"] for r in self.cur.fetchall()},
        )

    def test_archiving_an_area_moves_nothing_beneath_it(self):
        """
        THE TOPIC DECISION. `areas.name` is the <area> segment of every uns/ topic under it, so an
        archived area either keeps publishing its name or every cell below it silently moves. It
        keeps its name: the view that answers where a device is does not read the flag, which is
        already how an archived cell behaves.
        """
        area = self.area()
        cell = self.cell(area_id=area)
        gateway = self.gateway(cell_id=cell)
        device = self.device(gateway_id=gateway)

        self.cur.execute(
            "SELECT effective_area_id, effective_cell_id, location_source "
            "FROM public.device_locations WHERE device_id = %s;", (device,))
        before = self.cur.fetchone()
        self.assertEqual(str(before["effective_area_id"]), area)

        self.archive("areas", area)

        self.cur.execute(
            "SELECT effective_area_id, effective_cell_id, location_source "
            "FROM public.device_locations WHERE device_id = %s;", (device,))
        after = self.cur.fetchone()
        self.assertEqual(before, after, "archiving the area changed where its devices resolve")
        self.assertEqual(str(self.row("cells", cell)["area_id"]), area,
                         "archiving the area un-filed its cells")

    def test_an_archived_area_cannot_be_proposed_against(self):
        """0123's arm had no archived test because there was nothing to test; now there is."""
        area = self.area(is_archived=True, archived_at="2026-01-01T00:00:00Z")
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation) as ctx:
            self.cur.execute(
                "INSERT INTO public.change_proposals (entity_type, entity_id, patch) "
                "VALUES ('areas', %s, %s::jsonb);",
                (area, json.dumps({"name": "Renamed"})),
            )
        self.assertEqual(ctx.exception.pgcode, FOREIGN_KEY_VIOLATION)
        self.assertIn("no live target", str(ctx.exception))

    def test_a_live_area_can_still_be_proposed_against(self):
        # `proposed_by` defaults to auth.uid(), which is null on this owner connection, so it is
        # given; the archived case above never reaches that constraint because the BEFORE trigger
        # refuses first.
        area = self.area()
        self.cur.execute(
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch, proposed_by) "
            "VALUES ('areas', %s, %s::jsonb, %s) RETURNING id;",
            (area, json.dumps({"name": "Renamed"}), str(uuid.uuid4())),
        )
        self.assertIsNotNone(self.cur.fetchone())


class ThePurgeJobNamesAreas(LifecycleBase):
    def job(self):
        self.cur.execute("SELECT command FROM cron.job WHERE jobname = 'purge_expired_archives';")
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "purge_expired_archives is not scheduled")
        return row["command"]

    def test_areas_are_deleted_last(self):
        command = self.job()
        order = [command.index(f"DELETE FROM public.{table}")
                 for table in ("devices", "gateways", "cells", "areas")]
        self.assertEqual(sorted(order), order,
                         "purge_expired_archives does not delete devices, gateways, cells, areas in that order")

    def test_the_job_skips_an_area_an_area_wide_asset_still_names(self):
        # `devices.area_id` has no ON DELETE action, so the delete would be refused -- and the job
        # is one transaction. The guard is asserted in the job's own text and then exercised.
        command = self.job()
        self.assertIn("NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.area_id = a.id)", command)
        self.assertIn("NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.area_id = a.id)", command)

        named = self.area(is_archived=True, archived_at="2026-01-01T00:00:00Z",
                          auto_delete_at="2026-01-02T00:00:00Z")
        unnamed = self.area(is_archived=True, archived_at="2026-01-01T00:00:00Z",
                            auto_delete_at="2026-01-02T00:00:00Z")
        self.cur.execute(
            "INSERT INTO public.devices (id, name, location_scope, area_id, status) "
            "VALUES (%s, 'Lifecycle_BMS', 'area_wide', %s, 'OFFLINE');",
            (str(uuid.uuid4()), named),
        )

        # The job's areas statement, narrowed to this suite's two rows.
        self.cur.execute(
            "DELETE FROM public.areas a "
            "WHERE a.is_archived AND a.auto_delete_at IS NOT NULL AND a.auto_delete_at <= NOW() "
            "AND NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.area_id = a.id) "
            "AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.area_id = a.id) "
            "AND a.id IN (%s, %s);",
            (named, unnamed),
        )
        self.assertEqual(self.cur.rowcount, 1)
        self.assertIsNotNone(self.row("areas", named), "the area an asset names was deleted")
        self.assertIsNone(self.row("areas", unnamed), "the area nothing names survived its timer")


class AShadowFollowsItsOriginal(LifecycleBase):
    def setUp(self):
        super().setUp()
        self.real = self.gateway()
        self.playback = self.gateway(deployment="host", is_simulated=True, is_shadow=True)
        self.origin = self.device(gateway_id=self.real)
        self.lane = self.device(gateway_id=self.playback, shadow_of=self.origin)

    def test_archiving_the_original_archives_its_lane_with_the_same_timer(self):
        self.archive("devices", self.origin, days=90)
        origin, lane = self.row("devices", self.origin), self.row("devices", self.lane)
        self.assertTrue(lane["is_archived"], "the lane stayed live on the playback gateway")
        self.assertEqual(lane["archived_at"], origin["archived_at"])
        self.assertEqual(lane["auto_delete_at"], origin["auto_delete_at"])

    def test_restoring_the_original_restores_its_lane(self):
        self.archive("devices", self.origin)
        self.restore("devices", self.origin)
        lane = self.row("devices", self.lane)
        self.assertFalse(lane["is_archived"])
        self.assertIsNone(lane["archived_at"])
        self.assertIsNone(lane["auto_delete_at"])

    def test_an_ordinary_edit_to_an_archived_original_leaves_the_lane_alone(self):
        # The transition guard. PostgREST sends the whole row on a PATCH, so `is_archived` is
        # mentioned by every edit; a lane restored by hand must not be re-archived by a rename.
        self.archive("devices", self.origin)
        self.restore("devices", self.lane)
        self.cur.execute(
            "UPDATE public.devices SET name = 'Renamed', is_archived = true WHERE id = %s;",
            (self.origin,),
        )
        self.assertFalse(self.row("devices", self.lane)["is_archived"])

    def test_deleting_the_original_deletes_its_lane_first(self):
        # Before 0124 the FK SET NULL left a lane standing in for nothing. It still would, for a
        # lane whose original went before this file; a delete now takes the lane with it.
        self.archive("devices", self.origin)
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (self.origin,))
        self.assertIsNone(self.row("devices", self.lane), "the lane outlived its original")
        # Both are tombstoned by the one act.
        self.assertIsNotNone(self.tombstone("devices", self.origin))
        self.assertIsNotNone(self.tombstone("devices", self.lane))

    def test_a_lane_of_a_different_original_is_untouched(self):
        other = self.device(gateway_id=self.real)
        other_lane = self.device(gateway_id=self.playback, shadow_of=other)
        self.archive("devices", self.origin)
        self.assertFalse(self.row("devices", other_lane)["is_archived"])


class ADeletedAssetLeavesATombstone(LifecycleBase):
    def test_an_archived_device_is_tombstoned_with_its_row_and_its_audit_id(self):
        gateway = self.gateway()
        device = self.device(gateway_id=gateway)
        self.archive("devices", device)
        before = self.row("devices", device)

        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (device,))

        stone = self.tombstone("devices", device)
        self.assertIsNotNone(stone, "no tombstone for an archived device that was deleted")
        self.assertEqual(stone["name"], before["name"])
        self.assertEqual(stone["sparkplug_id"], before["sparkplug_id"])
        self.assertEqual(stone["archived_at"], before["archived_at"])
        self.assertEqual(stone["old_data"]["gateway_id"], gateway)

        # THE ORDERING THE MIGRATION RELIES ON: the audit trigger has already written the DELETE
        # row when the tombstone trigger looks for it, so thread_id is set and names that row.
        self.assertIsNotNone(stone["thread_id"], "the tombstone found no DELETE audit row")
        self.cur.execute("SELECT entity_type, entity_id, action FROM public.digital_thread WHERE id = %s;",
                         (stone["thread_id"],))
        thread = self.cur.fetchone()
        self.assertEqual((thread["entity_type"], str(thread["entity_id"]), thread["action"]),
                         ("devices", device, "DELETE"))

    def test_a_row_that_was_never_archived_leaves_none(self):
        # A device rejected from quarantine, a fixture removed: never in service, no tombstone.
        device = self.device(gateway_id=self.gateway())
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (device,))
        self.assertIsNone(self.tombstone("devices", device))

    def test_every_asset_table_writes_one(self):
        area = self.area(is_archived=True, archived_at="2026-01-01T00:00:00Z")
        cell = self.cell()
        gateway = self.gateway()
        self.archive("cells", cell)
        self.archive("gateways", gateway)
        for table, row_id in (("areas", area), ("cells", cell), ("gateways", gateway)):
            self.cur.execute(f"DELETE FROM public.{table} WHERE id = %s;", (row_id,))
            self.assertIsNotNone(self.tombstone(table, row_id), f"no tombstone for {table}")

    def test_a_pinned_id_deleted_twice_keeps_the_latest_retirement(self):
        gateway = self.gateway()
        pinned = str(uuid.uuid4())
        for name in ("First_Life", "Second_Life"):
            self.cur.execute(
                "INSERT INTO public.devices (id, name, gateway_id, status, is_archived, archived_at) "
                "VALUES (%s, %s, %s, 'OFFLINE', true, now());", (pinned, name, gateway))
            self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (pinned,))
        self.assertEqual(self.tombstone("devices", pinned)["name"], "Second_Life")

    def test_nothing_but_the_trigger_can_write_one(self):
        self.cur.execute(
            "SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'retired_entities';")
        self.assertEqual({r["cmd"] for r in self.cur.fetchall()}, {"SELECT"})
        self.cur.execute(
            "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.retired_entities'::regclass;")
        self.assertTrue(self.cur.fetchone()["relrowsecurity"])
        self.cur.execute(
            "SELECT has_table_privilege('authenticated', 'public.retired_entities', 'INSERT') AS ins, "
            "has_table_privilege('anon', 'public.retired_entities', 'SELECT') AS anon_sel;")
        grants = self.cur.fetchone()
        self.assertFalse(grants["ins"], "authenticated holds INSERT on retired_entities")
        self.assertFalse(grants["anon_sel"], "anon can read retired_entities")


class AnExportReachesTheThread(LifecycleBase):
    def test_recording_an_export_writes_an_exported_row(self):
        device = self.device(gateway_id=self.gateway())
        self.cur.execute(
            "INSERT INTO public.asset_exports (entity_id, name, sparkplug_id, object_bucket, "
            "object_key, object_bytes, stats) VALUES (%s, 'Lifecycle_Dev', 'spb', "
            "'telemetry-archive', %s, 1234, '{\"telemetry_rows\": 10}'::jsonb) RETURNING id;",
            (device, f"assets/test/{uuid.uuid4()}.aasx"),
        )
        export_id = self.cur.fetchone()["id"]
        self.cur.execute(
            "SELECT action, audit_domain, new_data FROM public.digital_thread "
            "WHERE entity_type = 'devices' AND entity_id = %s AND action = 'EXPORTED';", (device,))
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "the export did not reach the digital thread")
        self.assertEqual(row["audit_domain"], "asset")
        self.assertEqual(row["new_data"]["id"], str(export_id))

    def test_the_export_table_is_read_by_the_roles_the_bucket_admits(self):
        self.cur.execute(
            "SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'asset_exports' "
            "AND cmd = 'SELECT';")
        row = self.cur.fetchone()
        self.assertIsNotNone(row)
        for role in ("Administrator", "Shopfloor_Manager", "Auditor"):
            self.assertIn(role, row["qual"])
        self.assertNotIn("Operator", row["qual"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

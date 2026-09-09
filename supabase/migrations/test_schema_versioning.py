"""
PostgreSQL integration test suite for strict schema versioning (archived migration 0037).

Genuinely exercises the deployed SQL -- the `prevent_active_schema_mutation()` and
`enforce_schema_version_provenance()` triggers, and the `fork_schema()` /
`publish_schema_version()` RPCs -- by running them in PostgreSQL under the `authenticated` role
with simulated JWT claims, exactly as PostgREST would.

RUNNING AS `authenticated` IS THE WHOLE POINT, not incidental. The immutability guard deliberately
exempts non-app roles: migrations 0019 and 0033 rewrite seeded schemas by name on every boot, so a
guard that bound `postgres` would stop the stack booting the first time anyone published a v2. A
suite that connected as `postgres` and asserted "the edit was blocked" would therefore be asserting
something the guard does not claim -- and would pass just as happily against a database where the
trigger had been dropped.

Two things have to be true before the guard is even reachable, and both were failure modes while
this was written:
  * the JWT claims must name a schema-managing role, or the RLS policy on `schemas` filters the
    UPDATE to zero rows and it "succeeds" without ever reaching the trigger;
  * `auth.users` must contain the acting user, because `log_digital_thread_event()` writes
    `changed_by = auth.uid()` under an FK -- so publishing, which repoints devices, fails on the
    audit insert rather than on anything to do with versioning.

Every test runs inside a transaction that is rolled back, so the suite seeds freely and leaves
nothing behind.
"""
import json
import os
import unittest

import psycopg2
from psycopg2 import errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN_USER_ID = "a0000000-0000-4000-8000-000000000001"
OPERATOR_USER_ID = "a0000000-0000-4000-8000-000000000003"
# Added with 0087. A Shopfloor_Manager is the persona the two schema RPCs used to admit and
# the RLS policies on `schemas` did not, which is the disagreement 0087 closes.
MANAGER_USER_ID = "a0000000-0000-4000-8000-000000000002"

# roles.id values seeded by migration 20260101000003. Matching test_user_roles_rls.py.
ROLE_ADMINISTRATOR = 1
ROLE_OPERATOR = 3
ROLE_SHOPFLOOR_MANAGER = 2

BASE_DEFINITION = {
    "type": "object",
    "properties": {
        "Systems/TEMPERATURE": {"type": "number"},
        "Controller/EXECUTION": {"type": "string"},
    },
    "required": ["Systems/TEMPERATURE"],
}


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class SchemaVersioningTestCase(unittest.TestCase):
    """Shared fixtures. Each test gets a fresh transaction and rolls it back."""

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SELECT to_regclass('public.schemas');")
            if not cur.fetchone()[0]:
                raise RuntimeError("public.schemas does not exist -- migrations have not been applied.")

            # Fail loudly and specifically if 0037 has not been applied, rather than letting every
            # test fail on "column does not exist" and leaving the cause to be inferred.
            cur.execute(
                """
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'schemas'
                   AND column_name IN ('version', 'parent_schema_id', 'status', 'change_description');
                """
            )
            if cur.fetchone()[0] != 4:
                raise RuntimeError(
                    "public.schemas is missing the versioning columns -- "
                    "20260101000037_schema_versioning.sql has not been applied."
                )

            cur.execute(
                """
                SELECT count(*) FROM pg_proc p
                  JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public'
                   AND p.proname IN ('fork_schema', 'publish_schema_version',
                                     'prevent_active_schema_mutation',
                                     'enforce_schema_version_provenance',
                                     'schema_version_base_name');
                """
            )
            if cur.fetchone()[0] < 5:
                raise RuntimeError("archived migration 0037's functions are not all present in the database.")

            conn.commit()
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self._grant_roles()

    def tearDown(self):
        # Everything the test did, including the fixtures, disappears here.
        self.conn.rollback()
        self.conn.close()

    # ------------------------------------------------------------------ helpers

    def _grant_roles(self):
        """
        Give the two acting users their roles, and make them exist in `auth.users`.

        The second half is not optional and is easy to mistake for boilerplate:
        `log_digital_thread_event()` writes `changed_by = auth.uid()` under a foreign key to
        `auth.users`, so without these rows the publish tests fail on the AUDIT insert -- with an
        FK error naming `digital_thread`, which reads like a fault in the audit trail rather than
        a missing fixture.
        """
        for user_id in (ADMIN_USER_ID, OPERATOR_USER_ID, MANAGER_USER_ID):
            # auth.users differs between GoTrue's real schema and the base image's legacy one, so
            # try the intersection (the primary key alone) first and fall back to the fuller shape.
            # Each attempt is savepointed: a failure here must not abort the whole transaction.
            for columns, values in (
                # THE EMAILED SHAPE IS TRIED FIRST, and the order is the whole point rather than a preference.
                # `is_machine_principal()` is "no email, no password, no identity provider", so an id-only row is
                # indistinguishable from one of the stack's own service identities -- and 0080 puts a trigger on
                # `user_roles` refusing a role to anything that predicate recognises. A persona standing in for a
                # PERSON must look like one, or the fixture cannot be given the role it is testing. This also
                # settles a complaint serviceIdentities.js already recorded: suite-seeded rows were showing up on
                # the Access Control page as "Undocumented principal".
                ("(instance_id, id, aud, role, email)",
                 ("00000000-0000-0000-0000-000000000000", user_id, "authenticated",
                  "authenticated", f"{user_id}@versioning.test")),
                ("(id)", (user_id,)),
            ):
                self.cur.execute("SAVEPOINT ensure_user;")
                try:
                    self.cur.execute(
                        f"INSERT INTO auth.users {columns} VALUES "
                        f"({', '.join(['%s'] * len(values))}) ON CONFLICT (id) DO NOTHING;",
                        values,
                    )
                    self.cur.execute("RELEASE SAVEPOINT ensure_user;")
                    break
                except psycopg2.Error:
                    self.cur.execute("ROLLBACK TO SAVEPOINT ensure_user;")
            else:
                raise RuntimeError(
                    f"could not create auth.users row {user_id}; digital_thread.changed_by is "
                    "an FK to it, so the publish tests cannot run"
                )

        self.cur.execute(
            """
            INSERT INTO public.user_roles (user_id, role_id)
            VALUES (%s, %s), (%s, %s), (%s, %s)
            ON CONFLICT (user_id, role_id) DO NOTHING;
            """,
            (ADMIN_USER_ID, ROLE_ADMINISTRATOR, OPERATOR_USER_ID, ROLE_OPERATOR,
             MANAGER_USER_ID, ROLE_SHOPFLOOR_MANAGER),
        )

    def _act_as(self, user_id, role_name):
        """Become `authenticated` with the JWT claims PostgREST would have set."""
        claims = json.dumps({"sub": user_id, "app_metadata": {"role": role_name}})
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (claims,))
        self.cur.execute("SET LOCAL ROLE authenticated;")

    def _act_as_owner(self):
        """Back to the migration/superuser context, where the guard deliberately does not apply."""
        self.cur.execute("RESET ROLE;")

    def _seed_schema(self, name, status="active", definition=None, change_description=None):
        """
        Insert a schema directly, as the owner -- fixtures bypass the provenance trigger.

        `id::text`, here and in `_fetch`, so every id in this suite is a string. `fork_schema()`
        and `publish_schema_version()` return JSONB, in which a UUID is text; comparing that
        against a driver-typed value is a mismatch that reads as a wrong id rather than as a wrong
        type. One representation throughout removes the question.
        """
        self.cur.execute(
            """
            INSERT INTO public.schemas
                   (schema_name, description, schema_definition, status, change_description)
            VALUES (%s, %s, %s::jsonb, %s, %s)
            RETURNING id::text, version, status, schema_definition;
            """,
            (
                name,
                "versioning test fixture",
                json.dumps(definition or BASE_DEFINITION),
                status,
                change_description,
            ),
        )
        return self.cur.fetchone()

    def _fetch(self, schema_id):
        self.cur.execute(
            """
            SELECT schema_name, version, status, parent_schema_id::text, change_description,
                   schema_definition
              FROM public.schemas WHERE id = %s;
            """,
            (schema_id,),
        )
        row = self.cur.fetchone()
        if row is None:
            return None
        return {
            "schema_name": row[0], "version": row[1], "status": row[2],
            "parent_schema_id": row[3], "change_description": row[4],
            "schema_definition": row[5],
        }

    def _fork(self, parent_id, change_description=None):
        self.cur.execute(
            "SELECT public.fork_schema(%s, %s);", (parent_id, change_description)
        )
        return self.cur.fetchone()[0]

    def _publish(self, draft_id):
        self.cur.execute("SELECT public.publish_schema_version(%s);", (draft_id,))
        return self.cur.fetchone()[0]

    def assertRaisesInStatement(self, callable_, *, message_contains=None):
        """
        Run something expected to raise, contained in a savepoint so the transaction survives.

        Returns the exception, so a caller can assert on the SQLSTATE as well as the wording.
        """
        self.cur.execute("SAVEPOINT expect_failure;")
        try:
            callable_()
        except psycopg2.Error as exc:
            self.cur.execute("ROLLBACK TO SAVEPOINT expect_failure;")
            if message_contains:
                self.assertIn(
                    message_contains.lower(), str(exc).lower(),
                    f"raised, but not for the expected reason: {exc}",
                )
            return exc
        self.cur.execute("ROLLBACK TO SAVEPOINT expect_failure;")
        self.fail("expected the statement to raise, but it succeeded")


class TestImmutability(SchemaVersioningTestCase):
    """An active or archived version is frozen for app-facing roles."""

    def test_editing_an_active_schema_definition_raises(self):
        schema_id, _, _, _ = self._seed_schema("TESTVER_Immutable_Definition")
        self._act_as(ADMIN_USER_ID, "Administrator")

        exc = self.assertRaisesInStatement(
            lambda: self.cur.execute(
                "UPDATE public.schemas SET schema_definition = '{\"type\":\"object\"}'::jsonb WHERE id = %s;",
                (schema_id,),
            ),
            message_contains="immutable",
        )
        # The message has to name the way forward, not just refuse -- an operator who is told
        # "immutable" and nothing else has no next step.
        self.assertIn("fork_schema", str(exc))

    def test_editing_active_schema_metadata_raises(self):
        """`description`, not just the definition. Metadata is part of the frozen record."""
        schema_id, _, _, _ = self._seed_schema("TESTVER_Immutable_Metadata")
        self._act_as(ADMIN_USER_ID, "Administrator")

        self.assertRaisesInStatement(
            lambda: self.cur.execute(
                "UPDATE public.schemas SET description = 'rewritten' WHERE id = %s;", (schema_id,)
            ),
            message_contains="immutable",
        )

    def test_editing_active_schema_change_description_raises(self):
        """The reason a version exists cannot be rewritten after the fact."""
        schema_id, _, _, _ = self._seed_schema(
            "TESTVER_Immutable_Change", change_description="Initial release"
        )
        self._act_as(ADMIN_USER_ID, "Administrator")

        self.assertRaisesInStatement(
            lambda: self.cur.execute(
                "UPDATE public.schemas SET change_description = 'something else' WHERE id = %s;",
                (schema_id,),
            ),
            message_contains="immutable",
        )

    def test_renaming_an_active_schema_raises(self):
        schema_id, _, _, _ = self._seed_schema("TESTVER_Immutable_Name")
        self._act_as(ADMIN_USER_ID, "Administrator")

        self.assertRaisesInStatement(
            lambda: self.cur.execute(
                "UPDATE public.schemas SET schema_name = 'TESTVER_Renamed' WHERE id = %s;",
                (schema_id,),
            ),
            message_contains="immutable",
        )

    def test_editing_an_archived_schema_raises(self):
        schema_id, _, _, _ = self._seed_schema("TESTVER_Archived_Frozen", status="archived")
        self._act_as(ADMIN_USER_ID, "Administrator")

        self.assertRaisesInStatement(
            lambda: self.cur.execute(
                "UPDATE public.schemas SET description = 'rewritten history' WHERE id = %s;",
                (schema_id,),
            ),
            message_contains="immutable",
        )

    def test_editing_a_draft_succeeds(self):
        """The guard is not a blanket freeze -- a draft is exactly what stays editable."""
        schema_id, _, _, _ = self._seed_schema("TESTVER_Draft_Editable", status="draft")
        self._act_as(ADMIN_USER_ID, "Administrator")

        widened = dict(BASE_DEFINITION)
        widened["properties"] = dict(BASE_DEFINITION["properties"])
        widened["properties"]["OEE/QUALITY"] = {"type": "number"}

        self.cur.execute(
            "UPDATE public.schemas SET schema_definition = %s::jsonb WHERE id = %s;",
            (json.dumps(widened), schema_id),
        )
        self.assertEqual(self.cur.rowcount, 1, "a draft must be editable by a schema manager")

        self._act_as_owner()
        self.assertIn("OEE/QUALITY", self._fetch(schema_id)["schema_definition"]["properties"])

    def test_archived_schema_cannot_be_reactivated(self):
        """
        Binds every caller, including the owner -- history that can be re-opened is not history.
        """
        schema_id, _, _, _ = self._seed_schema("TESTVER_No_Reactivation", status="archived")

        self.assertRaisesInStatement(
            lambda: self.cur.execute(
                "UPDATE public.schemas SET status = 'active' WHERE id = %s;", (schema_id,)
            ),
            message_contains="illegal schema status transition",
        )

    def test_active_schema_cannot_be_reopened_as_draft(self):
        schema_id, _, _, _ = self._seed_schema("TESTVER_No_Reopen")

        self.assertRaisesInStatement(
            lambda: self.cur.execute(
                "UPDATE public.schemas SET status = 'draft' WHERE id = %s;", (schema_id,)
            ),
            message_contains="illegal schema status transition",
        )

    def test_owner_context_is_exempt_from_the_freeze(self):
        """
        Migrations 0019 and 0033 UPDATE seeded schemas by name on every boot. If the guard bound
        the owner too, db-init would start failing the first time a user published a v2 -- the
        stack would stop booting because someone used the feature. Pinned so a later "tighten the
        guard" change has to confront that.
        """
        schema_id, _, _, _ = self._seed_schema("TESTVER_Owner_Exempt")
        self.cur.execute(
            "UPDATE public.schemas SET description = 'rewritten by a migration' WHERE id = %s;",
            (schema_id,),
        )
        self.assertEqual(self.cur.rowcount, 1)


class TestVersionProvenance(SchemaVersioningTestCase):
    """A version number is derived. It can never be supplied."""

    def test_direct_insert_of_a_version_raises(self):
        parent_id, _, _, _ = self._seed_schema("TESTVER_Provenance_Parent")
        self._act_as(ADMIN_USER_ID, "Administrator")

        self.assertRaisesInStatement(
            lambda: self.cur.execute(
                """
                INSERT INTO public.schemas
                       (schema_name, schema_definition, version, parent_schema_id, status)
                VALUES ('TESTVER_Forged_v7', '{"type":"object"}'::jsonb, 7, %s, 'draft');
                """,
                (parent_id,),
            ),
            message_contains="cannot be created directly",
        )

    def test_direct_insert_of_a_v1_root_is_allowed(self):
        """Creating a brand new schema is still an ordinary insert -- only versions are gated."""
        self._act_as(ADMIN_USER_ID, "Administrator")
        self.cur.execute(
            """
            INSERT INTO public.schemas (schema_name, schema_definition)
            VALUES ('TESTVER_New_Root', '{"type":"object","properties":{"a":{"type":"number"}}}'::jsonb)
            RETURNING version, status, parent_schema_id;
            """
        )
        version, status, parent = self.cur.fetchone()
        self.assertEqual((version, status, parent), (1, "active", None))

    def test_lineage_coherence_is_constrained(self):
        """A v2 with no parent, and a v1 with one, are both nonsense the CHECK refuses."""
        parent_id, _, _, _ = self._seed_schema("TESTVER_Coherence_Parent")

        self.assertRaisesInStatement(
            lambda: self.cur.execute(
                """
                INSERT INTO public.schemas (schema_name, schema_definition, version)
                VALUES ('TESTVER_Orphan_v2', '{"type":"object"}'::jsonb, 2);
                """
            ),
            message_contains="schemas_version_lineage_coherent",
        )

        self.assertRaisesInStatement(
            lambda: self.cur.execute(
                """
                INSERT INTO public.schemas (schema_name, schema_definition, version, parent_schema_id)
                VALUES ('TESTVER_Parented_v1', '{"type":"object"}'::jsonb, 1, %s);
                """,
                (parent_id,),
            ),
            message_contains="schemas_version_lineage_coherent",
        )

    def test_base_name_derivation_does_not_accumulate_suffixes(self):
        """Mirrors baseSchemaName() in frontend/src/utils/schemaVersion.js."""
        self.cur.execute(
            """
            SELECT public.schema_version_base_name('Foo'),
                   public.schema_version_base_name('Foo_v2'),
                   public.schema_version_base_name('Foo_v12'),
                   public.schema_version_base_name('Foo_v2_v3'),
                   public.schema_version_base_name('Simulated_CNC_01_Schema');
            """
        )
        self.assertEqual(
            self.cur.fetchone(),
            ("Foo", "Foo", "Foo", "Foo_v2", "Simulated_CNC_01_Schema"),
        )


class TestFork(SchemaVersioningTestCase):
    """fork_schema(): v1 -> v2, automatically."""

    def test_fork_of_v1_assigns_v2(self):
        parent_id, _, _, _ = self._seed_schema(
            "TESTVER_Fork_Base", change_description="Initial release"
        )
        self._act_as(ADMIN_USER_ID, "Administrator")

        child = self._fork(parent_id, "Added spindle temperature threshold")

        self.assertEqual(child["version"], 2, "the version must be derived as parent.version + 1")
        self.assertEqual(child["status"], "draft")
        self.assertEqual(child["parent_schema_id"], parent_id)
        self.assertEqual(child["change_description"], "Added spindle temperature threshold")
        self.assertEqual(child["schema_name"], "TESTVER_Fork_Base_v2")

        # Duplicating the parent's metric links. In this database a schema's links to the catalog
        # ARE `schema_definition` -- there is no join table -- so equality of the document is
        # equality of the links.
        self.assertEqual(child["schema_definition"], BASE_DEFINITION)

        # The parent is untouched by forking. Only publishing archives it.
        self._act_as_owner()
        parent = self._fetch(parent_id)
        self.assertEqual((parent["version"], parent["status"]), (1, "active"))

    def test_fork_ignores_a_blank_change_description(self):
        """'' is not a description somebody wrote; it is the absence of one."""
        parent_id, _, _, _ = self._seed_schema("TESTVER_Fork_Blank")
        self._act_as(ADMIN_USER_ID, "Administrator")

        child = self._fork(parent_id, "   ")
        self.assertIsNone(child["change_description"])

    def test_fork_chain_reaches_v3(self):
        """v1 -> v2 -> v3, with each number derived rather than chosen."""
        v1_id, _, _, _ = self._seed_schema("TESTVER_Chain")
        self._act_as(ADMIN_USER_ID, "Administrator")

        v2 = self._fork(v1_id, "second")
        self.assertEqual(v2["version"], 2)
        self._publish(v2["id"])

        v3 = self._fork(v2["id"], "third")
        self.assertEqual(v3["version"], 3)
        self.assertEqual(v3["parent_schema_id"], v2["id"])
        self.assertEqual(v3["schema_name"], "TESTVER_Chain_v3")

    def test_fork_requires_a_schema_managing_role(self):
        parent_id, _, _, _ = self._seed_schema("TESTVER_Fork_Privilege")
        self._act_as(OPERATOR_USER_ID, "Operator")

        exc = self.assertRaisesInStatement(
            lambda: self._fork(parent_id, "operators cannot do this"),
            message_contains="insufficient privileges",
        )
        self.assertIsInstance(exc, errors.InsufficientPrivilege)

    def test_second_concurrent_draft_is_refused(self):
        """
        Two drafts off one parent would both claim to be v2 with nothing to say which one
        publishing should archive against.
        """
        parent_id, _, _, _ = self._seed_schema("TESTVER_One_Draft")
        self._act_as(ADMIN_USER_ID, "Administrator")

        self._fork(parent_id, "first draft")
        self.assertRaisesInStatement(
            lambda: self._fork(parent_id, "second draft"),
            message_contains="draft version",
        )

    def test_forking_a_draft_is_refused(self):
        draft_id, _, _, _ = self._seed_schema("TESTVER_Fork_Draft", status="draft")
        self._act_as(ADMIN_USER_ID, "Administrator")

        self.assertRaisesInStatement(
            lambda: self._fork(draft_id, "branching an unpublished version"),
            message_contains="only an active schema can be versioned",
        )

    def test_forking_an_archived_version_is_refused(self):
        archived_id, _, _, _ = self._seed_schema("TESTVER_Fork_Archived", status="archived")
        self._act_as(ADMIN_USER_ID, "Administrator")

        self.assertRaisesInStatement(
            lambda: self._fork(archived_id, "branching history"),
            message_contains="only an active schema can be versioned",
        )

    def test_fork_names_around_a_discarded_draft(self):
        """A discarded draft leaves its name behind; forking must not deadlock on that."""
        parent_id, _, _, _ = self._seed_schema("TESTVER_Name_Clash")
        # Squat the obvious name with an unrelated schema, as a discarded draft would.
        self._seed_schema("TESTVER_Name_Clash_v2", status="archived")
        self._act_as(ADMIN_USER_ID, "Administrator")

        child = self._fork(parent_id, "must not collide")
        self.assertEqual(child["version"], 2)
        self.assertEqual(child["schema_name"], "TESTVER_Name_Clash_v2_2")


class TestPublish(SchemaVersioningTestCase):
    """publish_schema_version(): activate, archive, rebind -- atomically."""

    def _seed_device_on(self, schema_id, suffix="A"):
        """A gateway and a device bound to `schema_id` through both attachment paths."""
        self.cur.execute(
            "INSERT INTO public.gateways (name) VALUES (%s) RETURNING id::text;",
            (f"TESTVER_GW_{suffix}",),
        )
        gateway_id = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO public.devices (name, gateway_id, schema_id) "
            "VALUES (%s, %s, %s) RETURNING id::text;",
            (f"TESTVER_DEV_{suffix}", gateway_id, schema_id),
        )
        device_id = self.cur.fetchone()[0]
        self.cur.execute(
            """
            INSERT INTO public.device_submodels (device_id, schema_id) VALUES (%s, %s)
            ON CONFLICT (device_id, schema_id) DO NOTHING;
            """,
            (device_id, schema_id),
        )
        return device_id

    def test_publishing_v2_archives_v1_and_activates_v2(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Publish", change_description="Initial release")
        self._act_as(ADMIN_USER_ID, "Administrator")

        v2 = self._fork(v1_id, "Added spindle temperature threshold")
        result = self._publish(v2["id"])

        self._act_as_owner()
        self.assertEqual(self._fetch(v1_id)["status"], "archived")
        published = self._fetch(v2["id"])
        self.assertEqual((published["version"], published["status"]), (2, "active"))
        self.assertEqual(result["archived_schema_id"], v1_id)

    def test_publishing_rebinds_device_submodels_and_the_legacy_pointer(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Rebind")
        device_id = self._seed_device_on(v1_id, "REBIND")
        self._act_as(ADMIN_USER_ID, "Administrator")

        v2 = self._fork(v1_id, "widened")
        result = self._publish(v2["id"])
        self._act_as_owner()

        self.cur.execute(
            "SELECT schema_id::text FROM public.device_submodels WHERE device_id = %s;", (device_id,)
        )
        self.assertEqual(
            [r[0] for r in self.cur.fetchall()], [v2["id"]],
            "the submodel attachment must point at the newly published version",
        )

        # The legacy 1:1 arm archived migration 0034 retains. A device provisioned only through it would
        # otherwise stay pinned to an archived version and report the new version's metrics as
        # Unmodelled.
        self.cur.execute("SELECT schema_id::text FROM public.devices WHERE id = %s;", (device_id,))
        self.assertEqual(self.cur.fetchone()[0], v2["id"])

        self.assertEqual(result["submodels_rebound"], 1)
        self.assertEqual(result["legacy_pointers_rebound"], 1)
        self.assertEqual(result["devices_rebound"], 2)

    def test_publishing_resolves_a_device_attached_to_both_versions(self):
        """
        Attaching a draft to a device to try it out is legitimate, and would otherwise collide on
        `uq_device_submodels` when the old row is repointed -- aborting the publish.
        """
        v1_id, _, _, _ = self._seed_schema("TESTVER_Both")
        device_id = self._seed_device_on(v1_id, "BOTH")
        self._act_as(ADMIN_USER_ID, "Administrator")

        v2 = self._fork(v1_id, "trialled before publishing")
        self.cur.execute(
            "INSERT INTO public.device_submodels (device_id, schema_id) VALUES (%s, %s);",
            (device_id, v2["id"]),
        )

        result = self._publish(v2["id"])
        self._act_as_owner()

        self.cur.execute(
            "SELECT schema_id::text FROM public.device_submodels WHERE device_id = %s;", (device_id,)
        )
        self.assertEqual([r[0] for r in self.cur.fetchall()], [v2["id"]])
        self.assertEqual(result["duplicate_submodels_removed"], 1)

    def test_publishing_preserves_the_historical_record(self):
        """
        v1 survives publication intact: same definition, same change description, same version
        number. Only its status moves. This is the invariant the whole feature exists for.
        """
        original = {
            "type": "object",
            "properties": {"Systems/TEMPERATURE": {"type": "number"}},
            "required": ["Systems/TEMPERATURE"],
        }
        v1_id, _, _, _ = self._seed_schema(
            "TESTVER_History", definition=original, change_description="Initial release"
        )
        self._act_as(ADMIN_USER_ID, "Administrator")

        v2 = self._fork(v1_id, "Added spindle temperature threshold")
        widened = {
            "type": "object",
            "properties": {
                "Systems/TEMPERATURE": {"type": "number"},
                "Systems/SPINDLE_TEMPERATURE": {"type": "number"},
            },
            "required": ["Systems/TEMPERATURE"],
        }
        self.cur.execute(
            "UPDATE public.schemas SET schema_definition = %s::jsonb WHERE id = %s;",
            (json.dumps(widened), v2["id"]),
        )
        self._publish(v2["id"])
        self._act_as_owner()

        history = self._fetch(v1_id)
        self.assertEqual(history["schema_definition"], original, "v1's definition must be untouched")
        self.assertEqual(history["change_description"], "Initial release")
        self.assertEqual(history["version"], 1)
        self.assertEqual(history["status"], "archived")

        current = self._fetch(v2["id"])
        self.assertEqual(current["schema_definition"], widened)
        self.assertEqual(current["change_description"], "Added spindle temperature threshold")

    def test_publishing_writes_the_rebinding_to_the_digital_thread(self):
        """
        Repointing `devices.schema_id` fires `log_digital_thread_event()`, so "what was this
        machine judged against, and when did that change" is answerable from the audit trail
        rather than only from the schema rows.
        """
        v1_id, _, _, _ = self._seed_schema("TESTVER_Audit")
        device_id = self._seed_device_on(v1_id, "AUDIT")

        self.cur.execute(
            "SELECT count(*) FROM public.digital_thread WHERE entity_id = %s AND action = 'UPDATE';",
            (device_id,),
        )
        before = self.cur.fetchone()[0]

        self._act_as(ADMIN_USER_ID, "Administrator")
        v2 = self._fork(v1_id, "audited")
        self._publish(v2["id"])
        self._act_as_owner()

        self.cur.execute(
            """
            SELECT count(*) FROM public.digital_thread
             WHERE entity_id = %s AND entity_type = 'devices' AND action = 'UPDATE'
               AND new_data ->> 'schema_id' = %s;
            """,
            (device_id, str(v2["id"])),
        )
        self.assertEqual(self.cur.fetchone()[0], 1)

        self.cur.execute(
            "SELECT count(*) FROM public.digital_thread WHERE entity_id = %s AND action = 'UPDATE';",
            (device_id,),
        )
        self.assertGreater(self.cur.fetchone()[0], before)

    def test_publishing_a_non_draft_is_refused(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Publish_Active")
        self._act_as(ADMIN_USER_ID, "Administrator")

        self.assertRaisesInStatement(
            lambda: self._publish(v1_id), message_contains="not a draft"
        )

    def test_publishing_requires_a_schema_managing_role(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Publish_Privilege")
        self._act_as(ADMIN_USER_ID, "Administrator")
        v2 = self._fork(v1_id, "drafted by an admin")

        self._act_as(OPERATOR_USER_ID, "Operator")
        exc = self.assertRaisesInStatement(
            lambda: self._publish(v2["id"]), message_contains="insufficient privileges"
        )
        self.assertIsInstance(exc, errors.InsufficientPrivilege)

    def test_publishing_an_unknown_schema_is_refused(self):
        self._act_as(ADMIN_USER_ID, "Administrator")
        self.assertRaisesInStatement(
            lambda: self._publish("00000000-0000-4000-8000-0000000000ff"),
            message_contains="not found",
        )


class TestTheRpcsDoNotGoAroundThePolicy(SchemaVersioningTestCase):
    """
    0087. `0069` withdrew `schema:manage` from Shopfloor_Manager and narrowed the three write
    policies on `public.schemas` to Administrator -- but both RPCs are SECURITY DEFINER, so they
    never consulted those policies, and both went on admitting the pair.

    Measured before the fix, in one transaction as a Manager: the direct `UPDATE public.schemas`
    was refused (0 rows) and `publish_schema_version()` then archived the parent anyway. That is
    not a status flip -- publishing repoints every `device_submodels` row and the legacy
    `devices.schema_id` onto the new version, so it changes what ingestion judges each attached
    device against.

    THE PAIR OF ASSERTIONS IS THE POINT. Refusing the Manager proves the hole is closed; letting
    the Administrator through proves the fix is not merely a broken function.
    """

    def test_a_manager_cannot_publish(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Gate_Publish")
        self._act_as(ADMIN_USER_ID, "Administrator")
        draft = self._fork(v1_id, "drafted by an administrator")

        self._act_as(MANAGER_USER_ID, "Shopfloor_Manager")
        err = self.assertRaisesInStatement(
            lambda: self._publish(draft["id"]),
            message_contains="insufficient privileges",
        )
        self.assertEqual(err.pgcode, "42501")

    def test_a_manager_cannot_fork(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Gate_Fork")
        self._act_as(MANAGER_USER_ID, "Shopfloor_Manager")
        err = self.assertRaisesInStatement(
            lambda: self._fork(v1_id, "no"),
            message_contains="insufficient privileges",
        )
        self.assertEqual(err.pgcode, "42501")

    def test_an_administrator_still_publishes(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Gate_Admin_Publish")
        self._act_as(ADMIN_USER_ID, "Administrator")
        draft = self._fork(v1_id, "still allowed")
        self.assertIsNotNone(self._publish(draft["id"]))

    def test_an_administrator_still_forks(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Gate_Admin_Fork")
        self._act_as(ADMIN_USER_ID, "Administrator")
        self.assertIsNotNone(self._fork(v1_id, "still allowed"))

    def test_the_gate_names_the_permission_rather_than_the_role(self):
        # The two functions came to disagree with the policies they were written to match BECAUSE
        # they named roles. Naming the permission is what stops the next role change doing it
        # again, so the spelling is asserted rather than left to review.
        self._act_as_owner()
        self.cur.execute(
            "SELECT p.proname, pg_get_functiondef(p.oid) FROM pg_proc p "
            "  JOIN pg_namespace n ON n.oid = p.pronamespace "
            " WHERE n.nspname = 'public' "
            "   AND p.proname IN ('fork_schema', 'publish_schema_version');"
        )
        rows = self.cur.fetchall()
        self.assertEqual(len(rows), 2)
        for name, definition in rows:
            with self.subTest(function=name):
                self.assertIn("schema:manage", definition)
                self.assertNotIn("Shopfloor_Manager", definition)


class TestDiscardingADraft(SchemaVersioningTestCase):
    """
    0091. The Schemas page had been telling operators for some time that a draft can be "published
    or discarded", and there was no way to discard one.

    That made the state a trap. One draft may exist per lineage at a time -- forking is refused
    while one is open -- so the only exit from a draft nobody wanted was to PUBLISH it, which
    archives the parent and repoints every attached device.

    THE TEST THAT MATTERS MOST is test_an_active_schema_cannot_be_discarded. `schemas_delete_
    privileged` has admitted an Administrator since the baseline, so a plain DELETE was always
    possible -- and `devices.schema_id` is ON DELETE SET NULL while `device_submodels.schema_id` is
    ON DELETE CASCADE, so deleting an ACTIVE schema silently detaches every device bound to it. The
    function is the narrow door that cannot make that mistake.
    """

    def _discard(self, schema_id):
        self.cur.execute("SELECT public.discard_schema_draft(%s);", (schema_id,))
        return self.cur.fetchone()[0]

    def test_a_draft_is_deleted_and_its_parent_left_alone(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Discard_Basic")
        self._act_as(ADMIN_USER_ID, "Administrator")
        draft = self._fork(v1_id, "to be discarded")

        result = self._discard(draft["id"])
        self.assertEqual(result["version"], 2)

        self.cur.execute("SELECT count(*) FROM public.schemas WHERE id = %s;", (draft["id"],))
        self.assertEqual(self.cur.fetchone()[0], 0)

        # THE WHOLE POINT: the lineage returns to the state it was in before the fork.
        self.cur.execute("SELECT status FROM public.schemas WHERE id = %s;", (v1_id,))
        self.assertEqual(self.cur.fetchone()[0], "active")

    def test_an_active_schema_cannot_be_discarded(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Discard_Active")
        self._act_as(ADMIN_USER_ID, "Administrator")
        err = self.assertRaisesInStatement(
            lambda: self._discard(v1_id),
            message_contains="not a draft",
        )
        self.assertEqual(err.pgcode, "23514")

    def test_an_archived_schema_cannot_be_discarded_either(self):
        # It is part of the record of what devices were judged against, and there is no lineage
        # state in which removing it is the right answer.
        v1_id, _, _, _ = self._seed_schema("TESTVER_Discard_Archived")
        self._act_as(ADMIN_USER_ID, "Administrator")
        draft = self._fork(v1_id, "publishing this archives v1")
        self._publish(draft["id"])

        err = self.assertRaisesInStatement(
            lambda: self._discard(v1_id),
            message_contains="not a draft",
        )
        self.assertEqual(err.pgcode, "23514")

    def test_a_manager_cannot_discard(self):
        # The same gate 0087 put on fork and publish, and for the same reason: a SECURITY DEFINER
        # function bypasses RLS entirely, so its own check is the only one there is.
        v1_id, _, _, _ = self._seed_schema("TESTVER_Discard_Gate")
        self._act_as(ADMIN_USER_ID, "Administrator")
        draft = self._fork(v1_id, "not yours to discard")

        self._act_as(MANAGER_USER_ID, "Shopfloor_Manager")
        err = self.assertRaisesInStatement(
            lambda: self._discard(draft["id"]),
            message_contains="insufficient privileges",
        )
        self.assertEqual(err.pgcode, "42501")

    def test_an_operator_cannot_discard(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Discard_Operator")
        self._act_as(ADMIN_USER_ID, "Administrator")
        draft = self._fork(v1_id, "not yours either")

        self._act_as(OPERATOR_USER_ID, "Operator")
        err = self.assertRaisesInStatement(
            lambda: self._discard(draft["id"]),
            message_contains="insufficient privileges",
        )
        self.assertEqual(err.pgcode, "42501")

    def test_a_missing_schema_is_refused_for_the_reason_it_is_wrong(self):
        # P0002, not the SQL-standard 02000: `RAISE ... USING ERRCODE = 'no_data_found'` resolves
        # the PL/pgSQL condition name, which carries its own SQLSTATE. The same code comes back
        # from every other "row is not there" raise in this codebase, so a client that special-
        # cases one of them handles all of them.
        self._act_as(ADMIN_USER_ID, "Administrator")
        err = self.assertRaisesInStatement(
            lambda: self._discard("00000000-0000-4000-8000-0000000000ff"),
            message_contains="not found",
        )
        self.assertEqual(err.pgcode, "P0002")

    def test_discarding_frees_the_lineage_for_a_new_fork(self):
        # The state the missing action created: forking is refused while a draft is open, so a
        # draft nobody wanted blocked the lineage until somebody published it.
        v1_id, _, _, _ = self._seed_schema("TESTVER_Discard_Refork")
        self._act_as(ADMIN_USER_ID, "Administrator")
        first = self._fork(v1_id, "the wrong direction")
        self._discard(first["id"])

        second = self._fork(v1_id, "the right one")
        self.assertEqual(second["version"], 2)
        self.assertNotEqual(second["id"], first["id"])


class TestBootReconciliation(SchemaVersioningTestCase):
    """
    `active_schema_version()` and the reconciliation built on it.

    This exists because migrations 0021 and 0033 re-pin the demo device's schema on every db-init
    replay -- one by name, one by a pinned UUID -- and both of those identify the row that was v1.
    Publishing a v2 therefore used to be quietly undone on the next boot. Those two migrations were
    narrowed so they no longer fight, and this function is the general safety net behind them.
    """

    def _forwards_to(self, schema_id):
        self.cur.execute("SELECT public.active_schema_version(%s)::text;", (schema_id,))
        return self.cur.fetchone()[0]

    def test_an_active_version_forwards_to_itself(self):
        schema_id, _, _, _ = self._seed_schema("TESTVER_Forward_Active")
        self.assertEqual(self._forwards_to(schema_id), schema_id)

    def test_an_archived_version_forwards_to_its_successor(self):
        v1_id, _, _, _ = self._seed_schema("TESTVER_Forward_Chain")
        self._act_as(ADMIN_USER_ID, "Administrator")
        v2 = self._fork(v1_id, "second")
        self._publish(v2["id"])
        self._act_as_owner()

        self.assertEqual(self._forwards_to(v1_id), v2["id"])

    def test_forwarding_walks_the_whole_chain(self):
        """v1 -> v3 in one hop from the caller's point of view, however long the lineage is."""
        v1_id, _, _, _ = self._seed_schema("TESTVER_Forward_Deep")
        self._act_as(ADMIN_USER_ID, "Administrator")
        v2 = self._fork(v1_id, "second")
        self._publish(v2["id"])
        v3 = self._fork(v2["id"], "third")
        self._publish(v3["id"])
        self._act_as_owner()

        self.assertEqual(self._forwards_to(v1_id), v3["id"])
        self.assertEqual(self._forwards_to(v2["id"]), v3["id"])

    def test_forwarding_never_lands_on_an_unpublished_draft(self):
        """
        A draft is not in force. Forwarding a live binding onto one would activate it by the back
        door -- devices would start being judged against a version nobody had published.
        """
        v1_id, _, _, _ = self._seed_schema("TESTVER_Forward_Draft")
        self._act_as(ADMIN_USER_ID, "Administrator")
        v2 = self._fork(v1_id, "second")
        self._publish(v2["id"])
        v3 = self._fork(v2["id"], "unpublished third")
        self._act_as_owner()

        # v3 exists but is a draft, so v2 remains the answer.
        self.assertEqual(self._forwards_to(v1_id), v2["id"])
        # A device deliberately attached to the draft is left where it is, not dragged back.
        self.assertEqual(self._forwards_to(v3["id"]), v3["id"])

    def test_an_archived_version_with_no_successor_stays_put(self):
        """A stale pointer beats a NULL one, which would read as 'this device has no model'."""
        orphan_id, _, _, _ = self._seed_schema("TESTVER_Forward_Orphan", status="archived")
        self.assertEqual(self._forwards_to(orphan_id), orphan_id)

    def test_the_demo_device_is_never_left_on_an_archived_version(self):
        """
        The invariant the reconciliation exists to hold, stated over the whole fleet rather than
        over the demo device alone.
        """
        self.cur.execute(
            """
            SELECT d.name, s.schema_name
              FROM public.devices d
              JOIN public.schemas s ON s.id = d.schema_id
             WHERE s.status = 'archived'
               AND public.active_schema_version(d.schema_id) IS DISTINCT FROM d.schema_id;
            """
        )
        stranded = self.cur.fetchall()
        self.assertEqual(
            stranded, [],
            f"devices left pointing at a superseded schema version: {stranded}",
        )

        self.cur.execute(
            """
            SELECT ds.device_id, s.schema_name
              FROM public.device_submodels ds
              JOIN public.schemas s ON s.id = ds.schema_id
             WHERE s.status = 'archived'
               AND public.active_schema_version(ds.schema_id) IS DISTINCT FROM ds.schema_id;
            """
        )
        stranded_links = self.cur.fetchall()
        self.assertEqual(
            stranded_links, [],
            f"submodel attachments left on a superseded schema version: {stranded_links}",
        )


class TestBackfill(SchemaVersioningTestCase):
    """What archived migration 0037 left behind for schemas that predate it."""

    def test_seeded_schemas_backfilled_to_v1_with_a_change_description(self):
        """
        Deliberately does NOT assert `status = 'active'`. Versioning a seeded schema is an ordinary
        operator action, and on any stack where someone has published a v2 the seed row is
        correctly `archived` -- an assertion of `active` would fail for a database in a perfectly
        valid state, which is a test reporting its own assumption rather than a defect. What the
        backfill actually promises is v1 and a change description; the status is only constrained
        to the extent that an archived seed must have a successor to have been archived BY.

        SKIPPED ON A FRESH INSTALL, WHICH IS NOT THE SAME AS PASSING. 0073 retired the last of
        these rows -- `Simulated_CNC_01_Schema` -- so a stack built from these migrations today has
        no seeded schema for the backfill to have acted on, and this asserts nothing. It still
        earns its place on a database that predates 0073, where those rows are exactly what an
        upgrade must not have left half-versioned; that stack is the one this test is for. It is
        skipped rather than deleted for that reason, and skipped rather than passed so the
        difference is legible in the run.
        """
        self.cur.execute(
            """
            SELECT s.schema_name, s.version, s.status, s.change_description,
                   EXISTS (SELECT 1 FROM public.schemas c WHERE c.parent_schema_id = s.id)
              FROM public.schemas s
             WHERE s.schema_name IN ('SparkplugB-Telemetry-Standard-Schema',
                                     'ISO-22400-OEE-Schema',
                                     'Simulated_CNC_01_Schema');
            """
        )
        rows = self.cur.fetchall()
        if not rows:
            self.skipTest(
                "no seeded schemas present -- 0073 retired them, so a stack built from these "
                "migrations has nothing for the 0037 backfill to have acted on. This test asserts "
                "on a database that predates 0073."
            )
        for name, version, status, change_description, has_successor in rows:
            self.assertEqual(version, 1, f"{name} should have backfilled to v1")
            self.assertEqual(
                change_description, "Initial release",
                f"{name} should have backfilled its change description",
            )
            self.assertIn(status, ("active", "archived"), f"{name} has an unexpected status")
            if status == "archived":
                self.assertTrue(
                    has_successor,
                    f"{name} is archived but nothing superseded it -- it was archived by something "
                    "other than a publish",
                )



class TestArchivedSchemasAreNotAssignable(SchemaVersioningTestCase):
    """
    0093. An archived version stops taking NEW devices -- issue #167.

    THE THING BEING ASSERTED IS THE MOVE, NOT THE STATE. A device already sitting on an archived
    schema is an unfinished migration and has to stay editable, so most of these tests are about
    what the guard must NOT refuse. Getting that half wrong is the more expensive failure: it would
    freeze every rename, relocation and policy change on any device a publish left behind.

    RUN AS THE OWNER, DELIBERATELY, which is the opposite of TestImmutability's arrangement above.
    The versioning freeze exempts non-app roles because migrations rewrite seeded schemas on every
    boot; this guard exempts nobody, because the paths that assign a schema include SECURITY
    DEFINER functions and an approvals queue that applies a patch on somebody else's behalf. A
    suite that only proved it under `authenticated` would not have tested the routes that matter.
    """

    def _seed_gateway(self, suffix):
        self.cur.execute(
            "INSERT INTO public.gateways (name) VALUES (%s) RETURNING id::text;",
            ("TESTVER_ARCH_GW_" + suffix,),
        )
        return self.cur.fetchone()[0]

    def _seed_device(self, suffix, schema_id=None, shadow_of=None):
        self.cur.execute(
            "INSERT INTO public.devices (name, gateway_id, schema_id, shadow_of) "
            "VALUES (%s, %s, %s, %s) RETURNING id::text;",
            ("TESTVER_ARCH_DEV_" + suffix, self._seed_gateway(suffix), schema_id, shadow_of),
        )
        return self.cur.fetchone()[0]

    # ------------------------------------------------------------------ what it refuses

    def test_creating_a_device_on_an_archived_schema_raises(self):
        archived_id, _, _, _ = self._seed_schema("TESTVER_Arch_Insert", status="archived")
        exc = self.assertRaisesInStatement(
            lambda: self._seed_device("INSERT", schema_id=archived_id),
            message_contains="is archived and cannot be assigned",
        )
        self.assertEqual(exc.pgcode, "23514")  # check_violation, the code 0093 raises with

    def test_moving_a_device_onto_an_archived_schema_raises(self):
        """The literal report on #167: a device is edited and an archived version is picked."""
        active_id, _, _, _ = self._seed_schema("TESTVER_Arch_Move_Active")
        archived_id, _, _, _ = self._seed_schema("TESTVER_Arch_Move_Old", status="archived")
        device_id = self._seed_device("MOVE", schema_id=active_id)

        exc = self.assertRaisesInStatement(
            lambda: self.cur.execute(
                "UPDATE public.devices SET schema_id = %s WHERE id = %s;",
                (archived_id, device_id),
            ),
            message_contains="is archived and cannot be assigned",
        )
        self.assertEqual(exc.pgcode, "23514")  # check_violation, the code 0093 raises with

    def test_attaching_an_archived_submodel_raises(self):
        """The other arm of `device_schemas`. A guard on one column is not a guard."""
        archived_id, _, _, _ = self._seed_schema("TESTVER_Arch_Submodel", status="archived")
        device_id = self._seed_device("SUBMODEL")

        exc = self.assertRaisesInStatement(
            lambda: self.cur.execute(
                "INSERT INTO public.device_submodels (device_id, schema_id) VALUES (%s, %s);",
                (device_id, archived_id),
            ),
            message_contains="is archived and cannot be assigned",
        )
        self.assertEqual(exc.pgcode, "23514")  # check_violation, the code 0093 raises with

    def test_the_refusal_names_the_successor(self):
        """
        The operator reaching this picked the wrong row out of a version history, so the message
        has to say which row was right. Asserted because a hint nobody maintains rots into a lie.
        """
        v1_id, _, _, _ = self._seed_schema("TESTVER_Arch_Hint", change_description="Initial release")
        self._act_as(ADMIN_USER_ID, "Administrator")
        v2 = self._fork(v1_id, "widened")
        self._publish(v2["id"])
        self._act_as_owner()

        exc = self.assertRaisesInStatement(
            lambda: self._seed_device("HINT", schema_id=v1_id),
            message_contains="archived",
        )
        self.assertIn(
            v2["schema_name"], str(exc),
            "the refusal should name the version that replaced the archived one",
        )

    # ------------------------------------------------------------------ what it must allow

    def test_a_device_already_on_an_archived_schema_stays_editable(self):
        """
        The unfinished-migration case, and the one a naive guard breaks. The device is put on the
        schema while it is still active and the schema is archived underneath it -- exactly what a
        publish does to any device the rebinding could not reach.
        """
        schema_id, _, _, _ = self._seed_schema("TESTVER_Arch_Stays")
        device_id = self._seed_device("STAYS", schema_id=schema_id)
        self.cur.execute("UPDATE public.schemas SET status = 'archived' WHERE id = %s;", (schema_id,))

        self.cur.execute(
            "UPDATE public.devices SET name = %s WHERE id = %s;",
            ("TESTVER_ARCH_RENAMED", device_id),
        )
        self.cur.execute("SELECT name, schema_id::text FROM public.devices WHERE id = %s;", (device_id,))
        name, still_bound = self.cur.fetchone()
        self.assertEqual(name, "TESTVER_ARCH_RENAMED")
        self.assertEqual(still_bound, schema_id, "the existing binding must survive an unrelated edit")

    def test_detaching_from_an_archived_schema_is_allowed(self):
        """Finishing the migration by hand must not be the one move that is refused."""
        schema_id, _, _, _ = self._seed_schema("TESTVER_Arch_Detach")
        device_id = self._seed_device("DETACH", schema_id=schema_id)
        self.cur.execute("UPDATE public.schemas SET status = 'archived' WHERE id = %s;", (schema_id,))

        self.cur.execute("UPDATE public.devices SET schema_id = NULL WHERE id = %s;", (device_id,))
        self.cur.execute("SELECT schema_id FROM public.devices WHERE id = %s;", (device_id,))
        self.assertIsNone(self.cur.fetchone()[0])

    def test_a_draft_is_still_assignable(self):
        """
        Trying a version against a real machine before publishing it is how a draft gets tested,
        and publish_schema_version() already merges that state rather than treating it as a fault.
        """
        v1_id, _, _, _ = self._seed_schema("TESTVER_Arch_Draft")
        self._act_as(ADMIN_USER_ID, "Administrator")
        v2 = self._fork(v1_id, "not published yet")
        self._act_as_owner()

        device_id = self._seed_device("DRAFT", schema_id=v2["id"])
        self.cur.execute("SELECT schema_id::text FROM public.devices WHERE id = %s;", (device_id,))
        self.assertEqual(self.cur.fetchone()[0], v2["id"])

    def test_a_shadow_device_may_copy_an_archived_contract(self):
        """
        ensure_shadow_devices() copies the origin device's schema so a replay is judged against the
        same contract it was recorded under. If the origin is mid-migration, the shadow has to be
        able to say so -- refusing it would break playback for the exact fleet this guard protects.
        """
        schema_id, _, _, _ = self._seed_schema("TESTVER_Arch_Shadow")
        origin_id = self._seed_device("SHADOW_ORIGIN", schema_id=schema_id)
        self.cur.execute("UPDATE public.schemas SET status = 'archived' WHERE id = %s;", (schema_id,))

        shadow_id = self._seed_device("SHADOW", schema_id=schema_id, shadow_of=origin_id)
        self.cur.execute(
            "INSERT INTO public.device_submodels (device_id, schema_id) VALUES (%s, %s);",
            (shadow_id, schema_id),
        )
        self.cur.execute("SELECT schema_id::text FROM public.devices WHERE id = %s;", (shadow_id,))
        self.assertEqual(self.cur.fetchone()[0], schema_id)

    def test_publishing_still_works_with_the_guard_in_force(self):
        """
        The regression the guard could most easily cause. publish_schema_version() repoints every
        device onto the draft and only then archives the parent -- so the ordering inside that
        function is what keeps it past this trigger, and a reordering would be caught here.
        """
        v1_id, _, _, _ = self._seed_schema("TESTVER_Arch_Publish")
        device_id = self._seed_device("PUBLISH", schema_id=v1_id)
        self.cur.execute(
            "INSERT INTO public.device_submodels (device_id, schema_id) VALUES (%s, %s);",
            (device_id, v1_id),
        )

        self._act_as(ADMIN_USER_ID, "Administrator")
        v2 = self._fork(v1_id, "widened")
        result = self._publish(v2["id"])
        self._act_as_owner()

        self.assertEqual(result["devices_rebound"], 2)
        self.cur.execute("SELECT schema_id::text FROM public.devices WHERE id = %s;", (device_id,))
        self.assertEqual(self.cur.fetchone()[0], v2["id"])
        self.assertEqual(self._fetch(v1_id)["status"], "archived")


if __name__ == "__main__":
    unittest.main(verbosity=2)

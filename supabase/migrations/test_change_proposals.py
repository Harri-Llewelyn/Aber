"""
The approvals queue (0086): who may propose, what may be proposed, and what approving does.

Run against the migrated Supabase Postgres -- `npm run test:db` gives it a throwaway one.

THE TEST THAT MATTERS MOST is TestTheAssetWritePoliciesDidNotMove. This migration gives `Operator`
the first write that role has ever held, and the entire security argument is that the write is to a
QUEUE and not to an asset. If a later change ever adds a second write path to `devices` -- however
convenient -- the item has failed, and nothing else in this suite would notice. So the refusal is
asserted directly rather than inferred from the policy text.

Two more properties are worth naming because they are the ones a reasonable person would
"simplify" away:

  * APPROVING IS APPLYING, so an invalid change cannot be approved. TestApprovalRunsTheConstraints
    proposes `location_scope = 'site_wide'` while leaving `cell_id` populated and asserts the
    approval ABORTS on `devices_site_wide_has_no_cell`. A queue that accepted it would produce an
    audit record of something that did not happen.

  * BOTH CAPS ARE IN THE DATABASE. The per-asset one is a partial unique index and the per-person
    one is a trigger, and the RLS policy admits a direct PostgREST INSERT -- so a cap enforced only
    in an RPC, or only by a disabled button, would be a cap with a documented way around it.
"""
import json
import os
import unittest
import uuid

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Pinned, for the reason aas_fixture and validate.py pin theirs: a run that dies before teardown
# must not leave rows a later run collides with. Distinct from both of those id blocks.
OPERATOR = "7a000000-0000-4000-8000-000000000001"
OPERATOR_TWO = "7a000000-0000-4000-8000-000000000002"
MANAGER = "7a000000-0000-4000-8000-000000000003"
AUDITOR = "7a000000-0000-4000-8000-000000000004"
DEVICE = "7b000000-0000-4000-8000-000000000001"
# THE SECOND DEVICE DIFFERS IN ITS SECOND BYTE, AND IT HAS TO. `devices.sparkplug_id` is
# GENERATED ALWAYS AS `'dev' || substr(hex(id), 1, 21)` under a UNIQUE index, so only the first 21
# hex characters of a uuid reach the wire. Two ids differing only in their last block -- the
# obvious way to write a second fixture -- are distinct primary keys that generate an IDENTICAL
# sparkplug_id, and `ON CONFLICT (id)` does not help because the collision is on the other index.
DEVICE_TWO = "7bf00000-0000-4000-8000-000000000001"
CELL = "7c000000-0000-4000-8000-000000000001"
# 0090's two new asset lanes. The gateway's id differs EARLY for the same reason DEVICE_TWO's does:
# `gateways.sparkplug_id` is generated from the first 21 hex characters under a unique index.
GATEWAY = "7e000000-0000-4000-8000-000000000001"
CELL_TWO = "7cf00000-0000-4000-8000-000000000001"
# The schema lane (0088). An active parent and a draft forked from it, so a publication has
# something to archive and something to rebind -- the half that makes publishing more than a
# status flip.
SCHEMA_PARENT = "7d000000-0000-4000-8000-000000000001"
SCHEMA_DRAFT = "7df00000-0000-4000-8000-000000000001"
# An Administrator, who alone may decide the schema lane since 0069 withdrew schema:manage
# from Shopfloor_Manager and 0087 made the RPC enforce it.
ADMIN = "7a000000-0000-4000-8000-000000000005"
# Nothing has this id. A proposal against it must be refused for the reason it is actually
# wrong -- a missing target -- rather than by whatever fails first downstream.
ABSENT_UUID = "7fffffff-0000-4000-8000-00000000dead"


def connect():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
                            user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def as_user(cur, user_id):
    """
    Become `authenticated` carrying this person's claims.

    THE EMAIL CLAIM IS PART OF THE SESSION, not decoration: `auth.email()` reads it, and 0089's
    trigger stamps `proposed_by_email` from it. Seeded here so the fixture resembles a real GoTrue
    token rather than the narrowest one that satisfies auth.uid().
    """
    cur.execute("SET ROLE authenticated;")
    cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                (json.dumps({"sub": user_id, "email": f"{user_id}@change-proposals.test"}),))


def as_owner(cur):
    cur.execute("RESET ROLE;")
    cur.execute("SELECT set_config('request.jwt.claims', '', true);")


class ProposalCase(unittest.TestCase):
    """One connection per test, rolled back at the end unless a test commits deliberately."""

    @classmethod
    def setUpClass(cls):
        conn = connect()
        cur = conn.cursor()
        try:
            cur.execute("SELECT to_regclass('public.change_proposals');")
            if not cur.fetchone()[0]:
                raise RuntimeError("public.change_proposals does not exist -- 0086 has not been applied")

            # AND THEY HAVE TO BE REAL PEOPLE IN auth.users, for two separate reasons.
            #
            # `digital_thread.changed_by` carries a foreign key to auth.users, so the moment an
            # approval writes an audit row naming the approver, an actor that exists only in
            # `user_roles` fails the insert -- and the error names the audit table rather than
            # anything the test did.
            #
            # THE EMAIL IS NOT DECORATION. An auth.users row with an id and nothing else is the
            # definition of a MACHINE PRINCIPAL ("no email, no password, no identity provider"),
            # and the INSERT policy resolves through has_authority(), which routes a machine
            # through principal_permissions -- where these hold nothing. Seeded bare, every
            # proposing test would fail with a permission error that looked like a policy bug.
            for actor, role in ((OPERATOR, 3), (OPERATOR_TWO, 3), (MANAGER, 2),
                                (AUDITOR, 4), (ADMIN, 1)):
                cur.execute(
                    "INSERT INTO auth.users (id, email) VALUES (%s, %s) "
                    "ON CONFLICT (id) DO NOTHING;",
                    (actor, f"{actor}@change-proposals.test"),
                )
                cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s) "
                    "ON CONFLICT (user_id, role_id) DO NOTHING;",
                    (actor, role),
                )
            for cell_id, cell_name in ((CELL, "Proposal Test Cell"),
                                       (CELL_TWO, "Proposal Test Cell Two")):
                cur.execute(
                    "INSERT INTO public.cells (id, name) VALUES (%s, %s) "
                    "ON CONFLICT (id) DO NOTHING;",
                    (cell_id, cell_name),
                )
            # `deployment` is NOT NULL with no default, and the four CHECKs on this table are what
            # make the gateway lane worth testing at all -- see TestTheGatewayLane.
            cur.execute(
                "INSERT INTO public.gateways (id, name, cell_id, deployment) "
                "VALUES (%s, 'Proposal_Test_Gateway', %s, 'host') "
                "ON CONFLICT (id) DO NOTHING;",
                (GATEWAY, CELL),
            )
            for device_id, name in ((DEVICE, "Proposal_Test_Device"),
                                    (DEVICE_TWO, "Proposal_Test_Device_Two")):
                cur.execute(
                    "INSERT INTO public.devices (id, name, cell_id) VALUES (%s, %s, %s) "
                    "ON CONFLICT (id) DO NOTHING;",
                    (device_id, name, CELL),
                )

            # The schema lane's subject. Seeded directly as the owner rather than through
            # fork_schema(), which would need an Administrator session inside a fixture -- the
            # provenance trigger exempts the owner precisely so fixtures can do this.
            cur.execute(
                "INSERT INTO public.schemas (id, schema_name, schema_definition, status, version) "
                "VALUES (%s, 'Proposal_Test_Schema', '{}'::jsonb, 'active', 1) "
                "ON CONFLICT (id) DO NOTHING;", (SCHEMA_PARENT,))
            cur.execute(
                "INSERT INTO public.schemas "
                "  (id, schema_name, schema_definition, status, version, parent_schema_id) "
                "VALUES (%s, 'Proposal_Test_Schema_v2', '{}'::jsonb, 'draft', 2, %s) "
                "ON CONFLICT (id) DO NOTHING;", (SCHEMA_DRAFT, SCHEMA_PARENT))
            conn.commit()
        finally:
            conn.close()

    @classmethod
    def tearDownClass(cls):
        conn = connect()
        cur = conn.cursor()
        try:
            cur.execute("DELETE FROM public.change_proposals WHERE entity_id IN (%s,%s);",
                        (DEVICE, DEVICE_TWO))
            cur.execute("DELETE FROM public.device_nameplate WHERE device_id IN (%s,%s);",
                        (DEVICE, DEVICE_TWO))
            cur.execute("DELETE FROM public.devices WHERE id IN (%s,%s);", (DEVICE, DEVICE_TWO))
            cur.execute("DELETE FROM public.change_proposals WHERE entity_id IN (%s,%s);",
                        (SCHEMA_PARENT, SCHEMA_DRAFT))
            cur.execute("DELETE FROM public.schemas WHERE id IN (%s,%s);",
                        (SCHEMA_DRAFT, SCHEMA_PARENT))
            cur.execute("DELETE FROM public.change_proposals WHERE entity_id IN (%s,%s,%s);",
                        (CELL, CELL_TWO, GATEWAY))
            cur.execute("DELETE FROM public.links WHERE entity_id IN (%s,%s,%s,%s);",
                        (DEVICE, DEVICE_TWO, CELL, GATEWAY))
            cur.execute("DELETE FROM public.gateways WHERE id = %s;", (GATEWAY,))
            cur.execute("DELETE FROM public.cells WHERE id IN (%s,%s);", (CELL, CELL_TWO))
            cur.execute("DELETE FROM public.user_roles WHERE user_id IN (%s,%s,%s,%s,%s);",
                        (OPERATOR, OPERATOR_TWO, MANAGER, AUDITOR, ADMIN))
            conn.commit()

            # THE auth.users ROWS ARE LEFT BEHIND WHEN AN AUDIT ROW NAMES ONE, and that is the
            # design rather than a leak: `digital_thread` is append-only and its changed_by holds a
            # foreign key, so a person an audit row names cannot be deleted. Attempted, then
            # tolerated -- the ids are pinned, so a later run reuses them rather than accumulating.
            try:
                cur.execute("DELETE FROM auth.users WHERE id IN (%s,%s,%s,%s,%s);",
                            (OPERATOR, OPERATOR_TWO, MANAGER, AUDITOR, ADMIN))
                conn.commit()
            except psycopg2.Error:
                conn.rollback()
        finally:
            conn.close()

    def setUp(self):
        self.conn = connect()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------
    def propose(self, patch, user=OPERATOR, entity_type="devices", entity_id=DEVICE,
                rationale="because the label on the machine says so"):
        as_user(self.cur, user)
        self.cur.execute(
            "INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale) "
            "VALUES (%s, %s, %s::jsonb, %s) RETURNING id;",
            (entity_type, entity_id, json.dumps(patch), rationale),
        )
        return self.cur.fetchone()[0]


class TestTheAssetWritePoliciesDidNotMove(ProposalCase):
    """
    The claim the whole item rests on. `Operator` gained a write; it is a write to the queue.
    """

    def test_an_operator_still_cannot_update_a_device_directly(self):
        as_user(self.cur, OPERATOR)
        self.cur.execute("UPDATE public.devices SET name = 'renamed by an operator' WHERE id = %s;",
                         (DEVICE,))
        # RLS does not raise on a refused UPDATE -- it matches no rows, which is the same outcome
        # and the reason this asserts the count rather than expecting an exception.
        self.assertEqual(self.cur.rowcount, 0)

    def test_an_operator_still_cannot_insert_a_device(self):
        as_user(self.cur, OPERATOR)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "INSERT INTO public.devices (name) VALUES ('made by an operator');")

    def test_an_operator_still_cannot_write_a_nameplate(self):
        as_user(self.cur, OPERATOR)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "INSERT INTO public.device_nameplate (device_id, serial_number) VALUES (%s, 'x');",
                (DEVICE,))


class TestWhoMayPropose(ProposalCase):
    def test_an_operator_may_file_a_proposal(self):
        proposal = self.propose({"name": "Cell 4 Lathe"})
        self.assertIsNotNone(proposal)

    def test_an_auditor_holds_no_proposal_create_and_is_refused(self):
        as_user(self.cur, AUDITOR)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "INSERT INTO public.change_proposals (entity_type, entity_id, patch) "
                "VALUES ('devices', %s, '{\"name\":\"nope\"}'::jsonb);", (DEVICE,))

    def test_a_proposal_cannot_be_filed_in_somebody_elses_name(self):
        # Otherwise one person could consume another's allowance under the per-person cap, and the
        # refusal the second person then meets would name a proposal they never made.
        as_user(self.cur, OPERATOR)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "INSERT INTO public.change_proposals (entity_type, entity_id, patch, proposed_by) "
                "VALUES ('devices', %s, '{\"name\":\"nope\"}'::jsonb, %s);", (DEVICE, OPERATOR_TWO))

    def test_the_insert_policy_resolves_authority_not_a_role_name(self):
        # 0080's argument, and it is structural rather than stylistic: the three machine principals
        # held `Operator` and nothing else until that migration, so a policy naming the role would
        # have admitted them -- each with its own allowance under the per-person cap.
        as_owner(self.cur)
        self.cur.execute(
            "SELECT with_check FROM pg_policies "
            " WHERE schemaname='public' AND tablename='change_proposals' "
            "   AND policyname='change_proposals_insert_proposer';")
        with_check = self.cur.fetchone()[0]
        self.assertIn("has_authority", with_check)
        self.assertNotIn("has_role", with_check)

    def test_a_proposer_reads_their_own_and_not_another_persons(self):
        proposal = self.propose({"name": "mine"})
        self.conn.commit()
        try:
            as_user(self.cur, OPERATOR_TWO)
            self.cur.execute("SELECT count(*) FROM public.change_proposals WHERE id = %s;",
                             (proposal,))
            self.assertEqual(self.cur.fetchone()[0], 0)

            as_user(self.cur, MANAGER)
            self.cur.execute("SELECT count(*) FROM public.change_proposals WHERE id = %s;",
                             (proposal,))
            self.assertEqual(self.cur.fetchone()[0], 1, "an approver reads the whole queue")
        finally:
            as_owner(self.cur)
            self.cur.execute("DELETE FROM public.change_proposals WHERE id = %s;", (proposal,))
            self.conn.commit()


class TestWhatMayBeProposed(ProposalCase):
    """The allowlist, which is the security half of the design."""

    def test_a_column_ingestion_writes_is_refused(self):
        for column, value in (("status", "ONLINE"),
                              ("reported_identity", "dev000000000000000000000"),
                              ("identity_source", "declared"),
                              ("is_quarantined", False)):
            with self.subTest(column=column):
                self.conn.rollback()
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.propose({column: value})

    def test_the_data_path_is_not_an_asset_detail(self):
        # gateway_id is the device's connection, not a detail about it. 0036 separated location
        # from the data path precisely so a location change need not rewire one.
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.propose({"gateway_id": str(uuid.uuid4())})

    def test_schema_binding_is_not_proposable(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.propose({"schema_id": str(uuid.uuid4())})

    def test_the_refusal_names_the_column_and_the_alternatives(self):
        # A proposer chose this field in a form. "Invalid patch" would send them to an
        # administrator to find out which one.
        try:
            self.propose({"status": "ONLINE"})
            self.fail("expected the patch to be refused")
        except psycopg2.errors.InvalidParameterValue as err:
            self.assertIn("status", str(err))
            self.assertIn("connection_method", str(err))

    def test_an_allowlisted_column_is_accepted(self):
        self.assertIsNotNone(self.propose({"description": "the one by the door"}))

    def test_a_proposal_against_an_unknown_entity_type_is_refused(self):
        # The CHECK constraint admits the known lanes, but the validation trigger runs BEFORE it,
        # so this is the trigger's refusal rather than the constraint's -- and it must name the
        # real problem. "Proposable columns are:" with nothing after the colon would read as a
        # broken message rather than as a lane nobody has written an allowlist for.
        #
        # THE STAND-IN USED TO BE `gateways`, AND 0090 MADE THAT A REAL LANE. The test kept
        # passing on a foreign-key error from a device id being looked up in `public.gateways` --
        # a refusal, but not this one. A lane nothing will ever add is the only safe fixture.
        try:
            self.propose({"name": "x"}, entity_type="not_a_table_anybody_will_add")
            self.fail("expected the proposal to be refused")
        except psycopg2.errors.InvalidParameterValue as err:
            self.assertIn("not_a_table_anybody_will_add", str(err))
            self.assertIn("no allowlist", str(err))

    def test_a_proposal_against_an_archived_device_is_refused(self):
        as_owner(self.cur)
        self.cur.execute("UPDATE public.devices SET is_archived = true WHERE id = %s;", (DEVICE_TWO,))
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
            self.propose({"name": "x"}, entity_id=DEVICE_TWO)

    def test_an_empty_patch_is_refused(self):
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.propose({})


class TestTheCaps(ProposalCase):
    def test_one_open_proposal_per_asset_per_person(self):
        self.propose({"name": "first"})
        with self.assertRaises(psycopg2.errors.UniqueViolation):
            self.propose({"description": "second"})

    def test_the_cap_is_scoped_to_the_proposer(self):
        # A cap on the asset alone would let one person's forgotten proposal block everybody else
        # from proposing against that machine -- denial of service by accident.
        self.propose({"name": "mine"}, user=OPERATOR)
        self.assertIsNotNone(self.propose({"name": "theirs"}, user=OPERATOR_TWO))

    def test_a_decided_proposal_stops_blocking_the_next_one(self):
        proposal = self.propose({"name": "first"})
        as_owner(self.cur)
        self.cur.execute("SELECT set_config('acs_cymru.proposal_transition','on',true);")
        self.cur.execute(
            "UPDATE public.change_proposals SET status='rejected', decided_by=%s, "
            "decided_at=now(), decision_reason='not this week' WHERE id=%s;", (MANAGER, proposal))
        self.assertIsNotNone(self.propose({"name": "second"}))

    def test_the_per_person_ceiling_is_enforced_by_the_database(self):
        as_owner(self.cur)
        self.cur.execute(
            "UPDATE public.system_settings SET value = to_jsonb(1) "
            " WHERE key = 'proposals.max_open_per_person';")
        self.propose({"name": "one"}, entity_id=DEVICE)
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.propose({"name": "two"}, entity_id=DEVICE_TWO)

    def test_the_expiry_setting_has_a_floor(self):
        # Zero is a WORKING configuration that silently disables the feature: every proposal
        # auto-closes at the moment it is created and nothing anywhere reports an error.
        as_owner(self.cur)
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute(
                "UPDATE public.system_settings SET value = to_jsonb(0) "
                " WHERE key = 'proposals.open_expiry_days';")


class TestWhatMayMoveAfterwards(ProposalCase):
    def test_a_proposer_may_edit_their_own_open_proposal(self):
        # The caps make this necessary rather than convenient: told "you already have an open
        # proposal on this device", a person has to be able to open it and add to it.
        proposal = self.propose({"name": "first thought"})
        as_user(self.cur, OPERATOR)
        self.cur.execute(
            "UPDATE public.change_proposals SET patch = %s::jsonb, rationale = %s WHERE id = %s;",
            (json.dumps({"name": "second thought", "description": "and this too"}),
             "revised after walking the floor", proposal))
        self.assertEqual(self.cur.rowcount, 1)

    def test_an_edited_patch_is_re_validated(self):
        proposal = self.propose({"name": "fine"})
        as_user(self.cur, OPERATOR)
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.cur.execute(
                "UPDATE public.change_proposals SET patch = '{\"status\":\"ONLINE\"}'::jsonb "
                " WHERE id = %s;", (proposal,))

    def test_a_proposer_cannot_approve_their_own_proposal_by_writing_the_status(self):
        # The one that would hand an Operator the asset write this design exists to withhold.
        proposal = self.propose({"name": "sneaky"})
        as_user(self.cur, OPERATOR)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "UPDATE public.change_proposals SET status = 'applied' WHERE id = %s;", (proposal,))

    def test_another_operator_cannot_edit_it(self):
        proposal = self.propose({"name": "mine"})
        self.conn.commit()
        try:
            as_user(self.cur, OPERATOR_TWO)
            self.cur.execute(
                "UPDATE public.change_proposals SET rationale = 'hijacked' WHERE id = %s;",
                (proposal,))
            self.assertEqual(self.cur.rowcount, 0)
        finally:
            as_owner(self.cur)
            self.cur.execute("DELETE FROM public.change_proposals WHERE id = %s;", (proposal,))
            self.conn.commit()


class TestDeciding(ProposalCase):
    def test_an_operator_cannot_approve(self):
        proposal = self.propose({"name": "please"})
        as_user(self.cur, OPERATOR)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))

    def test_approving_applies_the_change(self):
        proposal = self.propose({"name": "Cell 4 Lathe", "description": "by the door"})
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT name, description FROM public.devices WHERE id = %s;", (DEVICE,))
        self.assertEqual(self.cur.fetchone(), ("Cell 4 Lathe", "by the door"))

    def test_a_column_the_patch_omits_is_left_alone(self):
        # What makes this a PATCH rather than a row snapshot: two proposals touching different
        # fields of one asset both apply, and neither reverts what moved underneath it.
        proposal = self.propose({"description": "only this"})
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT name FROM public.devices WHERE id = %s;", (DEVICE,))
        self.assertEqual(self.cur.fetchone()[0], "Proposal_Test_Device")

    def test_the_audit_row_names_both_the_proposer_and_the_approver(self):
        proposal = self.propose({"name": "Named By Both"})
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute(
            "SELECT new_data, changed_by, actor_source, audit_domain FROM public.digital_thread "
            " WHERE action = 'PROPOSAL_APPLIED' AND new_data->>'proposal_id' = %s;", (str(proposal),))
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "approving wrote no PROPOSAL_APPLIED row")
        new_data, changed_by, actor_source, domain = row
        self.assertEqual(new_data["proposed_by"], OPERATOR)
        self.assertEqual(new_data["approved_by"], MANAGER)
        self.assertEqual(str(changed_by), MANAGER)
        self.assertEqual(actor_source, "user")
        # Not 'security': a manager has to be able to read their own act.
        self.assertEqual(domain, "asset")

    def test_the_proposal_points_at_the_audit_row_it_wrote(self):
        proposal = self.propose({"name": "Linked"})
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute(
            "SELECT p.status, t.action FROM public.change_proposals p "
            "  JOIN public.digital_thread t ON t.id = p.applied_thread_id WHERE p.id = %s;",
            (proposal,))
        self.assertEqual(self.cur.fetchone(), ("applied", "PROPOSAL_APPLIED"))

    def test_a_decided_proposal_cannot_be_decided_again(self):
        proposal = self.propose({"name": "once"})
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))

    def test_rejecting_needs_a_reason(self):
        proposal = self.propose({"name": "no"})
        as_user(self.cur, MANAGER)
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.cur.execute("SELECT public.reject_proposal(%s, '   ');", (proposal,))

    def test_rejecting_keeps_the_reason_and_frees_the_slot(self):
        proposal = self.propose({"name": "no"})
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.reject_proposal(%s, 'that machine is being retired');",
                         (proposal,))
        as_owner(self.cur)
        self.cur.execute(
            "SELECT status, decision_reason FROM public.change_proposals WHERE id = %s;",
            (proposal,))
        self.assertEqual(self.cur.fetchone(), ("rejected", "that machine is being retired"))
        # No cooldown: the corrected proposal may be filed at once.
        self.assertIsNotNone(self.propose({"name": "revised"}))

    def test_only_the_proposer_withdraws(self):
        proposal = self.propose({"name": "mine"})
        as_user(self.cur, MANAGER)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.withdraw_proposal(%s);", (proposal,))

    def test_withdrawing_closes_the_row_rather_than_deleting_it(self):
        proposal = self.propose({"name": "never mind"})
        as_user(self.cur, OPERATOR)
        self.cur.execute("SELECT public.withdraw_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT status FROM public.change_proposals WHERE id = %s;", (proposal,))
        self.assertEqual(self.cur.fetchone()[0], "withdrawn")


class TestApprovalRunsTheConstraints(ProposalCase):
    """
    Because the approval IS the write, an invalid change cannot be approved. A queue that accepted
    one would hold an audit record of something that did not happen.
    """

    def test_a_patch_violating_a_check_aborts_the_approval(self):
        # site_wide asserts the device has NO single cell, and this device has one. The rule lives
        # in devices_site_wide_has_no_cell and is not restated anywhere in 0086.
        proposal = self.propose({"location_scope": "site_wide"})
        as_user(self.cur, MANAGER)
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))

    def test_the_proposal_stays_open_when_the_apply_fails(self):
        proposal = self.propose({"location_scope": "site_wide"})
        as_user(self.cur, MANAGER)
        try:
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        except psycopg2.errors.CheckViolation:
            pass
        # The whole function is one transaction, so the failed apply took the status change with
        # it. Asserted after a rollback to the savepoint the driver keeps.
        self.conn.rollback()
        as_owner(self.cur)
        self.cur.execute("SELECT status FROM public.change_proposals WHERE id = %s;", (proposal,))
        row = self.cur.fetchone()
        self.assertTrue(row is None or row[0] == "open")

    def test_a_foreign_key_is_enforced_at_approval_too(self):
        proposal = self.propose({"cell_id": str(uuid.uuid4())})
        as_user(self.cur, MANAGER)
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))


class TestTheNameplateLane(ProposalCase):
    def test_it_creates_the_row_when_the_device_has_none(self):
        proposal = self.propose({"serial_number": "SN-0001", "manufacturer_name": "Haas"},
                                entity_type="device_nameplate")
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute(
            "SELECT serial_number, manufacturer_name FROM public.device_nameplate "
            " WHERE device_id = %s;", (DEVICE,))
        self.assertEqual(self.cur.fetchone(), ("SN-0001", "Haas"))

    def test_updated_by_names_the_proposer_not_the_approver(self):
        # The column's own comment settles it: a nameplate is an assertion ABOUT an asset, so who
        # made it is part of the record -- that is the proposer. Who AUTHORISED it is the
        # digital_thread row.
        proposal = self.propose({"serial_number": "SN-0002"}, entity_type="device_nameplate")
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT updated_by FROM public.device_nameplate WHERE device_id = %s;",
                         (DEVICE,))
        self.assertEqual(str(self.cur.fetchone()[0]), OPERATOR)

    def test_a_constraint_on_the_nameplate_is_enforced_at_approval(self):
        proposal = self.propose({"year_of_construction": "the nineties"},
                                entity_type="device_nameplate")
        as_user(self.cur, MANAGER)
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))


class TestWhoAsked(ProposalCase):
    """
    0089. `proposed_by` is a uuid and nothing in the stack resolves one into a person, so the queue
    could not answer the first question anybody asks about a request.

    THE REPAIR IS NOT A FORM FIELD, and that is the part worth guarding. A typed name is the shape
    this repository refuses elsewhere -- a self-declared marker is not evidence -- so the email
    comes out of the signed token and the client's own value is discarded.
    """

    def test_the_email_is_taken_from_the_token(self):
        proposal = self.propose({"name": "named"})
        as_owner(self.cur)
        self.cur.execute("SELECT proposed_by_email FROM public.change_proposals WHERE id = %s;",
                         (proposal,))
        self.assertEqual(self.cur.fetchone()[0], f"{OPERATOR}@change-proposals.test")

    def test_a_client_cannot_name_somebody_else(self):
        # THE TEST THIS MIGRATION EXISTS FOR. A DEFAULT would have let this value survive, and the
        # column would quietly have become the self-declared field 0089 declined to build.
        as_user(self.cur, OPERATOR)
        self.cur.execute(
            "INSERT INTO public.change_proposals "
            "  (entity_type, entity_id, patch, proposed_by_email) "
            "VALUES ('devices', %s, '{\"name\":\"x\"}'::jsonb, 'ceo@example.com') "
            "RETURNING proposed_by_email;", (DEVICE,))
        self.assertEqual(self.cur.fetchone()[0], f"{OPERATOR}@change-proposals.test")

    def test_the_column_carries_no_default(self):
        # The mechanism, asserted directly: a DEFAULT applies only when the column is OMITTED, so
        # it would leave a supplied value in place and the check above would start passing by luck.
        as_owner(self.cur)
        self.cur.execute(
            "SELECT column_default FROM information_schema.columns "
            " WHERE table_schema='public' AND table_name='change_proposals' "
            "   AND column_name='proposed_by_email';")
        self.assertIsNone(self.cur.fetchone()[0])

    def test_the_author_cannot_be_rewritten_afterwards(self):
        # An UPDATE could otherwise re-attribute a proposal an approver is already reading.
        proposal = self.propose({"name": "named"})
        as_user(self.cur, OPERATOR)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "UPDATE public.change_proposals SET proposed_by_email = %s WHERE id = %s;",
                ("someone.else@example.com", proposal))

    def test_the_audit_row_carries_it_beside_the_uuid(self):
        proposal = self.propose({"name": "Named In The Thread"})
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute(
            "SELECT new_data->>'proposed_by_email', new_data->>'proposed_by' "
            "  FROM public.digital_thread "
            " WHERE action = 'PROPOSAL_APPLIED' AND new_data->>'proposal_id' = %s;", (str(proposal),))
        email, uuid_value = self.cur.fetchone()
        # Both: the uuid is what everything resolves through, the email is what a person reads.
        self.assertEqual(email, f"{OPERATOR}@change-proposals.test")
        self.assertEqual(uuid_value, OPERATOR)


class TestTheSchemaLaneIsWithdrawn(ProposalCase):
    """
    0090 withdrew the lane 0088 built, and the reason is worth keeping in front of whoever reads
    this next: a draft can only be created by `fork_schema()`, which needs `schema:manage` -- held
    by Administrator alone since 0069, and enforced at the RPC since 0087. So the only person who
    could create the draft was the only person who could publish it, and an Operator "proposing" a
    publication was endorsing somebody else's work rather than asking for a change they could not
    make. That is a different feature; this queue is for the second thing.

    THE HISTORY IS NOT RETRACTED WITH THE LANE. The CHECK constraint still admits the string, so
    every schema proposal ever applied or rejected survives -- a constraint that refused it would
    have refused rows already in the table and failed the migration on any stack that used it.
    """

    def test_a_publication_can_no_longer_be_proposed(self):
        as_user(self.cur, OPERATOR)
        with self.assertRaises(psycopg2.errors.InvalidParameterValue) as caught:
            self.cur.execute(
                "INSERT INTO public.change_proposals (entity_type, entity_id, patch) "
                "VALUES ('schemas', %s, '{\"publish\": true}'::jsonb);", (SCHEMA_DRAFT,))
        # NAMED, not merely refused: the fail-closed branch says the lane has no allowlist, which
        # is the true sentence rather than "invalid patch".
        self.assertIn("nothing is proposable on schemas", str(caught.exception))

    def test_the_allowlist_is_empty_which_is_how_the_lane_is_closed(self):
        as_owner(self.cur)
        self.cur.execute("SELECT public.proposable_columns('schemas');")
        self.assertEqual(self.cur.fetchone()[0], [])

    def test_nobody_can_decide_one(self):
        # Including an Administrator. A lane closed for filing but open for deciding would leave
        # whoever holds schema:manage as the only person who could still act in it.
        for actor in (ADMIN, MANAGER, OPERATOR):
            as_user(self.cur, actor)
            self.cur.execute("SELECT public.may_decide_proposal('schemas');")
            self.assertFalse(self.cur.fetchone()[0], f"{actor} can still decide the schema lane")

    def test_no_open_schema_proposal_survives_the_migration(self):
        # The migration withdraws them with a reason. One left open would sit in a queue nobody
        # can decide, which is the worst of the three states -- worse than either keeping the lane
        # or deleting the rows.
        as_owner(self.cur)
        self.cur.execute(
            "SELECT count(*) FROM public.change_proposals "
            " WHERE entity_type = 'schemas' AND status = 'open';")
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_the_constraint_still_admits_the_string_so_history_survives(self):
        """
        THE CONSTRAINT IS READ, NOT EXERCISED, and that is forced rather than lazy: the validation
        trigger is a BEFORE trigger, so it refuses a new schema-lane row before the CHECK is ever
        consulted -- including one written by the owner. There is no INSERT that can reach the
        constraint any more, which is exactly the state 0090 intends.

        What still matters is that the constraint would ADMIT the string, because it applies to
        every row already in the table: a migration that dropped 'schemas' from it would fail to
        apply on any stack that had used the lane, taking the whole boot with it.
        """
        as_owner(self.cur)
        self.cur.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            " WHERE conname = 'change_proposals_entity_type_known';")
        definition = self.cur.fetchone()[0]
        self.assertIn("'schemas'", definition)
        # And the live lanes are in it too, or nothing could be filed at all.
        for lane in ('devices', 'device_nameplate', 'cells', 'gateways'):
            self.assertIn(f"'{lane}'", definition)
        # 0108 took the three link lanes OUT of it, which is a stronger withdrawal than the one
        # 'schemas' got: that string is still admitted here and closed by an empty allowlist.
        for lane in ('cell_links', 'gateway_links', 'device_links'):
            self.assertNotIn(f"'{lane}'", definition)

    def test_0087_is_not_reverted(self):
        # The RPC narrowing stands entirely on its own: it closed a live hole through which a
        # Shopfloor_Manager could publish a schema despite 0069 withdrawing the permission.
        as_user(self.cur, MANAGER)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.publish_schema_version(%s);", (SCHEMA_DRAFT,))


class TestTheCellLane(ProposalCase):
    """0090. The first subject an Operator looks at all day and cannot edit."""

    def test_an_operator_may_propose_a_cell_change(self):
        proposal = self.propose({"name": "Finishing Cell"}, entity_type="cells", entity_id=CELL)
        self.assertIsNotNone(proposal)

    def test_approving_renames_the_cell(self):
        proposal = self.propose({"name": "Finishing Cell"}, entity_type="cells", entity_id=CELL)
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT name FROM public.cells WHERE id = %s;", (CELL,))
        self.assertEqual(self.cur.fetchone()[0], "Finishing Cell")

    def test_an_icon_nobody_drew_aborts_the_approval(self):
        # APPROVING IS APPLYING, so `cells_icon_valid` runs inside the approver's transaction. A
        # queue that accepted this would record an approval of something that did not happen.
        proposal = self.propose({"icon": "Banana"}, entity_type="cells", entity_id=CELL)
        as_user(self.cur, MANAGER)
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))

    def test_a_column_outside_the_allowlist_is_refused(self):
        # `is_archived` is a lifecycle act with a retention promise attached, not a field.
        as_user(self.cur, OPERATOR)
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.cur.execute(
                "INSERT INTO public.change_proposals (entity_type, entity_id, patch) "
                "VALUES ('cells', %s, '{\"is_archived\": true}'::jsonb);", (CELL,))

    def test_the_lane_resolves_the_permission_not_a_role_name(self):
        # 0087's lesson. An Operator holds no `cell:manage`, so the lane refuses them -- and it
        # would refuse a Manager too, the day the grant were withdrawn.
        as_user(self.cur, OPERATOR)
        self.cur.execute("SELECT public.may_decide_proposal('cells');")
        self.assertFalse(self.cur.fetchone()[0])
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.may_decide_proposal('cells');")
        self.assertTrue(self.cur.fetchone()[0])

    def test_an_operator_still_cannot_write_a_cell_directly(self):
        as_user(self.cur, OPERATOR)
        self.cur.execute("UPDATE public.cells SET name = 'renamed' WHERE id = %s;", (CELL,))
        self.assertEqual(self.cur.rowcount, 0)


class TestTheGatewayLane(ProposalCase):
    """
    0090. The lane whose target carries the most constraints, which is why it is the best test of
    "approving is applying".
    """

    def test_approving_renames_the_gateway(self):
        proposal = self.propose({"name": "Line_B_Gateway"}, entity_type="gateways",
                                entity_id=GATEWAY)
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT name FROM public.gateways WHERE id = %s;", (GATEWAY,))
        self.assertEqual(self.cur.fetchone()[0], "Line_B_Gateway")

    def test_a_relocation_moves_it_between_cells(self):
        proposal = self.propose({"cell_id": CELL_TWO}, entity_type="gateways", entity_id=GATEWAY)
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT cell_id FROM public.gateways WHERE id = %s;", (GATEWAY,))
        self.assertEqual(str(self.cur.fetchone()[0]), CELL_TWO)

    def test_site_wide_while_still_in_a_cell_aborts_the_approval(self):
        # `gateways_site_wide_has_no_cell`. The pair is proposable together precisely so this can
        # be asked as ONE proposal; asking for half of it is refused by the table, at approval.
        proposal = self.propose({"location_scope": "site_wide"}, entity_type="gateways",
                                entity_id=GATEWAY)
        as_user(self.cur, MANAGER)
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))

    def test_both_halves_of_a_relocation_in_one_proposal_are_accepted(self):
        proposal = self.propose({"location_scope": "site_wide", "cell_id": None},
                                entity_type="gateways", entity_id=GATEWAY)
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT location_scope, cell_id FROM public.gateways WHERE id = %s;",
                         (GATEWAY,))
        scope, cell = self.cur.fetchone()
        self.assertEqual(scope, "site_wide")
        self.assertIsNone(cell)

    def test_what_the_platform_observed_is_not_proposable(self):
        # The security half of the design, restated for a new table: a proposal able to edit
        # `status` would let somebody assert a gateway is online by describing it.
        for column in ("status", "last_heartbeat", "deployment", "sparkplug_group"):
            as_user(self.cur, OPERATOR)
            with self.assertRaises(psycopg2.errors.InvalidParameterValue, msg=column):
                self.cur.execute(
                    "INSERT INTO public.change_proposals (entity_type, entity_id, patch) "
                    "VALUES ('gateways', %s, %s::jsonb);",
                    (GATEWAY, json.dumps({column: "host"})))
            self.conn.rollback()


class TestTheWithdrawnDocumentLanes(ProposalCase):
    """
    0108. `cell_links`, `gateway_links` and `device_links` were 0090's one lane shape where the
    patch was a row to CREATE rather than columns to change. No page ever filed one -- the modal
    that attaches a link has always written to `links` directly, through `link:manage` -- so the
    lanes were reachable only by hand-crafting the insert these tests do.

    They are shut two ways: the allowlist is empty, and the CHECK constraint no longer admits the
    string at all. The permission is NOT withdrawn with them; it still gates the direct edit.
    """

    def a_document(self, **overrides):
        patch = {"display_name": "RAMS", "url": "https://docs.example/rams.pdf",
                 "link_tag": "health_and_safety"}
        patch.update(overrides)
        return patch

    def test_no_link_lane_can_be_filed_in(self):
        for lane, entity in (("device_links", DEVICE), ("cell_links", CELL),
                             ("gateway_links", GATEWAY)):
            as_user(self.cur, OPERATOR)
            # Either error is the lane being shut: the trigger runs before the constraint, so which
            # one speaks first is an ordering detail, not the behaviour under test.
            with self.assertRaises((psycopg2.errors.InvalidParameterValue,
                                    psycopg2.errors.CheckViolation)):
                self.cur.execute(
                    "INSERT INTO public.change_proposals (entity_type, entity_id, patch) "
                    "VALUES (%s, %s, %s::jsonb);",
                    (lane, entity, json.dumps(self.a_document())))
            self.cur.execute("ROLLBACK;")

    def test_nothing_is_proposable_on_a_link_lane(self):
        as_owner(self.cur)
        for lane in ("cell_links", "gateway_links", "device_links"):
            self.cur.execute("SELECT public.proposable_columns(%s);", (lane,))
            self.assertEqual(self.cur.fetchone()[0], [], f"{lane} still has an allowlist")

    def test_nobody_may_decide_one(self):
        as_user(self.cur, MANAGER)
        for lane in ("cell_links", "gateway_links", "device_links"):
            self.cur.execute("SELECT public.may_decide_proposal(%s);", (lane,))
            self.assertFalse(self.cur.fetchone()[0], f"{lane} is still decidable")

    def test_the_tag_function_the_lanes_validated_against_is_gone(self):
        as_owner(self.cur)
        self.cur.execute(
            "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            " WHERE n.nspname = 'public' AND p.proname = 'proposable_link_tags';")
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_the_audit_domain_still_reads_asset_for_the_old_lanes(self):
        # Kept deliberately. A deployment that approved a link proposal before 0108 holds
        # digital_thread rows carrying these entity_types; dropping the arms would move that
        # history into the fail-closed security domain and narrow who may read it.
        as_owner(self.cur)
        for lane in ("cell_links", "gateway_links", "device_links"):
            self.cur.execute("SELECT public.audit_domain_for(%s, 'PROPOSAL_APPLIED');", (lane,))
            self.assertEqual(self.cur.fetchone()[0], "asset")

    def test_an_operator_still_cannot_write_a_link_directly(self):
        # Unchanged by 0108, and the reason the lanes existed: an Operator holds no `link:manage`.
        # With the lanes gone this is simply the whole story for that role.
        as_user(self.cur, OPERATOR)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "INSERT INTO public.links (entity_type, entity_id, display_name, url) "
                "VALUES ('device', %s, 'RAMS', 'https://docs.example/rams.pdf');", (DEVICE,))

    def test_a_manager_still_attaches_one_directly(self):
        # The route that was always the real one, asserted here so the withdrawal above cannot be
        # mistaken for links themselves being withdrawn.
        as_user(self.cur, MANAGER)
        self.cur.execute(
            "INSERT INTO public.links (entity_type, entity_id, display_name, url, link_tag) "
            "VALUES ('device', %s, 'RAMS', 'https://docs.example/rams.pdf', 'health_and_safety');",
            (DEVICE,))
        as_owner(self.cur)
        self.cur.execute("SELECT display_name FROM public.links WHERE entity_id = %s;", (DEVICE,))
        self.assertEqual(self.cur.fetchone()[0], "RAMS")


class TestAProposalThatCameTrueOnItsOwn(ProposalCase):
    """
    0090. Nothing stops a Manager editing an asset while a proposal sits open against it, and
    nothing should -- the queue is a way to ASK, not a lock. But it means a proposal can be
    OVERTAKEN, and approving one then writes a PROPOSAL_APPLIED row naming an approver and a patch
    for a change that did not happen in that transaction.

    The repair is to reject it with that as the reason, which records what actually happened.
    """

    def test_a_patch_already_in_place_cannot_be_approved(self):
        proposal = self.propose({"name": "Renamed_By_Hand"})
        # The Manager makes the change directly, which they are entitled to do.
        as_user(self.cur, MANAGER)
        self.cur.execute("UPDATE public.devices SET name = 'Renamed_By_Hand' WHERE id = %s;",
                         (DEVICE,))
        with self.assertRaises(psycopg2.errors.CheckViolation) as caught:
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        self.assertIn("already in place", str(caught.exception))

    def test_it_can_still_be_rejected_which_is_the_repair(self):
        proposal = self.propose({"name": "Renamed_By_Hand"})
        as_user(self.cur, MANAGER)
        self.cur.execute("UPDATE public.devices SET name = 'Renamed_By_Hand' WHERE id = %s;",
                         (DEVICE,))
        self.cur.execute("SELECT public.reject_proposal(%s, %s);",
                         (proposal, "already done by hand"))
        as_owner(self.cur)
        self.cur.execute("SELECT status, decision_reason FROM public.change_proposals WHERE id = %s;",
                         (proposal,))
        self.assertEqual(self.cur.fetchone(), ("rejected", "already done by hand"))

    def test_a_partly_overtaken_proposal_is_still_approvable(self):
        # CONTAINMENT, NOT EQUALITY. One of the two fields was done by hand; the other was not, so
        # there is still a change to make and refusing it would strand a live request.
        proposal = self.propose({"name": "Renamed_By_Hand", "description": "and a new description"})
        as_user(self.cur, MANAGER)
        self.cur.execute("UPDATE public.devices SET name = 'Renamed_By_Hand' WHERE id = %s;",
                         (DEVICE,))
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT description FROM public.devices WHERE id = %s;", (DEVICE,))
        self.assertEqual(self.cur.fetchone()[0], "and a new description")

    def test_the_queue_can_ask_before_anybody_clicks(self):
        # Exposed to the browser so the page can WARN rather than only refusing afterwards.
        proposal = self.propose({"name": "Renamed_By_Hand"})
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.proposal_is_already_true(%s);", (proposal,))
        self.assertFalse(self.cur.fetchone()[0])
        self.cur.execute("UPDATE public.devices SET name = 'Renamed_By_Hand' WHERE id = %s;",
                         (DEVICE,))
        self.cur.execute("SELECT public.proposal_is_already_true(%s);", (proposal,))
        self.assertTrue(self.cur.fetchone()[0])

    def test_a_nameplate_with_no_row_yet_is_never_a_no_op(self):
        # The approval CREATES that row, so a missing one means everything is still to do. A naive
        # "no current row means nothing to change" would refuse every first nameplate.
        proposal = self.propose({"serial_number": "SN-1"}, entity_type="device_nameplate")
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.proposal_is_already_true(%s);", (proposal,))
        self.assertFalse(self.cur.fetchone()[0])


class TestTheTimer(ProposalCase):
    def test_an_old_open_proposal_expires(self):
        proposal = self.propose({"name": "forgotten"})
        as_owner(self.cur)
        self.cur.execute("SELECT set_config('acs_cymru.proposal_transition','on',true);")
        self.cur.execute(
            "UPDATE public.change_proposals SET proposed_at = now() - interval '30 days' "
            " WHERE id = %s;", (proposal,))
        self.cur.execute("SELECT public.expire_open_proposals();")
        self.assertGreaterEqual(self.cur.fetchone()[0], 1)
        self.cur.execute(
            "SELECT status, decided_by, decided_at IS NOT NULL FROM public.change_proposals "
            " WHERE id = %s;", (proposal,))
        status, decided_by, decided = self.cur.fetchone()
        self.assertEqual(status, "expired")
        # NULL, and deliberately: naming an approver for a decision nobody made would be a false
        # attribution in the one record this feature exists to produce.
        self.assertIsNone(decided_by)
        self.assertTrue(decided)

    def test_a_young_proposal_is_left_alone(self):
        proposal = self.propose({"name": "recent"})
        as_owner(self.cur)
        self.cur.execute("SELECT public.expire_open_proposals();")
        self.cur.execute("SELECT status FROM public.change_proposals WHERE id = %s;", (proposal,))
        self.assertEqual(self.cur.fetchone()[0], "open")

    def test_the_expiry_declares_service_and_names_no_user(self):
        proposal = self.propose({"name": "forgotten"})
        as_owner(self.cur)
        self.cur.execute("SELECT set_config('acs_cymru.proposal_transition','on',true);")
        self.cur.execute(
            "UPDATE public.change_proposals SET proposed_at = now() - interval '30 days' "
            " WHERE id = %s;", (proposal,))
        self.cur.execute("SELECT public.expire_open_proposals();")
        self.cur.execute(
            "SELECT actor_source, changed_by, audit_domain FROM public.digital_thread "
            " WHERE action = 'PROPOSAL_EXPIRED' AND entity_id = %s;", (proposal,))
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "the expiry wrote no audit row")
        actor_source, changed_by, domain = row
        self.assertEqual(actor_source, "service")
        self.assertIsNone(changed_by)
        self.assertEqual(domain, "asset")

    def test_the_timer_is_not_callable_by_a_person(self):
        as_user(self.cur, MANAGER)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.expire_open_proposals();")


class TestTheQueueStopsGrowing(ProposalCase):
    def test_an_old_decided_proposal_is_pruned(self):
        proposal = self.propose({"name": "long ago"})
        as_owner(self.cur)
        self.cur.execute("SELECT set_config('acs_cymru.proposal_transition','on',true);")
        self.cur.execute(
            "UPDATE public.change_proposals SET status='withdrawn', decided_by=%s, "
            " decided_at = now() - interval '400 days' WHERE id = %s;", (OPERATOR, proposal))
        self.cur.execute("SELECT public.prune_closed_proposals();")
        self.cur.execute("SELECT count(*) FROM public.change_proposals WHERE id = %s;", (proposal,))
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_an_open_proposal_is_never_pruned_however_old(self):
        # Expiry closes it; pruning removes what expiry closed. Collapsing the two would delete a
        # proposal nobody had answered, which is not the same event at all.
        proposal = self.propose({"name": "still waiting"})
        as_owner(self.cur)
        self.cur.execute("SELECT set_config('acs_cymru.proposal_transition','on',true);")
        self.cur.execute(
            "UPDATE public.change_proposals SET proposed_at = now() - interval '400 days' "
            " WHERE id = %s;", (proposal,))
        self.cur.execute("SELECT public.prune_closed_proposals();")
        self.cur.execute("SELECT count(*) FROM public.change_proposals WHERE id = %s;", (proposal,))
        self.assertEqual(self.cur.fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)

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
    """Become `authenticated` carrying this person's claims, which is what auth.uid() reads."""
    cur.execute("SET ROLE authenticated;")
    cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                (json.dumps({"sub": user_id}),))


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
            cur.execute(
                "INSERT INTO public.cells (id, name) VALUES (%s, 'Proposal Test Cell') "
                "ON CONFLICT (id) DO NOTHING;",
                (CELL,),
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
            cur.execute("DELETE FROM public.cells WHERE id = %s;", (CELL,))
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
        # The CHECK constraint admits two entity types, but the validation trigger runs BEFORE it,
        # so this is the trigger's refusal rather than the constraint's -- and it must name the
        # real problem. "Proposable columns are:" with nothing after the colon would read as a
        # broken message rather than as a lane nobody has written an allowlist for.
        try:
            self.propose({"name": "x"}, entity_type="gateways")
            self.fail("expected the proposal to be refused")
        except psycopg2.errors.InvalidParameterValue as err:
            self.assertIn("gateways", str(err))
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


class TestTheSchemaLane(ProposalCase):
    """
    0088. The second lane, and the second approval gate.

    ONE INBOX, TWO GATES is the property worth protecting: a Shopfloor_Manager may approve a
    nameplate edit and may NOT approve a schema publication, because 0069 withdrew `schema:manage`
    from that role and 0087 made the RPC this lane calls enforce it. A change that collapsed the
    two gates into one would restore exactly the bypass 0087 closed, one layer up.
    """

    def test_an_operator_may_propose_a_publication(self):
        self.assertIsNotNone(
            self.propose({"publish": True}, entity_type="schemas", entity_id=SCHEMA_DRAFT))

    def test_the_patch_is_the_act_and_nothing_else(self):
        # A publication takes no arguments, so there is exactly one well-formed patch.
        for patch in ({"publish": False}, {"publish": True, "name": "x"}, {"status": "active"}):
            with self.subTest(patch=patch):
                self.conn.rollback()
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.propose(patch, entity_type="schemas", entity_id=SCHEMA_DRAFT)

    def test_only_a_draft_can_be_proposed_for_publication(self):
        # Learned at proposal time rather than after a week in a queue.
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.propose({"publish": True}, entity_type="schemas", entity_id=SCHEMA_PARENT)

    def test_a_missing_schema_is_refused(self):
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
            self.propose({"publish": True}, entity_type="schemas", entity_id=ABSENT_UUID)

    def test_a_manager_cannot_approve_a_publication(self):
        # THE ASYMMETRY. The same person approves nameplate edits all day.
        proposal = self.propose({"publish": True}, entity_type="schemas", entity_id=SCHEMA_DRAFT)
        as_user(self.cur, MANAGER)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))

    def test_a_manager_cannot_reject_one_either(self):
        # Rejecting looks like the lesser act. A Manager able to refuse an Administrator-only
        # decision could block it indefinitely, and the operator would read that as the answer.
        proposal = self.propose({"publish": True}, entity_type="schemas", entity_id=SCHEMA_DRAFT)
        as_user(self.cur, MANAGER)
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.reject_proposal(%s, 'no');", (proposal,))

    def test_a_manager_still_decides_the_asset_lanes(self):
        # The other half of the asymmetry: narrowing the schema lane must not narrow the rest.
        proposal = self.propose({"name": "Renamed By Approval"})
        as_user(self.cur, MANAGER)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT name FROM public.devices WHERE id = %s;", (DEVICE,))
        self.assertEqual(self.cur.fetchone()[0], "Renamed By Approval")

    def test_an_administrator_approving_publishes_the_draft(self):
        proposal = self.propose({"publish": True}, entity_type="schemas", entity_id=SCHEMA_DRAFT)
        as_user(self.cur, ADMIN)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT id::text, status FROM public.schemas WHERE id IN (%s,%s);",
                         (SCHEMA_PARENT, SCHEMA_DRAFT))
        by_id = dict(self.cur.fetchall())
        # The whole point: not a status flip on one row. The predecessor is archived in the same
        # transaction, which is what publish_schema_version() exists to keep atomic.
        self.assertEqual(by_id[SCHEMA_DRAFT], "active")
        self.assertEqual(by_id[SCHEMA_PARENT], "archived")

    def test_the_approval_goes_through_the_function_not_a_column_write(self):
        # A device bound to the parent must be repointed by the approval. A patch that merely set
        # `status` would leave it judged against an archived version, reporting the new version's
        # metrics as Unmodelled -- which is the failure this lane must not reintroduce.
        as_owner(self.cur)
        self.cur.execute("UPDATE public.devices SET schema_id = %s WHERE id = %s;",
                         (SCHEMA_PARENT, DEVICE))
        proposal = self.propose({"publish": True}, entity_type="schemas", entity_id=SCHEMA_DRAFT)
        as_user(self.cur, ADMIN)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute("SELECT schema_id::text FROM public.devices WHERE id = %s;", (DEVICE,))
        self.assertEqual(self.cur.fetchone()[0], SCHEMA_DRAFT)

    def test_the_audit_row_lands_in_the_security_domain(self):
        # 0070's rule is WHO MAY PERFORM the act, and publishing is Administrator-only -- so this
        # row is deliberately one the proposing Operator cannot read. Their own proposal row is
        # what tells them it was applied.
        proposal = self.propose({"publish": True}, entity_type="schemas", entity_id=SCHEMA_DRAFT)
        as_user(self.cur, ADMIN)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_owner(self.cur)
        self.cur.execute(
            "SELECT audit_domain, new_data->>'proposed_by' FROM public.digital_thread "
            " WHERE action = 'PROPOSAL_APPLIED' AND new_data->>'proposal_id' = %s;", (str(proposal),))
        domain, proposed_by = self.cur.fetchone()
        self.assertEqual(domain, "security")
        self.assertEqual(proposed_by, OPERATOR)

    def test_the_proposal_still_tells_the_proposer_what_happened(self):
        proposal = self.propose({"publish": True}, entity_type="schemas", entity_id=SCHEMA_DRAFT)
        as_user(self.cur, ADMIN)
        self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))
        as_user(self.cur, OPERATOR)
        self.cur.execute(
            "SELECT status, decided_by::text, applied_thread_id IS NOT NULL "
            "  FROM public.change_proposals WHERE id = %s;", (proposal,))
        status, decided_by, has_thread = self.cur.fetchone()
        self.assertEqual(status, "applied")
        self.assertEqual(decided_by, ADMIN)
        self.assertTrue(has_thread)

    def test_a_draft_published_underneath_the_proposal_aborts_the_approval(self):
        # The reason the draft check runs again at apply: the state can move between proposing and
        # deciding, and the approval is what has to be right.
        proposal = self.propose({"publish": True}, entity_type="schemas", entity_id=SCHEMA_DRAFT)
        as_owner(self.cur)
        self.cur.execute("UPDATE public.schemas SET status = 'active' WHERE id = %s;",
                         (SCHEMA_DRAFT,))
        as_user(self.cur, ADMIN)
        with self.assertRaises(psycopg2.errors.CheckViolation):
            self.cur.execute("SELECT public.approve_proposal(%s);", (proposal,))


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

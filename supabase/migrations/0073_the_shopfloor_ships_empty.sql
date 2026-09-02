-- =============================================================================================
-- 0073_the_shopfloor_ships_empty.sql
--
-- Retires the last five demonstration rows -- the schemas -- so a fresh install has no cells, no
-- gateways, no devices and no schemas, and the only gateway on the stack is the Playback gateway
-- that 0060 creates because playback has nowhere else to publish from.
--
-- 0040 retired the four `Sim_Gateway_*` rows and the six `Sim_*` devices and ARGUED FOR KEEPING
-- THE SCHEMAS: a schema is a contract rather than an asset, it costs nothing unattached, and it
-- made putting the floor back a matter of creating rows rather than re-authoring five JSON
-- Schemas. That argument was correct while `provision-gateways.mjs` existed to put the floor back.
-- It does not any more. The demonstrator is a WALKTHROUGH now -- `tutorial/README.md` -- and what
-- it teaches is how to author a schema, so shipping four pre-authored ones for machines the reader
-- does not have skips the lesson and leaves the Schemas table looking like somebody else's plant.
--
-- WHAT GOES:
--   * `Simulated_CNC_01_Schema` (e3333333-...), seeded by 0002 until this change.
--   * The four class schemas 0022 defined: Machining_Cell_Schema, Robotics_Cell_Schema,
--     Facility_BMS_Schema and AGV_Fleet_Schema (aa000000-...0001 through ...0004).
--
-- 0022 IS DELETED RATHER THAN AMENDED, because every statement in it was one of those two things:
-- the INSERT above and the attachment of those schemas to the six devices 0040 already removed.
-- A migration whose whole body no-ops is worse than no migration -- it reads as something still
-- doing work.
--
-- WHY BOTH THE EDIT AND THIS FILE, which is 0020's argument and then 0040's, unchanged: 0002 is
-- `ON CONFLICT DO NOTHING` throughout, so deleting its INSERT builds a fresh database correctly
-- and leaves every EXISTING one exactly as it was -- the schemas still present, and now with
-- nothing in the repository explaining where they came from.
--
-- ---------------------------------------------------------------------------------------------
-- IDEMPOTENT BY CONSTRUCTION, AND IT NEEDS NO one_shot_migrations ENTRY.
--
-- This is the case 0040 is NOT. 0040 deletes rows an operator may deliberately want back, so
-- replaying it would make provisioning useless and it has to consult the ledger. These five rows
-- are addressed by PINNED id, and nothing recreates them: 0002 no longer inserts them and 0022 is
-- gone. A second run matches no rows, which is the house rule satisfied the easy way.
--
-- A SCHEMA THE USER AUTHORS IS NOT TOUCHED. The predicate is five literal UUIDs, not a name
-- pattern -- `Sim\_%` would have caught the first person to author `Sim_MyMachine`, which is
-- exactly the landmine 0022's own self-check turned out to be.
--
-- ---------------------------------------------------------------------------------------------
-- THE DELETE APPENDS TO digital_thread, and that is not a defect.
--
-- 0070 put `trg_schemas_digital_thread` on this table, so each row removed here records its own
-- removal. 0020 recorded the same thing about the device purge -- "the purge is itself recorded".
-- On a stack that has already run, this makes the log slightly longer before it makes it shorter;
-- on a fresh install nothing is deleted because nothing was ever inserted.
--
-- Related: 0002 (the seed this empties), 0020 and 0040 (the earlier retirements), 0060/0067 (the
--          Playback gateway, which stays), 0070 (the audit trigger above).
-- =============================================================================================

SET search_path TO public;

DO $$
DECLARE
  v_schema_ids CONSTANT uuid[] := ARRAY[
    'e3333333-4444-5555-6666-777777777777',  -- Simulated_CNC_01_Schema  (0002)
    'aa000000-0000-4000-8000-000000000001',  -- Machining_Cell_Schema    (0022)
    'aa000000-0000-4000-8000-000000000002',  -- Robotics_Cell_Schema     (0022)
    'aa000000-0000-4000-8000-000000000003',  -- Facility_BMS_Schema      (0022)
    'aa000000-0000-4000-8000-000000000004'   -- AGV_Fleet_Schema         (0022)
  ]::uuid[];
  v_attachments INT;
  v_schemas     INT;
BEGIN
  -- THE JOIN ROWS FIRST, EXPLICITLY. On a stack where 0040 has run there are none, because the
  -- devices went with it. On one where a reader attached a demonstration schema to a device of
  -- their own, there are -- and that device keeps its row and loses only the attachment, which is
  -- the right outcome and the reason this is not left to a cascade nobody can see.
  DELETE FROM public.device_submodels
   WHERE schema_id = ANY(v_schema_ids);
  GET DIAGNOSTICS v_attachments = ROW_COUNT;

  -- AND THE LEGACY ARM. `devices.schema_id` is the other half of the `device_schemas` view and
  -- carries a foreign key, so a device still pointing at one of these would block the delete
  -- below with a constraint error rather than a useful message.
  UPDATE public.devices
     SET schema_id = NULL
   WHERE schema_id = ANY(v_schema_ids);

  DELETE FROM public.schemas
   WHERE id = ANY(v_schema_ids);
  GET DIAGNOSTICS v_schemas = ROW_COUNT;

  IF v_schemas > 0 OR v_attachments > 0 THEN
    RAISE NOTICE '0073: retired % demonstration schema(s) and % attachment(s).',
      v_schemas, v_attachments;
  END IF;
END $$;

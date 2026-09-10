-- =============================================================================================
-- 0073_the_shopfloor_ships_empty.sql
--
-- Retires the last five demonstration rows, the schemas, so a fresh install has no cells, no
-- gateways, no devices and no schemas; the only gateway is the Playback gateway. 0040 kept the
-- schemas while `provision-gateways.mjs` existed to put the floor back; the demonstrator is a
-- walkthrough in `tutorial/` now, and what it teaches is how to author a schema.
--
-- Goes: `Simulated_CNC_01_Schema` (e3333333-...) and the four class schemas (aa000000-...0001
-- through ...0004). Both this file and the edit to 0002 are needed, since 0002 is ON CONFLICT DO
-- NOTHING throughout.
--
-- Idempotent without a `one_shot_migrations` entry: the rows are addressed by pinned id and
-- nothing recreates them, so a second run matches no rows. A schema the user authors is not
-- touched (five literal UUIDs, not a name pattern). The DELETE appends to digital_thread, which
-- is the purge being recorded.
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

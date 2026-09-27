-- =============================================================================================
-- Migration: 0012_a_semantic_id_is_an_iri_or_an_irdi.sql
-- A semantic id is an IRI or an IRDI; ModelReference is withdrawn (#479)
-- =============================================================================================
--
-- `schemas.semantic_id_type` and `metric_catalog.semantic_id_type` allowed a third value,
-- ModelReference, that nothing could emit. The AAS exporter writes every semantic id as an
-- ExternalReference with one GlobalReference key, which is right for an IRI or an IRDI and wrong
-- for a ModelReference, and one text column cannot carry the typed key chain a ModelReference is.
-- The dashboard no longer offers it, and this narrows both CHECKs to IRI and IRDI.
-- `idta_submodel_templates.semantic_id_type` already allows only those two.
--
-- A row still holding ModelReference stops the boot, naming the table and what to change. It is
-- not rewritten here, because which of the two it meant is the operator's call.
--
-- 0001 replays first and restores its three-value CHECK, so on a full boot this replaces the
-- constraint again until the next squash folds the two-value form into the baseline. The
-- replacement is guarded on the definition, so a replay of this file alone changes nothing.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

-- Before the constraint is narrowed, so the operator reads this rather than a CHECK violation.
DO $$
DECLARE
  v_table text;
  v_held  bigint;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['schemas', 'metric_catalog'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE semantic_id_type = %L',
                   v_table, 'ModelReference')
       INTO v_held;
    IF v_held > 0 THEN
      RAISE EXCEPTION '0012: % row(s) in public.% have semantic_id_type ModelReference, which is withdrawn.',
                      v_held, v_table
        USING HINT = format(
          'Set each to IRI (a URL or URN) or IRDI (an ECLASS or IEC CDD code), or clear semantic_id '
          'and semantic_id_type together, as the database owner, then run db-init again. To list them: '
          'SELECT id, semantic_id FROM public.%I WHERE semantic_id_type = ''ModelReference'';',
          v_table);
    END IF;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_semantic_id_type_valid'
                    AND conrelid = 'public.schemas'::regclass
                    AND pg_get_constraintdef(oid) NOT LIKE '%ModelReference%') THEN
    ALTER TABLE public.schemas
      DROP CONSTRAINT IF EXISTS schemas_semantic_id_type_valid,
      ADD CONSTRAINT schemas_semantic_id_type_valid
        CHECK (semantic_id_type IS NULL OR semantic_id_type IN ('IRI', 'IRDI'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_semantic_id_type_valid'
                    AND conrelid = 'public.metric_catalog'::regclass
                    AND pg_get_constraintdef(oid) NOT LIKE '%ModelReference%') THEN
    ALTER TABLE public.metric_catalog
      DROP CONSTRAINT IF EXISTS metric_catalog_semantic_id_type_valid,
      ADD CONSTRAINT metric_catalog_semantic_id_type_valid
        CHECK (semantic_id_type IS NULL OR semantic_id_type IN ('IRI', 'IRDI'));
  END IF;
END
$$;

-- 0001 restates the three-value comment on every boot, so this one does too.
COMMENT ON COLUMN public.metric_catalog.semantic_id_type IS 'Which kind of AAS Reference semantic_id is: IRI or IRDI. Both export as an ExternalReference.';
COMMENT ON COLUMN public.schemas.semantic_id_type IS 'Which kind of AAS Reference semantic_id is: IRI or IRDI. Both export as an ExternalReference.';

-- What this file did: each CHECK exists, is validated, admits IRI and IRDI, and not ModelReference.
DO $check$
DECLARE
  v_table text;
  v_def   text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['schemas', 'metric_catalog'] LOOP
    SELECT pg_get_constraintdef(c.oid) INTO v_def
      FROM pg_constraint c
     WHERE c.conname = v_table || '_semantic_id_type_valid'
       AND c.conrelid = format('public.%I', v_table)::regclass
       AND c.contype = 'c'
       AND c.convalidated;
    IF v_def IS NULL THEN
      RAISE EXCEPTION '0012 self-check: public.% has no validated %_semantic_id_type_valid CHECK.',
                      v_table, v_table;
    END IF;
    IF v_def LIKE '%ModelReference%' OR v_def NOT LIKE '%''IRI''%' OR v_def NOT LIKE '%''IRDI''%' THEN
      RAISE EXCEPTION '0012 self-check: public.%.semantic_id_type is constrained as %, not to IRI and IRDI.',
                      v_table, v_def;
    END IF;
  END LOOP;
END
$check$;

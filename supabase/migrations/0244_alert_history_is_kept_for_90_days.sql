-- 0244: Alert history is kept for 90 days, and a site still at 7 moves to 90 once.
--
-- alerts.retention_days defaults to 90, not 7, so History's Alerts tab has a season of alerts to
-- list. Any value but 7 is kept. A site still at 7 moves to 90 at the upgrade to 1.8.0, and only
-- then: a 7 chosen after it stays.
--
--   * 0002 seeds 90 through seed_setting(), which inserts on a first boot and afterwards refreshes
--     only the metadata. Just before it, 0002 sets 90 where the value is 7 and the description is
--     still the text every release from 1.0.0 to 1.7.x wrote. The seed_setting() call then writes
--     1.8's description, so no later boot matches. updated_by cannot tell the two apart: a
--     migration's write leaves it NULL, as it leaves a metadata refresh.
--   * prune_platform_alerts() falls back to 90 days, not 7, where the setting cannot be read.
--
-- A body change and a seed, not a new signature. db-init replays every file on every boot, so each
-- is declared in place where it is stated, as 0227 and 0235 declared theirs: 0001 for the prune's
-- fallback and 0002 for the setting. This file holds no copy. It checks what they now declare.
--
-- Reasoning: supabase/README.md, "Alert history is kept for 90 days (0244)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- Self-check: the setting no longer carries 1.7's description, so a later boot cannot move a 7,
-- and the prune falls back to 90 days. Its value is a person's choice, so it is not checked.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  -- 1.0.0 to 1.7.x's description, which 0002's guard matches.
  c_old CONSTANT text :=
    'How long a resolved or superseded alert occurrence is kept before the nightly prune removes '
    'it. The telemetry that triggered the alert is retained separately under the historian''s own '
    'policy, so shortening this destroys no measurement -- only the record that a threshold was '
    'crossed. A currently firing alert is never removed however old it is.';
  v_description text;
  v_body text;
BEGIN
  SELECT description INTO v_description FROM public.system_settings WHERE key = 'alerts.retention_days';
  IF NOT FOUND THEN
    RAISE EXCEPTION '0244: alerts.retention_days is not seeded; 0002 seeds it';
  END IF;
  IF v_description IS NOT DISTINCT FROM c_old THEN
    RAISE EXCEPTION '0244: alerts.retention_days still has 1.7''s description, so a later boot would move a 7 a person chose to 90';
  END IF;
  IF position('90 days' IN v_description) = 0 THEN
    RAISE EXCEPTION '0244: alerts.retention_days'' description does not name the 90-day default';
  END IF;

  SELECT prosrc INTO v_body FROM pg_proc WHERE oid = 'public.prune_platform_alerts(interval)'::regprocedure;
  IF position('interval ''90 days''' IN v_body) = 0 OR position('interval ''7 days''' IN v_body) > 0 THEN
    RAISE EXCEPTION '0244: prune_platform_alerts() does not fall back to 90 days; 0001 declares it';
  END IF;
END
$check$;

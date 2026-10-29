-- 0220: A Grafana alert keeps the uid of its rule, its labels and its values.
--
-- platform_alerts has three nullable columns, which grafana-alert-webhook fills from each alert in
-- Grafana's notification:
--
--   * rule_uid: the uid of the rule that raised the alert, read from the alert's generatorURL
--     (.../alerting/grafana/<uid>/view). The dashboard links straight to the rule with it.
--   * labels: the alert's labels as Grafana sent them, the rule's and its series' together.
--   * values: the rule's query and expression results by refId, as Grafana sent them.
--
-- 0001 states the columns and platform_alerts_active, which returns them: 0001 replays first on
-- every boot, and its CREATE OR REPLACE VIEW could not drop columns a later file had added. Its
-- guard drops the view once, when the column list differs. This file describes the columns and
-- checks the result. A row written before the upgrade keeps all three NULL, and its link searches
-- Grafana by the rule's name, as before. The occurrence key stays (fingerprint, starts_at). The
-- grants and policies are on the table and the view, not on their columns, so they cover the three.
--
-- Reasoning: supabase/README.md, "An alert keeps its rule's uid, labels and values (0220)".
-- Idempotent.

COMMENT ON COLUMN public.platform_alerts.rule_uid IS
  'The uid of the Grafana rule that raised the alert, from the path of the alert''s generatorURL '
  '(.../alerting/grafana/<uid>/view). A stable key for the rule, which its title is not: the '
  'dashboard links to /alerting/grafana/<uid>/view with it. NULL on a row written before 0220, or '
  'when the notification named no rule (0220).';

COMMENT ON COLUMN public.platform_alerts.labels IS
  'The alert''s labels as Grafana sent them, a JSON object of strings: the rule''s own labels, its '
  'series'' labels, alertname and grafana_folder. Grafana removes its private labels, those named '
  '__x__, before a contact point sees them. NULL on a row written before 0220 (0220).';

COMMENT ON COLUMN public.platform_alerts."values" IS
  'The values Grafana evaluated for the alert, a JSON object of numbers by the refId of each query '
  'and expression node (A, B, C), as sent with the notification. NULL on a row written before 0220, '
  'or when Grafana sent none (0220).';

-- -------------------------------------------------------------------------------------------------
-- What this file and 0001 did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_column text;
  v_type text;
  v_relation text;
BEGIN
  FOR v_column, v_type IN VALUES ('rule_uid', 'text'), ('labels', 'jsonb'), ('values', 'jsonb') LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'platform_alerts'
                      AND column_name = v_column AND data_type = v_type
                      AND is_nullable = 'YES' AND column_default IS NULL) THEN
      RAISE EXCEPTION '0220: platform_alerts.% is missing, not %, NOT NULL or defaulted', v_column, v_type;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'platform_alerts_active'
                      AND column_name = v_column AND data_type = v_type) THEN
      RAISE EXCEPTION '0220: platform_alerts_active does not return % as %; 0001 states the view', v_column, v_type;
    END IF;
    FOREACH v_relation IN ARRAY ARRAY['platform_alerts', 'platform_alerts_active'] LOOP
      IF NOT has_column_privilege('authenticated', format('public.%I', v_relation), v_column, 'SELECT') THEN
        RAISE EXCEPTION '0220: authenticated cannot read %.%; the dashboard links by it', v_relation, v_column;
      END IF;
      IF has_column_privilege('anon', format('public.%I', v_relation), v_column, 'SELECT') THEN
        RAISE EXCEPTION '0220: anon may read %.%', v_relation, v_column;
      END IF;
    END LOOP;
    -- One privilege per call: has_column_privilege() answers true when ANY of a list is held.
    IF has_column_privilege('authenticated', 'public.platform_alerts', v_column, 'INSERT')
       OR has_column_privilege('authenticated', 'public.platform_alerts', v_column, 'UPDATE') THEN
      RAISE EXCEPTION '0220: authenticated may write platform_alerts.%; only the webhook writes it', v_column;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.platform_alerts_active'::regclass
                    AND 'security_invoker=true' = ANY (reloptions)) THEN
    RAISE EXCEPTION '0220: platform_alerts_active lost security_invoker, so it would read past the table''s RLS';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';

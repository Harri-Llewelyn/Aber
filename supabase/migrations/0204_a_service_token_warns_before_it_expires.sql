-- 0204: A service token warns before it expires.
--
-- A machine identity's token lasts at most service_token_max_days(). Once it expires the API
-- refuses it, and the client presenting it fails as if the server were broken. This file gives the
-- Grafana rule "Service Token Expiring" what it reads, and lets an alert be about a machine identity.
--
--   * service_token_health has one row per token that has not expired and is not revoked, whose
--     identity exists and is not withdrawn. It reads the TOKEN_MINTED audit rows, as the Access
--     Control page's token list does. warn_at is 7 days before expiry, or a quarter of the lifetime
--     before it for a shorter token, so a 7-day token warns 42 hours before.
--   * grafana_reader reads it through the owner-run service_token_health_rows(), so it holds no
--     privilege on audit_trail or the identity tables. 0001's last block repeats both grants.
--   * platform_alerts takes entity_type 'service_identity', with the principal's id as entity_id and
--     no sparkplug_id. 0001 declares the two widened CHECKs itself: it replays first on every boot
--     and re-adds a CHECK that differs from its own, which would fail on the first such row.
--   * Only an Administrator reads a service_identity alert. Every other row stays readable by every
--     signed-in role, as before.
--
-- Reasoning: supabase/README.md, "A service token warns before it expires (0204)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Every live token, with the moment it warns
-- -------------------------------------------------------------------------------------------------
-- The pinned identities have no machine_principals row, so their names are the ones the Access
-- Control page gives them (KNOWN_PRINCIPALS in frontend/src/utils/serviceIdentities.js; the mirror
-- check holds the two lists together). `renewal` says how a new token is made: on the page, or by
-- `npm run keys:rotate` for the three identities whose keys the deployment reads at start.
CREATE OR REPLACE FUNCTION public.service_token_health_rows()
RETURNS TABLE(principal_id uuid, identity_name text, renewal text, jti text,
              issued_at timestamp with time zone, expires_at timestamp with time zone,
              warn_at timestamp with time zone, remaining_seconds numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
  WITH minted AS (
    -- The newest record of each jti, as revoke_service_token() reads it. A token outlives its row
    -- by at most service_token_max_days(), so an older row names an expired token. That bound (with
    -- a day to spare) and the security lane let the plan prune old partitions and read the rest
    -- through idx_audit_trail_domain.
    SELECT DISTINCT ON (a.new_data ->> 'jti')
           a.entity_id,
           a.new_data ->> 'jti' AS jti,
           coalesce((a.new_data ->> 'issued_at')::timestamptz, a.recorded_at) AS issued_at,
           (a.new_data ->> 'expires_at')::timestamptz AS expires_at
      FROM public.audit_trail a
     WHERE a.audit_domain = 'security'
       AND a.recorded_at > now() - make_interval(days => public.service_token_max_days() + 1)
       AND a.entity_type = 'service_principals'
       AND a.action = 'TOKEN_MINTED'
       AND a.new_data ->> 'jti' IS NOT NULL
     ORDER BY a.new_data ->> 'jti', a.id DESC
  ), pinned(principal_id, name, renewal) AS (
    VALUES ('b0000000-0000-4000-8000-000000000001'::uuid, 'Read-only API client', 'access_control'),
           ('b0000000-0000-4000-8000-000000000002'::uuid, 'Service_Ingestor', 'keys_rotate'),
           ('b0000000-0000-4000-8000-000000000003'::uuid, 'Service_Playback', 'keys_rotate'),
           ('b0000000-0000-4000-8000-000000000004'::uuid, 'Service_ReleaseCheck', 'keys_rotate')
  )
  SELECT m.entity_id,
         coalesce(mp.name, p.name, 'Undocumented machine identity'),
         coalesce(p.renewal, 'access_control'),
         m.jti,
         m.issued_at,
         m.expires_at,
         m.expires_at - LEAST(interval '7 days', (m.expires_at - m.issued_at) / 4),
         EXTRACT(EPOCH FROM (m.expires_at - now()))
    FROM minted m
    JOIN auth.users u ON u.id = m.entity_id
    LEFT JOIN public.machine_principals mp ON mp.principal_id = m.entity_id
    LEFT JOIN pinned p ON p.principal_id = m.entity_id
   WHERE m.expires_at > now()
     AND NOT EXISTS (SELECT 1 FROM public.revoked_service_tokens r WHERE r.jti = m.jti)
     AND NOT EXISTS (SELECT 1 FROM public.revoked_service_principals w WHERE w.principal_id = m.entity_id)
   ORDER BY m.expires_at, m.jti
$$;

ALTER FUNCTION public.service_token_health_rows() OWNER TO postgres;

COMMENT ON FUNCTION public.service_token_health_rows() IS
  'The rows service_token_health shows. SECURITY DEFINER so grafana_reader needs no privilege on '
  'audit_trail, auth.users, machine_principals or the two revocation tables (0204).';

REVOKE ALL ON FUNCTION public.service_token_health_rows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_token_health_rows() TO service_role;

CREATE OR REPLACE VIEW public.service_token_health AS
 SELECT now() AS collected_at,
    principal_id,
    identity_name,
    renewal,
    jti,
    issued_at,
    expires_at,
    warn_at,
    remaining_seconds
   FROM public.service_token_health_rows() r(principal_id, identity_name, renewal, jti, issued_at, expires_at, warn_at, remaining_seconds);

ALTER VIEW public.service_token_health OWNER TO postgres;

COMMENT ON VIEW public.service_token_health IS
  'Every machine-identity token that has not expired and is not revoked, whose identity exists and '
  'is not withdrawn: its identity, jti, issue and expiry, warn_at (7 days before expiry, or a '
  'quarter of a shorter lifetime) and the seconds left. renewal is access_control or keys_rotate. '
  'Read by the Grafana rule "Service Token Expiring" as grafana_reader (0204).';

REVOKE ALL ON public.service_token_health FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.service_token_health TO service_role;

-- The role exists only where BI_READER_PASSWORD is set. 0001's last block makes the same grants on
-- every later boot, after its sweep.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    GRANT EXECUTE ON FUNCTION public.service_token_health_rows() TO grafana_reader;
    GRANT SELECT ON public.service_token_health TO grafana_reader;
  END IF;
END
$grant$;

-- -------------------------------------------------------------------------------------------------
-- 2. Only an Administrator reads an alert about a machine identity
-- -------------------------------------------------------------------------------------------------
-- An Administrator is the one who can act on it, on Access Control. platform_alerts_active is
-- security_invoker, so it reads through this policy too, and Realtime applies it to each change.
BEGIN;
SELECT public.replay_policy('public.platform_alerts', 'platform_alerts_select_authenticated', $ddl$
CREATE POLICY platform_alerts_select_authenticated ON public.platform_alerts FOR SELECT TO authenticated USING (((entity_type <> 'service_identity'::text) OR ( SELECT public.has_role(ARRAY['Administrator'::text]) AS has_role)));
$ddl$);
COMMIT;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
  IF position('''service_identity''' IN coalesce(
       public.live_constraint_definition('public.platform_alerts'::regclass, 'platform_alerts_entity_type_valid'), '')) = 0
     OR position('''service_identity''' IN coalesce(
       public.live_constraint_definition('public.platform_alerts'::regclass, 'platform_alerts_asset_has_wire_id'), '')) = 0 THEN
    RAISE EXCEPTION '0204: platform_alerts does not admit a service_identity alert; 0001 declares both CHECKs';
  END IF;
  IF position('service_identity' IN coalesce(
       public.live_policy_statement('public.platform_alerts', 'platform_alerts_select_authenticated'), '')) = 0 THEN
    RAISE EXCEPTION '0204: platform_alerts_select_authenticated does not keep a service_identity alert to Administrators';
  END IF;
  IF has_function_privilege('anon', 'public.service_token_health_rows()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.service_token_health_rows()', 'EXECUTE')
     OR has_table_privilege('anon', 'public.service_token_health', 'SELECT')
     OR has_table_privilege('authenticated', 'public.service_token_health', 'SELECT') THEN
    RAISE EXCEPTION '0204: a browser role can read service_token_health, past the audit trail''s RLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader')
     AND NOT (has_table_privilege('grafana_reader', 'public.service_token_health', 'SELECT')
              AND has_function_privilege('grafana_reader', 'public.service_token_health_rows()', 'EXECUTE')) THEN
    RAISE EXCEPTION '0204: grafana_reader cannot read service_token_health, so Service Token Expiring would sit in error';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';

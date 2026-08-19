-- =============================================================================================
-- 0025_physical_gateway_enrollment.sql
--
-- Enrolment state for PHYSICAL gateways: a single-use, short-lived token that lets an appliance
-- exchange a downloaded bundle for its own broker credential exactly once.
--
-- THE PROBLEM THIS SOLVES. `is_virtual = false` has always been expressible, but there was no way
-- to get a physical gateway a credential: `mosquitto.acl` confines every client to
-- `spBv1.0/+/+/%u/#`, so each gateway needs its own account, and accounts are issued by
-- scripts/mosquitto-provision-gateway.mjs -- which `docker exec`s into the broker or patches a
-- Kubernetes Secret. Neither is reachable from a browser or from an edge function. So the flow was:
-- create a row in the UI, then have an operator with shell access run a script and hand the
-- password over by some other means.
--
-- The alternative that must NOT be built is putting the password in the downloadable bundle: a
-- long-lived broker credential in a file that travels through a browser's download folder, a USB
-- stick and probably an email, with no revocation story. So the bundle carries a CLAIM instead, and
-- this is the table that claim is checked against.
--
-- ---------------------------------------------------------------------------------------------
-- WHY A SEPARATE TABLE AND NOT COLUMNS ON `gateways`. THREE INDEPENDENT REASONS, EACH SUFFICIENT.
--
--  1. `gateways_select_authenticated` is `USING (true)` (0001). EVERY authenticated user -- Operator
--     and Auditor included -- can select every column of that table. A token hash sitting there is
--     readable by the whole estate.
--
--  2. `log_digital_thread_event()` writes `to_jsonb(NEW)` -- the ENTIRE ROW -- into
--     `digital_thread.old_data`/`new_data` (0005). Token columns on `gateways` would therefore be
--     copied into the audit log on every write, including the write that consumes them, and
--     `digital_thread` is deliberately append-only and un-redactable.
--
--  3. `public.gateway_status` is `SELECT g.*` (0001). Anything added to `gateways` propagates into a
--     second published relation, and that view is what the dashboard actually reads.
--
-- A SHA-256 of 32 random bytes is not practically recoverable, so none of these is a catastrophe on
-- its own. They are the reason the design does not have to argue about it: the token material is
-- simply not on a table anything reads.
--
-- THIS TABLE CARRIES NO digital_thread TRIGGER, for the same reason inverted -- the audit event
-- worth having is the `gateways.status` transition (PENDING_ENROLLMENT -> AWAITING_BIRTH), which
-- fires from the existing trigger on the existing table and names the gateway rather than a token.
--
-- ---------------------------------------------------------------------------------------------
-- THE LIFECYCLE, and where each transition is written:
--
--   PENDING_ENROLLMENT  the UI creates a physical gateway and mints a token   (this migration's RPC)
--   AWAITING_BIRTH      the appliance redeemed the token and holds a credential   (enroll-gateway)
--   ONLINE              its first NBIRTH arrived                          (ingestion.py, unchanged)
--
-- The last transition is FREE and is not implemented anywhere: process_node_message() writes
-- `status` unconditionally on every node-level message, so the first heartbeat clears the
-- transitional state and logs it as a genuine STATUS TRANSITION. `gateways.status` is plain text
-- with no CHECK constraint (0001) and deliberately stays that way -- a `Gateway_Status` string
-- metric in an NBIRTH payload overrides the derived status, so the column's domain is not ours to
-- close.
-- =============================================================================================

SET search_path TO public;


-- ---------------------------------------------------------------------------------------------
-- 1. Gateway columns
-- ---------------------------------------------------------------------------------------------
-- Facts about the APPLIANCE, which is why they live on the gateway and not on the token: they
-- outlive every token the gateway is ever issued, and they are what an operator needs on the page.
-- Neither is a secret.
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS enrolled_at timestamp with time zone;
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS agent_version text;

COMMENT ON COLUMN public.gateways.enrolled_at IS
  'When this gateway last redeemed an enrolment token and received a broker credential. NULL for a virtual gateway and for a physical one that has never enrolled. Re-enrolment overwrites it.';
COMMENT ON COLUMN public.gateways.agent_version IS
  'Version stamp of the bundle the appliance is running, reported at enrolment. Lets the fleet''s vintage be seen without reaching into every appliance -- a bundle generated once lives on somebody''s hardware indefinitely.';

COMMENT ON COLUMN public.gateways.status IS
  'Free text, deliberately unconstrained -- a Gateway_Status metric in an NBIRTH payload overrides '
  'whatever the message type implies, so the domain is not closed. The values this platform writes '
  'are: PENDING_ENROLLMENT (a physical gateway awaiting its bundle redemption), AWAITING_BIRTH '
  '(enrolled, holds a credential, has not yet published), ONLINE and OFFLINE (written by the '
  'ingestion daemon from node-level Sparkplug messages). STALE is DERIVED at read time by '
  'public.gateway_status and is never stored.';


-- ---------------------------------------------------------------------------------------------
-- 2. The enrolment tokens
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gateway_enrollment_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    gateway_id uuid NOT NULL,
    -- HEX SHA-256 OF THE TOKEN, NEVER THE TOKEN. The raw value is returned to the caller exactly
    -- once, by the RPC below, and is not recoverable afterwards -- the same property
    -- mosquitto_passwd gives the broker credential this token is exchanged for.
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    -- Single use. Set by consume_gateway_enrollment_token() when an appliance redeems it, and by
    -- issue_gateway_enrollment_token() when a REPLACEMENT is minted -- so re-issuing a bundle
    -- invalidates the one already downloaded rather than leaving two live claims on one gateway.
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT gateway_enrollment_tokens_pkey PRIMARY KEY (id),
    CONSTRAINT gateway_enrollment_tokens_gateway_fk
      FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE,
    -- A 64-character lowercase hex digest. Refuses a raw token accidentally stored in place of its
    -- hash, which is the one write that would turn this table into the thing it exists to avoid.
    CONSTRAINT gateway_enrollment_tokens_hash_is_sha256
      CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT gateway_enrollment_tokens_expiry_after_creation
      CHECK (expires_at > created_at)
);

COMMENT ON TABLE public.gateway_enrollment_tokens IS
  'Single-use, short-lived claims that let a physical gateway appliance exchange its downloaded '
  'bundle for a broker credential exactly once. NOT READABLE BY ANY BROWSER-FACING ROLE -- RLS is '
  'enabled with no policy for anon or authenticated, so only service_role (which bypasses RLS) can '
  'see it, and only the enroll-gateway edge function holds that key. Deliberately a separate table '
  'rather than columns on public.gateways: that table is world-readable to authenticated users, its '
  'full row is copied into digital_thread on every write, and public.gateway_status selects g.*.';

-- The lookup enroll-gateway performs, and the uniqueness that makes a hash collision a write
-- failure rather than an ambiguous redemption.
CREATE UNIQUE INDEX IF NOT EXISTS gateway_enrollment_tokens_hash_key
  ON public.gateway_enrollment_tokens (token_hash);

-- ONE LIVE TOKEN PER GATEWAY, enforced on `consumed_at IS NULL` alone.
--
-- IT CANNOT ALSO TEST `expires_at > now()`, and that is a Postgres constraint rather than a choice:
-- index predicates must be IMMUTABLE, and now() is STABLE, so the obvious "one UNEXPIRED live
-- token" index is rejected outright (`functions in index predicate must be marked IMMUTABLE`).
-- Expiry is therefore enforced at redemption, and the issuing RPC consumes any prior live token
-- before inserting -- which is what keeps this index satisfiable and keeps a re-issued bundle from
-- leaving the previous download valid.
CREATE UNIQUE INDEX IF NOT EXISTS gateway_enrollment_tokens_one_live_per_gateway
  ON public.gateway_enrollment_tokens (gateway_id)
  WHERE consumed_at IS NULL;


-- ---------------------------------------------------------------------------------------------
-- 3. Access control
-- ---------------------------------------------------------------------------------------------
-- RLS ON, NO POLICIES, AND THE GRANTS REVOKED. Three layers saying the same thing, because
-- Supabase's default privileges GRANT ALL on a new table in `public` to anon and authenticated --
-- so a table created here arrives writable by the browser unless the grant is taken back. RLS with
-- no matching policy already denies, but a privilege that is never meant to exist should not be
-- left standing behind a policy check.
--
-- service_role is enumerated rather than given ALL: it bypasses RLS, so these grants are the only
-- limit that applies to it. It needs SELECT (find the token), INSERT (issue) and UPDATE (consume);
-- it never needs DELETE -- a redeemed token is evidence, and expiry is a timestamp, not a deletion.
ALTER TABLE public.gateway_enrollment_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.gateway_enrollment_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.gateway_enrollment_tokens TO service_role;


-- ---------------------------------------------------------------------------------------------
-- 4. Issuing a token
-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER, called BY THE BROWSER as the signed-in user.
--
-- WHY AN RPC RATHER THAN AN EDGE FUNCTION. Minting the token is the one step that must happen with
-- privileges the caller does not have (an INSERT into a table `authenticated` cannot touch), and
-- routing it through an edge function would mean handing that function the service-role key for
-- what is otherwise a pure database operation. A SECURITY DEFINER function checks the caller's role
-- with the same public.has_role() every RLS policy uses, so there is one answer to "who may do
-- this" rather than two.
--
-- THE RAW TOKEN IS RETURNED EXACTLY ONCE and is not stored. A caller who loses it re-issues, which
-- invalidates the previous one -- that is the intended recovery path, and it is why re-issuing is
-- cheap rather than alarming.
CREATE OR REPLACE FUNCTION public.issue_gateway_enrollment_token(
  p_gateway_id uuid,
  p_ttl_minutes integer DEFAULT 30
)
RETURNS TABLE (token text, expires_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_token    text;
  v_expires  timestamp with time zone;
  v_gateway  public.gateways%ROWTYPE;
BEGIN
  -- Fail closed, and check authority before anything observable happens. Same allow-list as the
  -- write policies on `gateways`: issuing a bundle is a gateway-management act.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to issue a gateway enrolment token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- BOUNDED, because the TTL arrives from a client. A 30-minute default matches the time it takes
  -- to carry a bundle to an appliance and boot it; the ceiling is a day, past which a "short-lived
  -- single-use claim" is neither.
  IF p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 1440 THEN
    RAISE EXCEPTION 'p_ttl_minutes must be between 1 and 1440 (got %)', p_ttl_minutes
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A VIRTUAL GATEWAY HAS NO APPLIANCE TO ENROL. `is_virtual` means "no physical edge appliance
  -- behind this row" -- a host-run connector or a simulator -- so a bundle for one would produce a
  -- broker credential nothing could ever present. Refused here rather than left to fail later at
  -- the point where a download does nothing.
  IF v_gateway.is_virtual THEN
    RAISE EXCEPTION 'gateway % is virtual; enrolment bundles are for physical appliances only',
      v_gateway.name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Invalidate any live token for this gateway FIRST. Two reasons, and the second is structural:
  -- re-issuing must kill the bundle already downloaded (otherwise "regenerate" hands out a second
  -- valid claim rather than replacing the first), and the partial unique index above permits only
  -- one unconsumed row per gateway.
  UPDATE public.gateway_enrollment_tokens
     SET consumed_at = now()
   WHERE gateway_id = p_gateway_id
     AND consumed_at IS NULL;

  -- 32 bytes, hex-encoded. `extensions.gen_random_bytes` is pgcrypto, already relied on by 0002 and
  -- 0006 for the OAuth client secret hashes -- the same extension, in the same schema.
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(mins => p_ttl_minutes);

  INSERT INTO public.gateway_enrollment_tokens (gateway_id, token_hash, expires_at, created_by)
  VALUES (
    p_gateway_id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_expires,
    -- Nullable and carries no FK on purpose: auth.uid() is NULL when this is called with the
    -- service-role key (provisioning scripts, tests), and recording who asked is useful while
    -- failing because nobody did is not. It is provenance, not a constraint.
    auth.uid()
  );

  -- The gateway enters the lifecycle here rather than at creation, so a row created before this
  -- migration -- or one whose bundle is being re-issued after a failed enrolment -- lands in the
  -- same state as a new one. Guarded on an actual change: `gateways` carries the digital_thread
  -- trigger, and an unconditional write would append an audit row on every re-issue.
  IF v_gateway.status IS DISTINCT FROM 'PENDING_ENROLLMENT' THEN
    UPDATE public.gateways
       SET status = 'PENDING_ENROLLMENT'
     WHERE id = p_gateway_id;
  END IF;

  RETURN QUERY SELECT v_token, v_expires;
END $$;

COMMENT ON FUNCTION public.issue_gateway_enrollment_token(uuid, integer) IS
  'Mint a single-use enrolment token for a physical gateway and move it to PENDING_ENROLLMENT. '
  'Returns the raw token ONCE -- only its SHA-256 is stored. Requires Administrator or '
  'Shopfloor_Manager. Re-issuing consumes any previous live token, so a regenerated bundle '
  'invalidates the one already downloaded.';

-- EXECUTE for authenticated only. The function checks has_role() itself, but a SECURITY DEFINER
-- function that anon may call is one bug away from being an unauthenticated minting endpoint.
REVOKE ALL ON FUNCTION public.issue_gateway_enrollment_token(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_gateway_enrollment_token(uuid, integer) TO authenticated;


-- ---------------------------------------------------------------------------------------------
-- 5. Redeeming a token
-- ---------------------------------------------------------------------------------------------
-- CALLED BY enroll-gateway WITH THE SERVICE-ROLE KEY, on behalf of an appliance that holds no
-- session at all. It therefore performs no role check -- possession of the token IS the
-- authorisation, which is the whole point of the pattern.
--
-- THE CLAIM IS ATOMIC, AND THAT IS THE REASON THIS IS A FUNCTION RATHER THAN THREE STATEMENTS IN
-- TYPESCRIPT. `UPDATE ... WHERE consumed_at IS NULL RETURNING` lets exactly one of two concurrent
-- redemptions win: the loser's UPDATE matches no row and it returns nothing. Read-then-write in the
-- edge function would let both appliances observe an unconsumed token and both receive a
-- credential for the same edge node -- and because mosquitto.acl pins the topic to the username,
-- they would then silently fight over one identity.
--
-- ONE INDISTINGUISHABLE FAILURE. Unknown, expired and already-consumed all return zero rows.
-- Telling them apart would let an enumerator learn which token values ever existed, and the
-- appliance can do nothing different in any of the three cases.
CREATE OR REPLACE FUNCTION public.consume_gateway_enrollment_token(p_token text)
RETURNS TABLE (
  gateway_id uuid,
  sparkplug_id text,
  sparkplug_group text,
  gateway_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_hash       text;
  v_gateway_id uuid;
BEGIN
  -- Shape-checked before it is hashed, so a malformed value cannot reach the index at all.
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  UPDATE public.gateway_enrollment_tokens t
     SET consumed_at = now()
   WHERE t.token_hash = v_hash
     AND t.consumed_at IS NULL
     AND t.expires_at > now()
  RETURNING t.gateway_id INTO v_gateway_id;

  IF v_gateway_id IS NULL THEN
    RETURN;
  END IF;

  -- The identity the appliance needs on the wire. `sparkplug_id` is the generated column the ACL
  -- pins the topic's edge-node segment to, and `sparkplug_group` is the other half of the address
  -- resolve_gateway() looks up first -- an appliance told only the node id falls through to the
  -- group-agnostic arm, which works until two groups exist.
  RETURN QUERY
  SELECT g.id, g.sparkplug_id, g.sparkplug_group, g.name
    FROM public.gateways g
   WHERE g.id = v_gateway_id;
END $$;

COMMENT ON FUNCTION public.consume_gateway_enrollment_token(text) IS
  'Atomically claim a live enrolment token and return the gateway''s wire identity. Returns NO ROWS '
  'for an unknown, expired or already-consumed token -- the three are deliberately '
  'indistinguishable. Called by the enroll-gateway edge function with the service-role key; the '
  'token itself is the authorisation, so no role is checked.';

-- NOT CALLABLE BY A BROWSER. Redemption is an appliance's act, performed through enroll-gateway;
-- an authenticated user who could call this directly could burn a colleague's live token.
-- service_role is not granted explicitly because it bypasses these grants, as it does for the table.
REVOKE ALL ON FUNCTION public.consume_gateway_enrollment_token(text) FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 5b. Releasing a claim that could not be completed
-- ---------------------------------------------------------------------------------------------
-- THE OTHER HALF OF AN ATOMIC CLAIM, and without it the atomicity above is a liability rather than
-- a protection.
--
-- `enroll-gateway` claims the token FIRST and then asks the credential service for a broker
-- account. That order is forced: a read-then-write would let two appliances both observe an
-- unconsumed token and both receive a credential for the same edge node. But it means a failure in
-- the second step -- the broker down, the credential service unreachable, a network partition --
-- leaves a token consumed and an appliance holding a bundle that can never be redeemed. The
-- operator's only recovery is to notice and re-issue, and nothing tells them to.
--
-- So a failed issuance RELEASES the claim and answers 503, and the appliance simply retries. The
-- token is short-lived either way; this decides whether a transient broker outage costs a retry or
-- costs a manual re-issue per appliance.
--
-- ---------------------------------------------------------------------------------------------
-- TWO CONDITIONS ON THE RELEASE, and both are refusals to resurrect something that should stay dead:
--
--   * STILL WITHIN ITS EXPIRY. Releasing an expired token would restore a row that
--     consume_gateway_enrollment_token() refuses anyway -- and, because the partial unique index
--     counts any row with consumed_at IS NULL, it would then BLOCK the operator from issuing a
--     replacement. A dead token that also jams re-issuance is worse than a dead token.
--
--   * NO OTHER LIVE TOKEN FOR THAT GATEWAY. If an operator re-issued during the failed attempt,
--     that new token is the live one and this one was deliberately superseded -- restoring it would
--     violate the same index, and the INSERT is not the caller's to undo. Returning false is the
--     honest answer: this bundle is dead, and the appliance holding it needs the new one.
--
-- Returns whether the claim was actually released, so the caller can say which of "retry with the
-- same bundle" and "get a new bundle" applies rather than guessing.
CREATE OR REPLACE FUNCTION public.release_gateway_enrollment_token(p_token text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_hash     text;
  v_released integer;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  UPDATE public.gateway_enrollment_tokens t
     SET consumed_at = NULL
   WHERE t.token_hash = v_hash
     AND t.consumed_at IS NOT NULL
     AND t.expires_at > now()
     AND NOT EXISTS (
       SELECT 1 FROM public.gateway_enrollment_tokens o
        WHERE o.gateway_id = t.gateway_id
          AND o.consumed_at IS NULL
     );

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released = 1;
END $$;

COMMENT ON FUNCTION public.release_gateway_enrollment_token(text) IS
  'Undo a claim made by consume_gateway_enrollment_token() when the credential could not be '
  'issued, so the appliance can retry with the same bundle. Refuses to release an expired token or '
  'one that has since been superseded by a re-issue -- both would restore a row the partial unique '
  'index counts, blocking the operator from issuing a replacement. Returns whether it released.';

-- Same posture as consume: an appliance's act performed through enroll-gateway with the
-- service-role key. A signed-in user able to call this could resurrect a token they had just
-- watched someone else redeem.
REVOKE ALL ON FUNCTION public.release_gateway_enrollment_token(text) FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 6. Rebuild public.gateway_status
-- ---------------------------------------------------------------------------------------------
-- REQUIRED, AND EASY TO MISS. The view is `SELECT g.*, <derived columns>`, and `g.*` is EXPANDED AT
-- CREATION TIME -- so `enrolled_at` and `agent_version` do not appear in it until it is recreated,
-- and CREATE OR REPLACE VIEW cannot widen it in place once a new column lands ahead of the derived
-- ones. 0001 provides this function for exactly this situation and its comment says so.
--
-- THE VIEW ALSO LEARNS THE TWO PENDING STATES, so it and frontend/src/utils/gatewayStatus.js keep
-- answering identically -- they are mirrors, and check-mirror-drift.mjs pins their shared threshold.
--
-- A gateway in PENDING_ENROLLMENT would survive without this by luck: it has never beaten, so
-- `last_heartbeat` is NULL and the staleness arm never runs. AWAITING_BIRTH does not. A gateway
-- being RE-ENROLLED -- replaced hardware, a rotated credential -- carries the OLD heartbeat from its
-- previous life, so it would report STALE while the truth is that it is waiting for its first
-- message. That reads as a fault on a gateway nobody has finished installing.
--
-- `is_stale` is deliberately left alone: it answers "has the heartbeat aged out", which is a fact
-- about the timestamp and stays true of an old one. Only the DERIVED label short-circuits.
CREATE OR REPLACE FUNCTION public.ensure_gateway_status_view() RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $fn$
BEGIN
  DROP VIEW IF EXISTS public.gateway_status;

  -- security_invoker is load-bearing. Without it the view executes as its owner (postgres)
  -- and silently bypasses the RLS on public.gateways, exposing every gateway to any role
  -- holding SELECT on the view. With it, each caller's own policies apply exactly as on the
  -- base table. Requires PG15+; this stack is on supabase/postgres 17.6.
  CREATE VIEW public.gateway_status
  WITH (security_invoker = true) AS
  SELECT
    g.*,
    -- Mirrors gatewayLiveStatus(): the ENROLMENT states win outright (a gateway mid-installation is
    -- not a fault), then a stored OFFLINE (an explicit NDEATH is not staleness), then a gateway that
    -- has never reported keeps its stored status, and anything else ages out.
    CASE
      WHEN g.status IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH')      THEN g.status
      WHEN g.status = 'OFFLINE'                                      THEN 'OFFLINE'
      WHEN g.last_heartbeat IS NULL                                  THEN g.status
      WHEN NOW() - g.last_heartbeat > INTERVAL '90 seconds'          THEN 'STALE'
      ELSE g.status
    END AS live_status,
    -- Mirrors isHeartbeatStale(): a gateway that has never reported is NOT stale (false),
    -- which is why this is not simply `live_status = 'STALE'`.
    (g.last_heartbeat IS NOT NULL
     AND NOW() - g.last_heartbeat > INTERVAL '90 seconds')           AS is_stale,
    EXTRACT(EPOCH FROM (NOW() - g.last_heartbeat))::BIGINT           AS heartbeat_age_seconds
  FROM public.gateways g;

  COMMENT ON VIEW public.gateway_status IS
    'public.gateways with heartbeat staleness derived at read time. Mirrors '
    'frontend/src/utils/gatewayStatus.js -- keep the 90s threshold AND the pending-state '
    'short-circuit in step. Deliberately a view, not a stored column or a pg_cron writer: writing '
    'status would append to the immutable digital_thread audit table on every sweep and would be '
    'stale between ticks. Rebuilt by public.ensure_gateway_status_view() -- call it after adding a '
    'gateways column.';

  -- DROP VIEW discards the grants with the view, so they are re-applied here rather than
  -- left outside the function where they would silently stop being re-run.
  REVOKE ALL ON public.gateway_status FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON public.gateway_status TO authenticated;
END $fn$;

SELECT public.ensure_gateway_status_view();


-- ---------------------------------------------------------------------------------------------
-- 7. Self-check
-- ---------------------------------------------------------------------------------------------
-- Asserts the properties that fail SILENTLY and in the dangerous direction. A missing column errors
-- on first use and is found immediately; a table that is readable by `authenticated` never errors
-- at all, and neither does a view that quietly lacks its new columns.
DO $$
DECLARE
  v_policies int;
  v_rls      boolean;
  v_grants   text;
  v_missing  text;
  v_fn       text;
BEGIN
  SELECT relrowsecurity INTO v_rls
    FROM pg_class WHERE oid = 'public.gateway_enrollment_tokens'::regclass;
  IF NOT v_rls THEN
    RAISE EXCEPTION '0025 self-check: RLS is not enabled on gateway_enrollment_tokens';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'gateway_enrollment_tokens';
  IF v_policies <> 0 THEN
    RAISE EXCEPTION
      '0025 self-check: gateway_enrollment_tokens has % RLS policy/policies. It must have NONE -- '
      'the table is reachable only by service_role, which bypasses RLS entirely. A policy here '
      'would be the first grant of browser access to token material.', v_policies;
  END IF;

  SELECT string_agg(DISTINCT grantee, ', ') INTO v_grants
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'gateway_enrollment_tokens'
     AND grantee IN ('anon', 'authenticated', 'PUBLIC');
  IF v_grants IS NOT NULL THEN
    RAISE EXCEPTION
      '0025 self-check: gateway_enrollment_tokens is still granted to %. Supabase grants ALL on a '
      'new public table to anon and authenticated by default; the REVOKE above is what takes it '
      'back.', v_grants;
  END IF;

  SELECT string_agg(c, ', ' ORDER BY c) INTO v_missing
    FROM unnest(ARRAY['enrolled_at', 'agent_version']) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'gateway_status' AND column_name = c
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      '0025 self-check: public.gateway_status does not expose %. The view selects g.*, which is '
      'expanded at creation time -- call public.ensure_gateway_status_view() after adding a column '
      'to public.gateways.', v_missing;
  END IF;

  -- The three RPCs, and the fact that only ONE of them is reachable from a browser. issue is called
  -- by the dashboard; consume and release are the appliance's, performed through enroll-gateway with
  -- the service-role key. A grant of either to `authenticated` would let a signed-in user burn or
  -- resurrect a colleague's live token, and nothing would error.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'release_gateway_enrollment_token'
  ) THEN
    RAISE EXCEPTION '0025 self-check: release_gateway_enrollment_token() is missing -- a failed '
      'issuance would leave every affected token permanently consumed';
  END IF;

  FOR v_fn IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('consume_gateway_enrollment_token', 'release_gateway_enrollment_token')
       AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR has_function_privilege('anon', p.oid, 'EXECUTE'))
  LOOP
    RAISE EXCEPTION
      '0025 self-check: %() is EXECUTE-able by a browser-facing role. Redemption is an appliance''s '
      'act, performed through enroll-gateway with the service-role key.', v_fn;
  END LOOP;

  RAISE NOTICE
    '0025 self-check passed: token table is service_role-only, gateway_status carries the new '
    'columns, and only issue_gateway_enrollment_token() is reachable from a browser.';
END $$;

NOTIFY pgrst, 'reload schema';

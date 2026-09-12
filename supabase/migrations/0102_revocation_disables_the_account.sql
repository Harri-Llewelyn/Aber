-- 0102: revocation disables the broker account.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- The broker's accounts moved from a password file to its Dynamic Security plugin
-- (mosquitto/README.md). revoke_gateway_credential() still posts the same request to the same edge
-- function; that function now asks the credential service to DISABLE the account rather than
-- re-issue it under an unrecorded password. What that changes for the database's record: a
-- disabled account's live session is dropped at once rather than at its next reconnect, the
-- account stays at the broker listed as disabled, and a later issue re-enables it. No function
-- body changes here; the two COMMENTs are what described the old mechanism.

SET search_path TO public;

COMMENT ON FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) IS
  'Ask the credential service to disable this gateway''s broker account, which is how this platform revokes: the broker drops any live session at once and refuses the next CONNECT. The account is not deleted; a later issue re-enables it. Returns false when the service is not configured. ASYNCHRONOUS: net.http_post queues the request, so a true return means "asked", not "revoked". The sweep is what makes archive eventually correct.';

-- The one other live COMMENT that named the retired ACL file as the authority.
COMMENT ON TABLE public.rebirth_requests IS
  'A person asking an edge node to republish its birth certificate. The daemon claims PENDING rows and publishes Node Control/Rebirth, which is the only NCMD this stack sends and the only one the ingestion role at the broker permits it (mosquitto/dynsec-roles.json). Not a general command channel: writing a metric VALUE is actuation and is deliberately not reachable from here. See 0058''s header.';

COMMENT ON COLUMN public.gateways.credential_revoked_at IS
  'When this gateway''s broker account was last disabled at the broker, which is how this platform revokes. NULL on a gateway that is not archived, and on an archived one whose revocation has not yet succeeded -- the sweep in 0038 retries those. Set back to NULL by re-enrolment, because that issues a fresh working credential; a later issue from the dashboard outranks it in gateway_status.';

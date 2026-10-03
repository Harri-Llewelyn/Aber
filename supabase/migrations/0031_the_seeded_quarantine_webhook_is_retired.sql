-- =============================================================================================
-- Migration: 0031_the_seeded_quarantine_webhook_is_retired.sql
-- The seeded quarantine webhook, which nothing served, is removed with its vault secret
-- =============================================================================================
--
-- 0002 seeded a webhook_endpoints row posting device.quarantined to
-- http://node-red:1880/hooks/quarantine. The demo flow that served that path is retired and
-- Node-RED's seeded flow is blank, so every quarantine produced a 404 that pg_net recorded in
-- net._http_response and nobody read. 0002 no longer seeds the row; this file deletes it from
-- stacks that hold it.
--
-- Only the seeded row, matched by its id AND its original URL: a site that re-pointed it at a flow
-- of its own keeps it. Webhooks stay a feature, and so does the Node-RED signing key, which
-- httpNodeAuth verifies every `http in` request against.
--
-- The row's own secret goes too: 0002 kept a vault copy of the Node-RED admin token,
-- nodered_admin_token, for that row and nothing else, and no longer writes it. Node-RED's
-- break-glass token comes from its environment and is unaffected. The vault copy stays while a
-- webhook_endpoints row names it, so a row a site added with it keeps working.
--
-- Reasoning: supabase/README.md, "The seeded quarantine webhook is retired (0031)". Idempotent.
-- =============================================================================================

SET search_path TO public;

DELETE FROM public.webhook_endpoints
 WHERE id = '3484ec9d-e07f-49ee-8aa3-f95d40d38a54'
   AND url = 'http://node-red:1880/hooks/quarantine';

-- After the row above, which could have named it.
DELETE FROM vault.secrets
 WHERE name = 'nodered_admin_token'
   AND NOT EXISTS (SELECT 1 FROM public.webhook_endpoints WHERE secret_name = 'nodered_admin_token');

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- ---------------------------------------------------------------------------------------------
DO $check$
BEGIN
    IF EXISTS (SELECT 1 FROM public.webhook_endpoints
                WHERE id = '3484ec9d-e07f-49ee-8aa3-f95d40d38a54'
                  AND url = 'http://node-red:1880/hooks/quarantine') THEN
        RAISE EXCEPTION '0031: the seeded quarantine webhook is still in webhook_endpoints';
    END IF;
    IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'nodered_admin_token')
       AND NOT EXISTS (SELECT 1 FROM public.webhook_endpoints WHERE secret_name = 'nodered_admin_token') THEN
        RAISE EXCEPTION '0031: vault still holds nodered_admin_token, and no webhook names it';
    END IF;
END
$check$;

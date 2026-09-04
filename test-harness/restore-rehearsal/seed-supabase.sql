-- Known data for the backup/restore rehearsal, on the Supabase side.
--
-- WHY FIXED IDS. The rehearsal asserts the SAME rows come back, not that some rows came back, so
-- every id here is a literal. A generated id would make the post-restore assertion "a device
-- exists", which is satisfied by a restore that lost this one and kept another.
--
-- WHY THIS SEEDS THROUGH THE NORMAL TABLES rather than writing digital_thread directly. The audit
-- rows this produces are written by `log_digital_thread_event()`, which is the trigger a restore
-- has to bring back; seeding the audit table by hand would test the dump's ability to carry rows
-- and not its ability to carry the machinery that writes them.
--
-- IDEMPOTENT, because the rehearsal seeds the FIRST install and a re-run against a surviving
-- cluster must not fail on a duplicate key. It is not idempotent in the audit trail and cannot be:
-- 0003 makes digital_thread append-only, so a second seed adds a second set of audit rows. That is
-- why the count snapshot is taken after seeding rather than assumed.

\set ON_ERROR_STOP on

BEGIN;

-- 1. The asset hierarchy: a cell holds a gateway, which holds a device -------------------------
INSERT INTO public.cells (id, name)
VALUES ('e1000000-0000-4000-8000-000000000001', 'Rehearsal Cell')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO public.gateways (id, name, deployment, cell_id, description)
VALUES ('e2000000-0000-4000-8000-000000000001', 'Rehearsal Gateway', 'remote',
        'e1000000-0000-4000-8000-000000000001', 'Seeded by the restore rehearsal')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO public.devices (id, name, gateway_id, description)
VALUES ('e3000000-0000-4000-8000-000000000001', 'Rehearsal Device',
        'e2000000-0000-4000-8000-000000000001', 'Seeded by the restore rehearsal')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 2. A Vault secret ---------------------------------------------------------------------------
--
-- THE DOCUMENTED FAILURE MODE, and the reason this is seeded rather than borrowed. Vault is
-- encrypted with a pgsodium root key that lives OUTSIDE the dump, so a restore into a database
-- whose key differs produces rows that are present, well-formed, and undecryptable -- and nothing
-- about the restore reports it. Commit 4ee344e exists because that was found late once already.
--
-- Its own secret rather than `nodered_admin_token`: that one is only created when the token is
-- supplied, so on a stack installed without Node-RED there would be nothing to decrypt and the
-- assertion would pass by being vacuous.
DO $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'restore_rehearsal_canary';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret('rehearsal-canary-plaintext', 'restore_rehearsal_canary',
                                'Written by the restore rehearsal; decrypting it after a restore '
                                'proves the pgsodium root key survived.');
  ELSE
    PERFORM vault.update_secret(v_id, 'rehearsal-canary-plaintext');
  END IF;
END $$;

COMMIT;

-- Deliberately outside the transaction: it reports what the rehearsal will later have to find.
SELECT 'seeded cells/gateways/devices and the vault canary' AS seed_supabase;

-- =================================================================================================
-- The TimescaleDB extension, brought up to the version the image actually ships.
-- =================================================================================================
--
-- WHY THIS FILE EXISTS. Bumping the image tag upgrades the BINARIES and leaves the SQL-level
-- extension exactly where it was, because nothing runs `ALTER EXTENSION ... UPDATE`. Postgres then
-- loads the versioned library matching the INSTALLED version, so the database goes on running the
-- older release's definitions inside the newer image -- indefinitely, and with nothing anywhere
-- saying so. Measured on a healthy stack before this file existed:
--
--         name      | default_version | installed_version
--     -------------+-----------------+-------------------
--      timescaledb | 2.29.2          | 2.29.1
--
-- `default_version` is what the image ships. `installed_version` is what the database is running.
-- The gap is the defect, and it widened on every bump.
--
-- IT RUNS IN ITS OWN SESSION, AND FIRST, AND BOTH HALVES ARE LOAD-BEARING.
--
--   * Its own session, because `ALTER EXTENSION` is refused once the old version's library has
--     been loaded into the connection. Appended to retention.sql it would fail on every stack that
--     had anything to update -- which is precisely the stack this is for.
--   * First, because everything else the maintenance path applies uses the API surface this
--     updates. `docs/postgres-17-migration-plan.md` records what that surface can do across a
--     boundary: compression became columnstore, the entry points became procedures requiring
--     `CALL`, and the options changed shape. That note verifies the upgrade path over a database
--     carrying the legacy settings -- a verification that assumes the extension updates at all.
--
-- IDEMPOTENT, and quiet when there is nothing to do: an extension already at `default_version`
-- draws a NOTICE from Postgres and no work. On a fresh volume the extension is created by
-- timescaledb/init at the image's own version, so this is a no-op there by construction.
--
-- Related: docs/postgres-17-migration-plan.md (the API rename this ordering protects),
--          docs/upgrades.md (what bumping the image tag is expected to do),
--          timescaledb/init/001_schema.sql (which creates the extension, on an EMPTY volume only).
-- =================================================================================================

ALTER EXTENSION timescaledb UPDATE;

-- -------------------------------------------------------------------------------------------------
-- AND THEN ASSERT IT TOOK, because the whole defect was that nobody was looking.
--
-- A successful `ALTER EXTENSION` that leaves the versions apart is not a state to carry on from:
-- the database is running one release's SQL definitions against another release's library, which is
-- the exact condition this file exists to end. It is LOUD -- the maintenance Job fails and the
-- upgrade with it -- because the alternative is the failure mode
-- being fixed here: true, invisible, and unbounded.
--
-- Two ways to arrive, and the message names the remedy for each rather than only the numbers.
-- -------------------------------------------------------------------------------------------------
DO $$
DECLARE
    v_default   text;
    v_installed text;
BEGIN
    SELECT default_version, installed_version
      INTO v_default, v_installed
      FROM pg_available_extensions
     WHERE name = 'timescaledb';

    IF v_installed IS NULL THEN
        RAISE EXCEPTION
          'timescaledb is not installed in this database. It is created by '
          'timescaledb/init/001_schema.sql, which runs only on an EMPTY data directory.';
    END IF;

    IF v_default IS DISTINCT FROM v_installed THEN
        RAISE EXCEPTION
          'timescaledb extension version drift: the image ships % and the database is running %. '
          'If % is the newer of the two, the update did not take -- restart the TimescaleDB '
          'container so no session holds the old library, and let this step run again. If % is '
          'the newer, the image tag was rolled back below the installed extension and the '
          'database is ahead of its own binaries: restore the tag that matches, because an '
          'extension cannot be downgraded.',
          v_default, v_installed, v_default, v_installed;
    END IF;

    RAISE NOTICE 'timescaledb extension is at %, matching the image.', v_installed;
END $$;

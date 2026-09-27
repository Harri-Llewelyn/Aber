-- The TimescaleDB extension, brought to the version the image ships. Bumping the image tag upgrades the
-- binaries and nothing runs ALTER EXTENSION, so the database keeps running the older release's
-- definitions. Applied FIRST and in its own psql session: the ALTER is refused once a connection has
-- loaded the old library, and every later file uses the API surface it updates. Idempotent and quiet
-- when current. Reasoning and the measured drift: timescaledb/README.md.
ALTER EXTENSION timescaledb UPDATE;

-- Assert it took. A successful ALTER that leaves the versions apart is the condition this file
-- exists to end, so the Job fails loudly; the message names the remedy for each direction of drift.
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

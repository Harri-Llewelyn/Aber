# Conformance test runner, for running the E2E suites IN-CLUSTER.
#
# WHY AN IMAGE AND NOT A ConfigMap. `validate.py` needs psycopg2, paho and a protoc-generated
# `sparkplug_b_pb2` -- all of which the ingestion image already has, which is why this extends it
# rather than starting from `python:slim` and rebuilding that work. `test_aas_export.py` additionally
# needs `jsonschema`, and jsonschema is DELIBERATELY NOT in the ingestion image: that is a production
# artefact and test dependencies do not belong in it. Without jsonschema the suite still runs but
# `@skipUnless(HAVE_JSONSCHEMA)` silently drops the schema-conformance tests -- the ones that caught
# three real metamodel violations the hand-written structural tests had passed. A suite that skips
# its most valuable assertions and still reports success is worse than one that fails.
#
# WHY THE REPO-SHAPED LAYOUT. Both AAS suites resolve their fixtures relative to
# `Path(__file__).resolve().parents[3]`:
#
#   test-harness/schemas/AAS_V3_0_JSON_Schema.json                  the vendored IDTA metamodel schema
#   supabase/functions/_shared/aas/sparkplugToXsd.ts         \  the two duplicated mappers, and
#   frontend/src/utils/sparkplugDatatype.js                  /  the drift check between them
#   supabase/functions/_shared/aas/model3dContentType.ts     \  likewise for the 3D model
#   frontend/src/utils/model3d.js                            /  content-type table
#   supabase/functions/_shared/aas/shell.ts                  modelledMetrics(), EXECUTED not grepped
#   supabase/functions/main/index.ts                         the registry test_aas_api.py asserts
#   supabase/functions/aas-api/index.ts                      its own source-level checks
#   docs/openapi.yaml                                        every served route must be documented
#
# Those parity checks are the reason the mappers may be duplicated at all (an edge worker cannot
# import the frontend bundle), so they have to travel with the suite. Flattening the layout would
# make parents[3] resolve somewhere else and every one of them would fail on a missing file.
#
# THE TWO MAPPERS MOVED to _shared/aas/ when aas-api began sharing the mapping layer with
# aas-export. They are copied from there now; their parity contract with the frontend is unchanged.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT:
#   docker build -f test-harness/Dockerfile -t ghcr.io/harri-llewelyn/aber/test-runner:<tag> .
#
# The default below is a convenience for a bare `docker build` and nothing more -- both CI and
# release.yml pass INGESTION_IMAGE explicitly, because at release time the base is the ingestion
# image built minutes earlier under the version being released, which no committed default can
# name. The default is the last released tag rather than a floating one: left to drift, a bare
# build here would silently extend a DIFFERENT ingestion image than the one the chart deploys, and
# the suite would then be testing a stack it is not running beside.
ARG INGESTION_IMAGE=ghcr.io/harri-llewelyn/aber/ingestion:1.2.0
FROM ${INGESTION_IMAGE}

# The ingestion image's WORKDIR is /app and it holds ingestion.py, validate.py and
# sparkplug_b_pb2.py at the top level -- that is where validate.py expects to find its protobuf
# module, so nothing there moves.
WORKDIR /app

# Draft 2019-09 is what the IDTA schema declares; the version is pinned so a resolver change cannot
# quietly turn a conformance failure into a pass.
#
# The ingestion image removes pip after its own install, so this restores it, uses it and removes
# it again. `ensurepip` ships inside CPython and carries its own pip wheel, so this reaches no
# index for pip itself.
RUN python -m ensurepip \
    && python -m pip install --no-cache-dir jsonschema==4.23.0 \
    && python -m pip uninstall -y pip

# The load generator, at the TOP LEVEL beside validate.py rather than under test-harness/: it
# imports `sparkplug_b_pb2`, which the ingestion image puts at /app, and a script run from a
# subdirectory puts that subdirectory on sys.path instead.
COPY test-harness/load_generator.py /app/load_generator.py

# parents[3] of /app/supabase/functions/aas-export/test_aas_export.py is /app -- so these paths, and
# only these paths, make the suites' lookups resolve.
COPY test-harness/schemas /app/test-harness/schemas
# The suites' SUBJECT, provisioned at runtime rather than seeded. Both import it, so
# it travels with them or every live check skips itself for want of a device.
COPY test-harness/aas_fixture.py /app/test-harness/aas_fixture.py
# test_aas_api.py asserts that every route the service advertises is documented, so the spec is a
# fixture of the suite rather than only a deliverable.
COPY docs/openapi.yaml /app/docs/openapi.yaml
COPY supabase/functions/aas-export/test_aas_export.py \
     supabase/functions/aas-export/index.ts \
     /app/supabase/functions/aas-export/
# The bundle's role check is held to the grants in 0002 and the policies the migrations declare.
COPY supabase/migrations/*.sql /app/supabase/migrations/
COPY supabase/functions/aas-api/test_aas_api.py \
     supabase/functions/aas-api/index.ts \
     /app/supabase/functions/aas-api/
# The registry, not the handler, is where the service-role key would be granted -- which is the
# invariant test_aas_api.py exists to hold.
COPY supabase/functions/main/index.ts \
     /app/supabase/functions/main/
COPY supabase/functions/_shared/aas/sparkplugToXsd.ts \
     supabase/functions/_shared/aas/model3dContentType.ts \
     supabase/functions/_shared/aas/shell.ts \
     /app/supabase/functions/_shared/aas/
COPY frontend/src/utils/sparkplugDatatype.js \
     frontend/src/utils/model3d.js \
     /app/frontend/src/utils/

# Overrides the ingestion daemon's CMD. Each Job names the suite it wants explicitly; this default
# exists so a bare `docker run` of this image does something legible rather than starting a daemon.
CMD ["python", "-c", "print('aber test-runner: pass a suite, e.g. python validate.py or python supabase/functions/aas-export/test_aas_export.py')"]

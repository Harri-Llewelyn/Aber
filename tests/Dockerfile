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
# WHY THE REPO-SHAPED LAYOUT. test_aas_export.py resolves five files relative to
# `Path(__file__).resolve().parents[3]`:
#
#   tests/schemas/AAS_V3_0_JSON_Schema.json                  the vendored IDTA metamodel schema
#   supabase/functions/aas-export/sparkplugToXsd.ts          \  the two duplicated mappers, and
#   frontend/src/utils/sparkplugDatatype.js                  /  the drift check between them
#   supabase/functions/aas-export/model3dContentType.ts      \  likewise for the 3D model
#   frontend/src/utils/model3d.js                            /  content-type table
#
# Those parity checks are the reason the mappers may be duplicated at all (an edge worker cannot
# import the frontend bundle), so they have to travel with the suite. Flattening the layout would
# make parents[3] resolve somewhere else and every one of them would fail on a missing file.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT:
#   docker build -f tests/Dockerfile -t ghcr.io/harri-llewelyn/acs-cymru/test-runner:<tag> .
#
# The default below is a convenience for a bare `docker build` and nothing more -- both CI and
# release.yml pass INGESTION_IMAGE explicitly, because at release time the base is the ingestion
# image built minutes earlier under the version being released, which no committed default can
# name. Its tag is asserted equal to the chart's appVersion by scripts/check-image-tag-parity.mjs:
# left to drift, a bare build here would silently extend a DIFFERENT ingestion image than the one
# the chart deploys, and the suite would then be testing a stack it is not running beside.
ARG INGESTION_IMAGE=ghcr.io/harri-llewelyn/acs-cymru/ingestion:0.1.0
FROM ${INGESTION_IMAGE}

# The ingestion image's WORKDIR is /app and it holds ingestion.py, validate.py and
# sparkplug_b_pb2.py at the top level -- that is where validate.py expects to find its protobuf
# module, so nothing there moves.
WORKDIR /app

# Draft 2019-09 is what the IDTA schema declares; the version is pinned so a resolver change cannot
# quietly turn a conformance failure into a pass.
RUN pip install --no-cache-dir jsonschema==4.23.0

# parents[3] of /app/supabase/functions/aas-export/test_aas_export.py is /app -- so these paths, and
# only these paths, make the suite's five lookups resolve.
COPY tests/schemas /app/tests/schemas
COPY supabase/functions/aas-export/test_aas_export.py \
     supabase/functions/aas-export/sparkplugToXsd.ts \
     supabase/functions/aas-export/model3dContentType.ts \
     /app/supabase/functions/aas-export/
COPY frontend/src/utils/sparkplugDatatype.js \
     frontend/src/utils/model3d.js \
     /app/frontend/src/utils/

# Overrides the ingestion daemon's CMD. Each Job names the suite it wants explicitly; this default
# exists so a bare `docker run` of this image does something legible rather than starting a daemon.
CMD ["python", "-c", "print('acs-cymru test-runner: pass a suite, e.g. python validate.py or python supabase/functions/aas-export/test_aas_export.py')"]

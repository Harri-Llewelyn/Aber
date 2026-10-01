# 3.13-slim, and the minor version is load-bearing: the 3.10 image bundles `setuptools` and
# `wheel` into site-packages, where a scanner reads them as runtime dependencies of this service.
# They are neither -- nothing here builds a package. 3.12 onwards ships `pip` alone, so the bump
# removes them rather than pinning them forward. Kept in step with i3x/Dockerfile.
FROM python:3.13-slim

# protobuf-compiler, to generate sparkplug_b_pb2.py from the .proto at build time.
#
# DELIBERATELY WHATEVER apt HAS (libprotoc 3.21.12 on this base), which is two majors behind the
# protobuf runtime in requirements.txt. That is fine and is explained there: the 5.x runtime loads
# 3.21 gencode, and Debian has no newer compiler to offer anyway. Trixie offers the same 3.21.12
# bookworm did, so the bump above does not move it.
#
# --no-install-recommends, which i3x/Dockerfile has always passed. Without it apt pulls in
# linux-libc-dev -- kernel headers nothing here compiles against, and 66 reported CVEs.
#
# `apt-get upgrade` takes the base's Debian packages to the distribution's current fixes, so a fix
# Debian ships between two cuts of the base reaches the release rather than failing its scan.
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Set up application workspace
WORKDIR /app

# Copy and install Python requirements
COPY ingestion/requirements.txt .
# pip is removed once it has done its one job. Nothing in this image installs a package at run
# time, and with the base at 3.13 pip's own vendored tree is the last thing in here a scanner
# reports -- `msgpack` and `setuptools`, neither of which this service imports. test-harness/
# Dockerfile extends this image and restores pip with `ensurepip` for its own install.
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m pip uninstall -y pip

# Copy sources into the container
COPY sparkplug_b.proto .
COPY ingestion/ingestion.py .
COPY ingestion/logging_config.py .
# The Prometheus exposition renderer and its HTTP thread (issues #22, #24). Imported by
# ingestion.py at module scope, so a missing COPY here is a crash loop on start, not a
# degraded endpoint.
COPY ingestion/metrics.py .
# The counter registry metrics.py renders, and the constraint engine (issue #152). Both are
# imported by ingestion.py at module scope: the same crash-loop rule as above.
COPY ingestion/registry.py .
COPY ingestion/conformance.py .
COPY ingestion/validate.py .
# Dashboard-driven broker capture. SAME RULE AS metrics.py ABOVE, and it bites
# twice here: ingestion.py imports capture_worker at module scope, and capture_worker imports
# capture -- which was previously a host-run CLI and shipped in no image at all. Either one missing
# is a crash loop on start rather than a feature that quietly does nothing.
COPY ingestion/capture_worker.py .
COPY ingestion/capture.py .
# The playback worker, which runs from THIS IMAGE under a different command.
#
# A SECOND IMAGE IS NOT NEEDED. What playback requires that is genuinely new is a separate
# PROCESS with a separate Supabase principal and its own broker credentials --
# none of which an image boundary provides. It publishes using capture.py's own `plan_playback()`,
# which is already here, so a second image would be this one minus two files plus a second build
# and a second tag to keep in step.
COPY ingestion/playback_worker.py .

# The Directory's MQTT half. SAME RULE AS metrics.py AND capture_worker.py ABOVE, and this file is
# the reason that rule is stated three times: ingestion.py imports it at module scope deliberately,
# so a missing COPY is a crash loop on start rather than a Directory that quietly never publishes.
# It was missing here for exactly one test cycle, and the daemon said so on the first boot --
# `ModuleNotFoundError: No module named 'directory_publish'` -- which is the failure worth having.
COPY ingestion/directory_publish.py .
# The Unified Namespace bridge, imported at module scope for the same reason: a missing COPY
# is a crash loop on start, not a bridge that quietly never publishes.
COPY ingestion/uns_publish.py .
# The primary host's STATE certificates, imported at module scope for the same reason -- and here
# the silent failure would be worse than a bridge that never publishes: the daemon would run
# healthily while every gateway watched the topic it announces itself on and saw nothing, which is
# the state this module exists to end.
COPY ingestion/primary_host.py .

# Cold telemetry archival. IN THIS IMAGE RATHER THAN ITS OWN, for the reason the
# playback worker is: it needs the historian connection, the daemon's storage identity and the
# settings reader that already live here, and a second image would be this one minus two files plus
# a tag to keep in step. It is a CLI, not a service -- nothing starts it; `python -m cold_archive`
# does, on demand or from a scheduler.
COPY ingestion/cold_archive.py .

# Compile the Sparkplug B protobuf definition
RUN protoc --python_out=. sparkplug_b.proto

# Start the ingestion pipeline daemon
CMD ["python", "ingestion.py"]

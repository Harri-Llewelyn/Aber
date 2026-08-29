FROM python:3.10-slim

# protobuf-compiler, to generate sparkplug_b_pb2.py from the .proto at build time.
#
# DELIBERATELY WHATEVER apt HAS (libprotoc 3.21.12 on this base), which is two majors behind the
# protobuf runtime in requirements.txt. That is fine and is explained there: the 5.x runtime loads
# 3.21 gencode, and Debian has no newer compiler to offer anyway.
RUN apt-get update && apt-get install -y \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Set up application workspace
WORKDIR /app

# Copy and install Python requirements
COPY ingestion/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy sources into the container
COPY sparkplug_b.proto .
COPY ingestion/ingestion.py .
COPY ingestion/logging_config.py .
# The Prometheus exposition renderer and its HTTP thread (issues #22, #24). Imported by
# ingestion.py at module scope, so a missing COPY here is a crash loop on start, not a
# degraded endpoint.
COPY ingestion/metrics.py .
COPY ingestion/validate.py .
# Dashboard-driven broker capture (roadmap item 17). SAME RULE AS metrics.py ABOVE, and it bites
# twice here: ingestion.py imports capture_worker at module scope, and capture_worker imports
# capture -- which was previously a host-run CLI and shipped in no image at all. Either one missing
# is a crash loop on start rather than a feature that quietly does nothing.
COPY ingestion/capture_worker.py .
COPY ingestion/capture.py .
# The playback worker (roadmap item 17 §5), which runs from THIS IMAGE under a different command.
#
# THE ROADMAP PRICED A SECOND IMAGE AND IT IS NOT NEEDED. What playback requires that is genuinely
# new is a separate PROCESS with a separate Supabase principal and its own broker credentials --
# none of which an image boundary provides. It publishes using capture.py's own `plan_playback()`,
# which is already here, so a second image would be this one minus two files plus a second build,
# a second tag to keep in step, and a second entry in check-image-tag-parity.mjs.
COPY ingestion/playback_worker.py .

# Compile the Sparkplug B protobuf definition
RUN protoc --python_out=. sparkplug_b.proto

# Start the ingestion pipeline daemon
CMD ["python", "ingestion.py"]

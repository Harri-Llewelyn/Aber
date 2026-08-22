FROM python:3.10-slim

# Install system dependencies (protobuf-compiler for compiling .proto files, compatible with protobuf==4.25.3)
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

# Compile the Sparkplug B protobuf definition
RUN protoc --python_out=. sparkplug_b.proto

# Start the ingestion pipeline daemon
CMD ["python", "ingestion.py"]

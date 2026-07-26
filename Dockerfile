FROM python:3.10-slim

# Install system dependencies (protobuf-compiler for compiling .proto files)
RUN apt-get update && apt-get install -y \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Set up application workspace
WORKDIR /app

# Copy and install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy sources into the container
COPY sparkplug_b.proto .
COPY ingestion.py .
COPY logging_config.py .
COPY validate.py .

# Compile the Sparkplug B protobuf definition
RUN protoc --python_out=. sparkplug_b.proto

# Start the ingestion pipeline daemon
CMD ["python", "ingestion.py"]

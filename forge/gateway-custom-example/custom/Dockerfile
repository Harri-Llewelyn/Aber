# PINNED BY DIGEST, and the digest is an OCI image index rather than one architecture's manifest,
# so the same line resolves on an amd64 mini-PC and an arm64 single-board appliance. A tag would
# let the base move under a gateway that rebuilds on every convergence.
#
# To move it: `docker buildx imagetools inspect python:3.12-slim` and take the top-level Digest.
FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

# The standard library alone, so there is no wheel to build on an appliance and no index to reach
# at build time. A real adapter adds what it needs here -- pyserial, pymodbus -- pinned.
WORKDIR /app
COPY adapter.py .

# Not root: this container reaches a serial port and an HTTP endpoint on the appliance's own
# network, and needs nothing else.
RUN useradd --system --no-create-home --uid 10001 adapter
USER adapter

# Unbuffered, so `docker compose logs` shows a line when it happens rather than when the buffer
# fills, which is the difference between a diagnosable adapter and a silent one.
ENV PYTHONUNBUFFERED=1
CMD ["python", "adapter.py"]

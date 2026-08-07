# i3X 1.0 server.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, because `sparkplug_b.proto` lives there and this image has to
# compile it -- the same reason the ingestion and edge-function images take the root:
#   docker build -f i3x/Dockerfile -t ghcr.io/harri-llewelyn/acs-cymru/i3x-service:<tag> .
#
# BUILT SEPARATELY FROM THE INGESTION IMAGE, not FROM it, even though both decode Sparkplug B and
# both would work as a chain. A chained base has to be resolvable at build time, which means either
# building both on one runner or pulling a base that may not be published yet -- the exact problem
# `build-ingestion-chain` exists to work around in release.yml. One more independent image is
# cheaper than one more ordering constraint.
FROM python:3.10-slim

# protobuf-compiler matches the pinned protobuf runtime; without it sparkplug_b_pb2 cannot be
# generated and every DDATA arrives undecodable.
RUN apt-get update && apt-get install -y --no-install-recommends \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY i3x/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY sparkplug_b.proto .
COPY i3x/i3x_service.py i3x/address_space.py i3x/subscriptions.py ./

RUN protoc --python_out=. sparkplug_b.proto

# NON-ROOT. This process listens on a network port and holds a live MQTT subscription; nothing it
# does needs root, and the port is above 1024 so nothing forces it. Numeric because Kubernetes
# `runAsNonRoot` validates the uid, not the name.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin i3x
USER 10001

EXPOSE 8090

# GET /info is the health check by design -- the spec requires it to be unauthenticated precisely so
# it can serve this purpose, which means no credential has to be baked into a probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/v1/info', timeout=4).status==200 else 1)"

CMD ["python", "i3x_service.py"]
